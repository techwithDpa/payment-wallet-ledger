import type pg from 'pg';
import { pool, withTransaction } from '../db.js';

export type ReconTrigger = 'MANUAL' | 'SCHEDULED';

// Statuses whose money really moved, so they must have exactly one D and one C line.
// (REVERSED transfers keep their original lines; the reversal is a separate transfer.)
const MOVED = `('COMPLETED', 'REVERSED')`;

/** Record a new run as RUNNING and return its id. Committed right away so GET can see it. */
export async function createRun(client: pg.PoolClient, trigger: ReconTrigger, requestedBy: bigint | null): Promise<bigint> {
  const { rows: [run] } = await client.query<{ recon_run_id: bigint }>(
    `INSERT INTO recon_runs (status, trigger, requested_by) VALUES ('RUNNING', $1, $2) RETURNING recon_run_id`,
    [trigger, requestedBy],
  );
  return run.recon_run_id;
}

/**
 * Check the whole ledger and store one issue per ROOT problem.
 *
 * REPEATABLE READ: every query below sees the same frozen snapshot, so a transfer
 * committing halfway through the run can't look like a mismatch.
 * FOR UPDATE NOWAIT on the job_locks row: if another run holds it, give up at once (SKIPPED)
 * instead of waiting, so two runs never overlap.
 */
export async function executeRun(runId: bigint): Promise<void> {
  try {
    await withTransaction('REPEATABLE READ', async (client) => {
      await client.query(`SELECT 1 FROM job_locks WHERE job_name = 'reconciliation' FOR UPDATE NOWAIT`);

      // Check 1: every transfer's lines must match the transfer itself.
      // Moved money: exactly 2 lines, D on from_account and C on to_account, both = amount.
      // HELD / REJECTED: no lines at all.
      await client.query(
        `INSERT INTO recon_issues (recon_run_id, kind, transfer_id, expected, detail)
         SELECT $1, 'TRANSFER_LEDGER_MISMATCH', t.transfer_id, t.amount,
                format('%s transfer %s (%s) expects D %s on account %s and C %s on account %s; ledger has: %s',
                       t.type, t.transfer_id, t.status, t.amount, t.from_account_id, t.amount, t.to_account_id,
                       COALESCE(string_agg(format('%s %s on account %s', e.direction, e.amount, e.account_id), ', '
                                           ORDER BY e.entry_id), 'no lines'))
           FROM transfers t
           LEFT JOIN ledger_entries e ON e.transfer_id = t.transfer_id
          GROUP BY t.transfer_id
         HAVING CASE WHEN t.status IN ${MOVED} THEN NOT (
                  count(e.entry_id) = 2
                  AND count(*) FILTER (WHERE e.direction = 'D' AND e.account_id = t.from_account_id AND e.amount = t.amount) = 1
                  AND count(*) FILTER (WHERE e.direction = 'C' AND e.account_id = t.to_account_id   AND e.amount = t.amount) = 1)
                ELSE count(e.entry_id) > 0 END`,
        [runId],
      );

      // Check 2: every stored balance vs two independent views of it:
      //   L = credits - debits from ledger_entries
      //   T = money in - money out from the transfers table
      // A broken transfer makes L and T disagree, but the stored balance still matches one
      // of them: that's a symptom of check 1, not a new problem. Only a balance that matches
      // NEITHER was itself changed, so only that is reported here.
      await client.query(
        `INSERT INTO recon_issues (recon_run_id, kind, account_id, expected, actual, detail)
         SELECT $1, 'ACCOUNT_BALANCE_MISMATCH', a.account_id, COALESCE(x.t, 0), a.balance,
                format('account %s: stored balance %s, ledger says %s, transfers say %s',
                       a.account_id, a.balance, COALESCE(l.l, 0), COALESCE(x.t, 0))
           FROM accounts a
           LEFT JOIN (SELECT account_id, SUM(CASE direction WHEN 'C' THEN amount ELSE -amount END)::bigint AS l
                        FROM ledger_entries GROUP BY account_id) l ON l.account_id = a.account_id
           LEFT JOIN (SELECT account_id, SUM(delta)::bigint AS t FROM (
                          SELECT to_account_id AS account_id, amount AS delta FROM transfers WHERE status IN ${MOVED}
                          UNION ALL
                          SELECT from_account_id, -amount FROM transfers WHERE status IN ${MOVED}) d
                       GROUP BY account_id) x ON x.account_id = a.account_id
          WHERE a.balance <> COALESCE(l.l, 0) AND a.balance <> COALESCE(x.t, 0)`,
        [runId],
      );

      await client.query(
        `UPDATE recon_runs SET
            status = 'COMPLETED',
            transfers_checked = (SELECT count(*) FROM transfers),
            accounts_checked  = (SELECT count(*) FROM accounts),
            total_debits  = (SELECT COALESCE(SUM(amount), 0) FROM ledger_entries WHERE direction = 'D'),
            total_credits = (SELECT COALESCE(SUM(amount), 0) FROM ledger_entries WHERE direction = 'C'),
            issue_count   = (SELECT count(*) FROM recon_issues WHERE recon_run_id = $1),
            finished_at   = clock_timestamp()
          WHERE recon_run_id = $1`,
        [runId],
      );
    });
  } catch (err) {
    // The transaction was rolled back, so this is a separate plain update.
    const busy = (err as { code?: string }).code === '55P03'; // lock_not_available
    await pool.query(
      `UPDATE recon_runs SET status = $2, error = $3, finished_at = clock_timestamp() WHERE recon_run_id = $1`,
      [runId, busy ? 'SKIPPED' : 'FAILED', busy ? 'another reconciliation run is in progress' : String(err)],
    );
    if (!busy) throw err;
  }
}

/** Create + execute in one go (worker cron and tests). Returns the run id. */
export async function runReconciliation(trigger: ReconTrigger, requestedBy: bigint | null = null): Promise<bigint> {
  const runId = await withTransaction('READ COMMITTED', (client) => createRun(client, trigger, requestedBy));
  await executeRun(runId);
  return runId;
}

export async function getRun(runId: bigint) {
  const { rows: [run] } = await pool.query('SELECT * FROM recon_runs WHERE recon_run_id = $1', [runId]);
  if (!run) return null;
  const { rows: issues } = await pool.query(
    `SELECT recon_issue_id, kind, transfer_id, account_id, expected, actual, detail
       FROM recon_issues WHERE recon_run_id = $1 ORDER BY recon_issue_id`,
    [runId],
  );
  return { ...run, issues };
}
