import pg from 'pg';

// Postgres type 20 = BIGINT. By default `pg` returns it as a string ("50000")
// because a JS number can't hold every 64-bit integer exactly.
// We turn it into a JS bigint (50000n), never a float. Money stays exact.
pg.types.setTypeParser(20, (value) => BigInt(value));

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://wallet:wallet@localhost:5432/wallet',
  max: 20, // enough connections for the 100-request stampede test to really overlap
});

export type IsolationLevel = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

/**
 * Run `fn` inside ONE database transaction on ONE connection.
 * - every query inside fn must use the `client` passed in (not `pool.query`)
 * - if fn throws, everything is rolled back: no half-done transfers
 */
export async function withTransaction<T>(
  level: IsolationLevel,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${level}`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release(); // give the connection back to the pool, always
  }
}
