import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';

export async function healthRoutes(app: FastifyInstance) {
  // GET /health -> proves the API is up AND can reach Postgres AND migrations ran
  app.get('/health', async () => {
    const { rows } = await pool.query('SELECT count(*) AS jobs FROM job_locks');
    return { ok: true, db: 'up', job_locks: Number(rows[0].jobs) };
  });
}
