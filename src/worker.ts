import cron from 'node-cron';
import { pool } from './db.js';

// The background worker. In Step 5 the nightly reconciliation job goes here:
//   cron.schedule('30 2 * * *', runReconciliation);
// For now it only proves it can reach the database once a minute.
async function heartbeat() {
  const { rows } = await pool.query('SELECT now() AS ts');
  console.log(`[worker] alive, db time ${rows[0].ts.toISOString()}`);
}

console.log('[worker] started');
await heartbeat();
cron.schedule('* * * * *', () => {
  heartbeat().catch((err) => console.error('[worker] heartbeat failed', err));
});
