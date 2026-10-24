import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool, withTransaction } from '../src/db.js';

const app = buildApp();

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('skeleton', () => {
  it('GET /health reports the API and database are up', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, db: 'up', job_locks: 1 });
  });

  it('unknown routes use the standard error shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NOT_FOUND', request_id: expect.any(String) });
  });

  it('withTransaction commits on success', async () => {
    const n = await withTransaction('READ COMMITTED', async (c) => {
      const { rows } = await c.query('SELECT 1::bigint AS one');
      return rows[0].one;
    });
    expect(n).toBe(1n); // BIGINT comes back as a JS bigint, not a string or float
  });

  it('withTransaction rolls back when something throws', async () => {
    await expect(
      withTransaction('READ COMMITTED', async (c) => {
        await c.query(`INSERT INTO job_locks (job_name) VALUES ('temp_job')`);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const { rows } = await pool.query(`SELECT count(*) AS n FROM job_locks WHERE job_name = 'temp_job'`);
    expect(rows[0].n).toBe(0n); // the insert was undone
  });
});
