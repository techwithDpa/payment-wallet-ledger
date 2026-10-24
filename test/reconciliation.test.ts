import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { getRun, runReconciliation } from '../src/services/reconciliation.js';

const app = buildApp();
const admin = { 'x-admin': 'true' };
const TAG = `recon-test-${crypto.randomUUID()}`;
const TOPUP_PAISE = 100000n;

let cashIn: bigint;
let userIds: bigint[] = [];
let walletIds: bigint[] = [];
const runIds: bigint[] = [];

// Corrupting the ledger needs to get past the append-only trigger. Only a superuser can:
// session_replication_role = replica switches triggers off for THIS connection only.
async function asSuperuser<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('SET session_replication_role = replica');
    return await fn(c);
  } finally {
    await c.query('SET session_replication_role = DEFAULT');
    c.release();
  }
}

beforeAll(async () => {
  // 10,000 transfers in one SQL statement (calling moveMoney 10k times would take far longer).
  // It keeps the same invariants: one D + one C per transfer, balances updated by the same amounts.
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    ({ rows: [{ account_id: cashIn }] } = await c.query(`SELECT account_id FROM accounts WHERE system_code = 'cash_in'`));
    const users = await c.query(
      `INSERT INTO users (name, email) SELECT 'Recon ' || g, $1 || '-' || g || '@test.local'
         FROM generate_series(1, 100) g RETURNING user_id`, [TAG]);
    userIds = users.rows.map((r) => r.user_id);
    const wallets = await c.query(
      `INSERT INTO accounts (user_id, kind) SELECT unnest($1::bigint[]), 'USER_WALLET' RETURNING account_id`, [userIds]);
    walletIds = wallets.rows.map((r) => r.account_id).sort((a, b) => (a < b ? -1 : 1));

    // 5,000 top-ups of ₹1,000 (50 per wallet), then 5,000 small peer transfers (≤ ₹10 each)
    await c.query(
      `WITH w AS (SELECT $2::bigint[] AS ids),
       t AS (
         INSERT INTO transfers (type, status, from_account_id, to_account_id, amount, note)
         SELECT 'TOPUP', 'COMPLETED', $1, ids[1 + g % 100], $4, $3 FROM generate_series(0, 4999) g, w
         UNION ALL
         SELECT 'PEER', 'COMPLETED', ids[1 + g % 100], ids[1 + (g + 1) % 100], 1 + (g * 7919) % 1000, $3
           FROM generate_series(0, 4999) g, w
         RETURNING transfer_id, from_account_id, to_account_id, amount
       ),
       e AS (
         INSERT INTO ledger_entries (transfer_id, account_id, direction, amount)
         SELECT transfer_id, from_account_id, 'D', amount FROM t
         UNION ALL
         SELECT transfer_id, to_account_id, 'C', amount FROM t
       ),
       d AS (SELECT to_account_id AS account_id, amount AS delta FROM t
             UNION ALL SELECT from_account_id, -amount FROM t)
       UPDATE accounts a SET balance = a.balance + s.delta
         FROM (SELECT account_id, SUM(delta)::bigint AS delta FROM d GROUP BY account_id) s
        WHERE a.account_id = s.account_id`,
      [cashIn, walletIds, TAG, TOPUP_PAISE],
    );
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}, 60_000);

afterAll(async () => {
  // Remove everything this file created, so the shared test database stays clean.
  await asSuperuser(async (c) => {
    const { rows } = await c.query('SELECT transfer_id FROM transfers WHERE note = $1', [TAG]);
    const transferIds = rows.map((r) => r.transfer_id);
    await c.query('DELETE FROM recon_issues WHERE recon_run_id = ANY($1)', [runIds]);
    await c.query('DELETE FROM recon_runs WHERE recon_run_id = ANY($1)', [runIds]);
    await c.query('DELETE FROM ledger_entries WHERE transfer_id = ANY($1)', [transferIds]);
    await c.query('DELETE FROM transfers WHERE transfer_id = ANY($1)', [transferIds]);
    await c.query('UPDATE accounts SET balance = balance + $1 WHERE account_id = $2', [5000n * TOPUP_PAISE, cashIn]);
    await c.query('DELETE FROM accounts WHERE account_id = ANY($1)', [walletIds]);
    await c.query('DELETE FROM users WHERE user_id = ANY($1)', [userIds]);
  });
  await app.close();
  await pool.end();
});

async function reconcile() {
  const id = await runReconciliation('MANUAL');
  runIds.push(id);
  return (await getRun(id))!;
}

describe('reconciliation', () => {
  it('POST /admin/reconciliation/run -> 202, then the run completes clean', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/reconciliation/run',
      headers: { ...admin, 'idempotency-key': crypto.randomUUID() },
    });
    expect(res.statusCode).toBe(202);
    const runId: string = res.json().recon_run_id;
    runIds.push(BigInt(runId));

    // The check runs in the background: poll until it finishes.
    let run;
    for (let i = 0; i < 100; i++) {
      run = (await app.inject({ method: 'GET', url: `/admin/reconciliation/runs/${runId}`, headers: admin })).json();
      if (run.status !== 'RUNNING') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(run).toMatchObject({ status: 'COMPLETED', issue_count: 0, issues: [] });
    expect(BigInt(run.transfers_checked)).toBeGreaterThanOrEqual(10000n);
    expect(run.total_debits).toBe(run.total_credits);
  });

  it('10k transfers, 3 corruptions -> exactly 3 root problems, then clean after repair', async () => {
    const { rows: peers } = await pool.query(
      `SELECT transfer_id, to_account_id, amount FROM transfers
        WHERE note = $1 AND type = 'PEER' ORDER BY transfer_id LIMIT 2`, [TAG]);
    const [x1, x2] = peers;
    const w3 = walletIds[50];

    // 1. corrupt one amount   2. delete one credit line   3. change one stored balance
    const deleted = await asSuperuser(async (c) => {
      await c.query(`UPDATE ledger_entries SET amount = amount + 1 WHERE transfer_id = $1 AND direction = 'D'`, [x1.transfer_id]);
      const { rows: [credit] } = await c.query(
        `DELETE FROM ledger_entries WHERE transfer_id = $1 AND direction = 'C' RETURNING transfer_id, account_id, amount`,
        [x2.transfer_id]);
      await c.query('UPDATE accounts SET balance = balance + 500 WHERE account_id = $1', [w3]);
      return credit;
    });

    try {
      const run = await reconcile();
      expect(run.status).toBe('COMPLETED');
      expect(run.issue_count).toBe(3);
      const found = run.issues.map((i: { kind: string; transfer_id: bigint | null; account_id: bigint | null }) =>
        [i.kind, i.transfer_id ?? i.account_id]);
      expect(found).toEqual(expect.arrayContaining([
        ['TRANSFER_LEDGER_MISMATCH', x1.transfer_id],
        ['TRANSFER_LEDGER_MISMATCH', x2.transfer_id],
        ['ACCOUNT_BALANCE_MISMATCH', w3],
      ]));
      const balanceIssue = run.issues.find((i: { kind: string }) => i.kind === 'ACCOUNT_BALANCE_MISMATCH');
      expect(balanceIssue.actual - balanceIssue.expected).toBe(500n);
      expect(run.total_credits).not.toBe(run.total_debits); // the missing credit shows in the totals too
    } finally {
      // Repair, so the rest of the suite sees a clean ledger.
      await asSuperuser(async (c) => {
        await c.query(`UPDATE ledger_entries SET amount = amount - 1 WHERE transfer_id = $1 AND direction = 'D'`, [x1.transfer_id]);
        await c.query(`INSERT INTO ledger_entries (transfer_id, account_id, direction, amount) VALUES ($1, $2, 'C', $3)`,
          [deleted.transfer_id, deleted.account_id, deleted.amount]);
        await c.query('UPDATE accounts SET balance = balance - 500 WHERE account_id = $1', [w3]);
      });
    }

    const after = await reconcile();
    expect(after.issue_count).toBe(0);
  }, 60_000);

  it('a second run while one is in progress is SKIPPED, not run twice', async () => {
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM job_locks WHERE job_name = 'reconciliation' FOR UPDATE`); // pretend a run is going
      const run = await reconcile();
      expect(run.status).toBe('SKIPPED');
      expect(run.error).toMatch(/in progress/);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });

  it('admin only, and unknown run -> 404', async () => {
    const forbidden = await app.inject({
      method: 'POST', url: '/admin/reconciliation/run', headers: { 'x-user-id': '1', 'idempotency-key': crypto.randomUUID() },
    });
    expect(forbidden.statusCode).toBe(403);
    const missing = await app.inject({ method: 'GET', url: '/admin/reconciliation/runs/999999999', headers: admin });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('RUN_NOT_FOUND');
  });
});
