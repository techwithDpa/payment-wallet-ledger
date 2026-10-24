import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';

// These tests talk to Postgres directly: they prove the DATABASE refuses bad
// money states, even if a bug in our TypeScript tried to write one.

afterAll(async () => {
  await pool.end();
});

async function newWallet() {
  const email = `schema-${crypto.randomUUID()}@test.local`;
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (name, email) VALUES ('Schema Test', $1) RETURNING user_id`, [email]);
  const { rows: [acct] } = await pool.query(
    `INSERT INTO accounts (user_id, kind) VALUES ($1, 'USER_WALLET') RETURNING account_id, balance`, [user.user_id]);
  return { userId: user.user_id as bigint, accountId: acct.account_id as bigint, balance: acct.balance as bigint };
}

describe('schema', () => {
  it('seeds the three system accounts', async () => {
    const { rows } = await pool.query(
      `SELECT system_code FROM accounts WHERE kind = 'SYSTEM' ORDER BY system_code`);
    expect(rows.map((r) => r.system_code)).toEqual(['cash_in', 'cash_out', 'fee_revenue']);
  });

  it('a new wallet starts at 0 paise, returned as bigint', async () => {
    const w = await newWallet();
    expect(w.balance).toBe(0n);
  });

  it('a wallet balance can never go negative', async () => {
    const w = await newWallet();
    await expect(
      pool.query('UPDATE accounts SET balance = -1 WHERE account_id = $1', [w.accountId]),
    ).rejects.toThrow(/accounts_wallet_not_negative/);
  });

  it('a wallet must have an owner, a system account must not', async () => {
    await expect(pool.query(`INSERT INTO accounts (kind) VALUES ('USER_WALLET')`))
      .rejects.toThrow(/accounts_owner_matches_kind/);
  });

  it('only INR is allowed', async () => {
    const w = await newWallet();
    await expect(
      pool.query(`INSERT INTO accounts (user_id, kind, currency) VALUES ($1, 'USER_WALLET', 'USD')`, [w.userId]),
    ).rejects.toThrow(/currency/);
  });

  it('ledger_entries is append-only', async () => {
    const w = await newWallet();
    // Done inside a transaction we roll back, so this one-sided test entry
    // never stays in the ledger (it would break "debits = credits").
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [cashIn] } = await client.query(`SELECT account_id FROM accounts WHERE system_code = 'cash_in'`);
      const { rows: [t] } = await client.query(
        `INSERT INTO transfers (type, status, from_account_id, to_account_id, amount)
         VALUES ('TOPUP', 'COMPLETED', $1, $2, 100) RETURNING transfer_id`, [cashIn.account_id, w.accountId]);
      const { rows: [e] } = await client.query(
        `INSERT INTO ledger_entries (transfer_id, account_id, direction, amount)
         VALUES ($1, $2, 'C', 100) RETURNING entry_id`, [t.transfer_id, w.accountId]);

      // A failed statement aborts the transaction, so each attempt gets its own savepoint.
      await client.query('SAVEPOINT s');
      await expect(client.query('UPDATE ledger_entries SET amount = 1 WHERE entry_id = $1', [e.entry_id]))
        .rejects.toThrow(/append-only/);
      await client.query('ROLLBACK TO SAVEPOINT s');
      await expect(client.query('DELETE FROM ledger_entries WHERE entry_id = $1', [e.entry_id]))
        .rejects.toThrow(/append-only/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('amounts must be positive', async () => {
    const w = await newWallet();
    const { rows: [cashIn] } = await pool.query(`SELECT account_id FROM accounts WHERE system_code = 'cash_in'`);
    await expect(pool.query(
      `INSERT INTO transfers (type, status, from_account_id, to_account_id, amount)
       VALUES ('TOPUP', 'COMPLETED', $1, $2, 0)`, [cashIn.account_id, w.accountId]),
    ).rejects.toThrow(/amount/);
  });

  it('the same idempotency key cannot be stored twice for the same caller', async () => {
    const key = crypto.randomUUID();
    const hash = 'a'.repeat(64);
    await pool.query(
      `INSERT INTO idempotency_keys (user_id, key, request_hash, status) VALUES (NULL, $1, $2, 'IN_PROGRESS')`, [key, hash]);
    await expect(pool.query(
      `INSERT INTO idempotency_keys (user_id, key, request_hash, status) VALUES (NULL, $1, $2, 'IN_PROGRESS')`, [key, hash]),
    ).rejects.toThrow(/idempotency_keys_user_key/);
  });
});
