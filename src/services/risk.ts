import type pg from 'pg';

export interface RiskHit {
  rule_code: 'VELOCITY' | 'AMOUNT_SPIKE' | 'NEW_PAYEE_LARGE';
  action: 'HOLD' | 'FLAG';
  detail: string;
}

interface RiskRule {
  code: RiskHit['rule_code'];
  action: RiskHit['action'];
  threshold: bigint;
  window_minutes: number | null;
}

/**
 * Check a PEER transfer against the enabled rules. Called by moveMoney() AFTER the sender's
 * row is locked, so parallel transfers from one wallet are counted one at a time.
 * Comparisons happen in SQL so the 30-day average never becomes a JS float.
 */
export async function assessRisk(
  client: pg.PoolClient,
  fromAccountId: bigint,
  toAccountId: bigint,
  amount: bigint,
): Promise<RiskHit[]> {
  const { rows: rules } = await client.query<RiskRule>(
    'SELECT code, action, threshold, window_minutes FROM risk_rules WHERE enabled ORDER BY risk_rule_id',
  );
  const hits: RiskHit[] = [];

  for (const rule of rules) {
    if (rule.code === 'VELOCITY') {
      // Earlier outgoing transfers in the window (HELD ones count too: they were attempts).
      const { rows: [r] } = await client.query<{ n: bigint }>(
        `SELECT count(*) AS n FROM transfers
          WHERE from_account_id = $1 AND type = 'PEER' AND status <> 'REJECTED'
            AND created_at > now() - make_interval(mins => $2)`,
        [fromAccountId, rule.window_minutes],
      );
      if (r.n + 1n > rule.threshold) {
        hits.push({ rule_code: rule.code, action: rule.action,
          detail: `transfer #${r.n + 1n} in ${rule.window_minutes} min (limit ${rule.threshold})` });
      }
    }

    if (rule.code === 'AMOUNT_SPIKE') {
      const { rows: [r] } = await client.query<{ n: bigint; avg: bigint | null; spike: boolean | null }>(
        `SELECT count(*) AS n,
                round(avg(amount))::bigint AS avg,
                $2::bigint > $3::bigint * avg(amount) AS spike
           FROM transfers
          WHERE from_account_id = $1 AND type = 'PEER' AND status IN ('COMPLETED', 'REVERSED')
            AND created_at > now() - make_interval(mins => $4)`,
        [fromAccountId, amount, rule.threshold, rule.window_minutes],
      );
      // No history in the window: nothing to compare against, rule skipped.
      if (r.n > 0n && r.spike) {
        hits.push({ rule_code: rule.code, action: rule.action,
          detail: `${amount} paise is more than ${rule.threshold}x the 30-day average of ${r.avg} paise` });
      }
    }

    if (rule.code === 'NEW_PAYEE_LARGE' && amount > rule.threshold) {
      const { rowCount } = await client.query(
        `SELECT 1 FROM transfers
          WHERE from_account_id = $1 AND to_account_id = $2 AND status <> 'REJECTED' LIMIT 1`,
        [fromAccountId, toAccountId],
      );
      if (rowCount === 0) {
        hits.push({ rule_code: rule.code, action: rule.action,
          detail: `first transfer to wallet ${toAccountId}, ${amount} paise is above ${rule.threshold}` });
      }
    }
  }
  return hits;
}

export async function saveFlags(client: pg.PoolClient, transferId: bigint, hits: RiskHit[]): Promise<void> {
  for (const h of hits) {
    await client.query(
      'INSERT INTO risk_flags (transfer_id, rule_code, action, detail) VALUES ($1, $2, $3, $4)',
      [transferId, h.rule_code, h.action, h.detail],
    );
  }
}

export async function flagsFor(db: pg.PoolClient | pg.Pool, transferId: bigint) {
  const { rows } = await db.query(
    `SELECT rule_code, action, detail, resolution, resolved_by, resolved_at, created_at
       FROM risk_flags WHERE transfer_id = $1 ORDER BY risk_flag_id`,
    [transferId],
  );
  return rows;
}
