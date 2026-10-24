import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { AppError } from '../errors.js';
import { idempotent, sendStored } from '../services/idempotency.js';
import { createRun, executeRun, getRun } from '../services/reconciliation.js';
import { flagsFor } from '../services/risk.js';
import { decideHeld } from '../services/transfers.js';
import { callerOf, idParams, parse, requireAdmin } from '../validation.js';

const decisionBody = z.object({
  // "reverse" a HELD transfer = reject it: no money moved, so nothing to undo.
  decision: z.enum(['release', 'reverse']),
  reason: z.string().max(500).optional(),
});

const queueQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function adminRoutes(app: FastifyInstance) {
  // POST /admin/reconciliation/run  -> 202 right away; the check runs in the background
  app.post('/admin/reconciliation/run', async (req, reply) => {
    requireAdmin(req);
    const adminId = callerOf(req).userId;
    const stored = await idempotent(req, adminId, async (client) => {
      const runId = await createRun(client, 'MANUAL', adminId);
      return {
        status: 202,
        body: { recon_run_id: runId, status: 'RUNNING', status_url: `/admin/reconciliation/runs/${runId}` },
      };
    });
    // Start only after the run row is committed, and only the first time (not on a replay).
    if (!stored.replayed && stored.status === 202) {
      const runId = BigInt((stored.body as { recon_run_id: string }).recon_run_id);
      executeRun(runId).catch((err) => req.log.error({ err, runId: runId.toString() }, 'reconciliation failed'));
    }
    return sendStored(reply, stored);
  });

  // GET /admin/reconciliation/runs/:id  -> run summary + issues
  app.get('/admin/reconciliation/runs/:id', async (req) => {
    requireAdmin(req);
    const { id } = parse(idParams, req.params);
    const run = await getRun(id);
    if (!run) throw new AppError(404, 'RUN_NOT_FOUND', `Reconciliation run ${id} not found`);
    return run;
  });

  // GET /admin/risk/queue  -> HELD transfers waiting for a decision, oldest first
  app.get('/admin/risk/queue', async (req) => {
    requireAdmin(req);
    const { limit, offset } = parse(queueQuery, req.query);
    const { rows } = await pool.query(
      `SELECT * FROM transfers WHERE status = 'HELD' ORDER BY created_at, transfer_id LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    const items = [];
    for (const t of rows) items.push({ ...t, risk_flags: await flagsFor(pool, t.transfer_id) });
    return { limit, offset, items };
  });

  // POST /admin/risk/:id/decision  {decision: "release" | "reverse", reason?}
  app.post('/admin/risk/:id/decision', async (req, reply) => {
    requireAdmin(req);
    const { id } = parse(idParams, req.params);
    const body = parse(decisionBody, req.body);
    const adminId = callerOf(req).userId;
    const stored = await idempotent(req, adminId, async (client) => {
      const transfer = await decideHeld(
        client, id, body.decision === 'release' ? 'release' : 'reject', adminId, body.reason ?? null);
      return { status: 200, body: { ...transfer, risk_flags: await flagsFor(client, id) } };
    });
    return sendStored(reply, stored);
  });
}
