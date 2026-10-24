import type { FastifyInstance } from 'fastify';
import { AppError } from '../errors.js';
import { idempotent, sendStored } from '../services/idempotency.js';
import { createRun, executeRun, getRun } from '../services/reconciliation.js';
import { callerOf, idParams, parse, requireAdmin } from '../validation.js';

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
}
