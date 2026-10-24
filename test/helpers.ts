import { pool } from '../src/db.js';

// Test data straight in the database, so each test gets its own fresh user + wallet.
export async function createUserWithWallet(): Promise<{ userId: bigint; walletId: bigint }> {
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (name, email) VALUES ('Test User', $1) RETURNING user_id`,
    [`user-${crypto.randomUUID()}@test.local`],
  );
  const { rows: [wallet] } = await pool.query(
    `INSERT INTO accounts (user_id, kind) VALUES ($1, 'USER_WALLET') RETURNING account_id`,
    [user.user_id],
  );
  return { userId: user.user_id, walletId: wallet.account_id };
}

export async function balanceOf(accountId: bigint): Promise<bigint> {
  const { rows } = await pool.query('SELECT balance FROM accounts WHERE account_id = $1', [accountId]);
  return rows[0].balance;
}

// What the ledger says the balance should be: credits minus debits.
export async function ledgerBalanceOf(accountId: bigint): Promise<bigint> {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(CASE direction WHEN 'C' THEN amount ELSE -amount END), 0)::bigint AS b
       FROM ledger_entries WHERE account_id = $1`,
    [accountId],
  );
  return rows[0].b;
}

// Every transfer's debit lines must equal its credit lines. Returns the broken ones.
export async function unbalancedTransfers(): Promise<bigint[]> {
  const { rows } = await pool.query(
    `SELECT transfer_id FROM ledger_entries
      GROUP BY transfer_id
     HAVING SUM(amount) FILTER (WHERE direction = 'D') IS DISTINCT FROM SUM(amount) FILTER (WHERE direction = 'C')`,
  );
  return rows.map((r) => r.transfer_id);
}

export function headers(userId: bigint, extra: Record<string, string> = {}) {
  return { 'x-user-id': userId.toString(), ...extra };
}
