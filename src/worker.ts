import cron from 'node-cron';
import { getRun, runReconciliation } from './services/reconciliation.js';

// The background worker: nightly reconciliation at 02:30.
// Overlapping runs are impossible: each run takes the job_locks row with FOR UPDATE NOWAIT,
// so a second one (e.g. a manual run from the API at the same moment) ends as SKIPPED.
async function nightlyReconciliation() {
  const runId = await runReconciliation('SCHEDULED');
  const run = await getRun(runId);
  console.log(`[worker] reconciliation run ${runId}: ${run?.status}, ${run?.issue_count ?? 0} issue(s)`);
}

console.log('[worker] started; reconciliation scheduled daily at 02:30');
cron.schedule('30 2 * * *', () => {
  nightlyReconciliation().catch((err) => console.error('[worker] reconciliation failed', err));
});
