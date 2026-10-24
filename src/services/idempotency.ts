import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { pool, withTransaction } from '../db.js';
import { AppError } from '../errors.js';
import { toJson } from '../json.js';

export interface StoredResponse {
  status: number;
  body: unknown;
  replayed: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `handler` at most once per (caller, Idempotency-Key).
 *
 * New key  -> claim it (IN_PROGRESS) and run the handler in the SAME transaction,
 *             then save the response as COMPLETED and commit. Key + money commit together.
 * Seen key -> different request body: 422. Still running: 409. Done: replay the saved response.
 *
 * Two parallel requests with the same key: the second INSERT waits on the unique index
 * until the first commits, then sees the conflict and replays. Money moves once.
 */
export async function idempotent(
  req: FastifyRequest,
  scopeUserId: bigint | null,
  handler: (client: pg.PoolClient) => Promise<{ status: number; body: unknown }>,
): Promise<StoredResponse> {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || !UUID_RE.test(key)) {
    throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header must be a UUID');
  }
  // Fingerprint of "what was asked", so the same key with a different amount is caught.
  const requestHash = createHash('sha256').update(`${req.method} ${req.url}\n${toJson(req.body ?? null)}`).digest('hex');

  const fresh = await withTransaction('READ COMMITTED', async (client) => {
    const claim = await client.query<{ idempotency_key_id: bigint }>(
      `INSERT INTO idempotency_keys (user_id, key, request_hash, status)
       VALUES ($1, $2::uuid, $3, 'IN_PROGRESS')
       ON CONFLICT ON CONSTRAINT idempotency_keys_user_key DO NOTHING
       RETURNING idempotency_key_id`,
      [scopeUserId, key, requestHash],
    );
    if (claim.rowCount === 0) return null; // seen before: nothing written, handled below

    // If the business logic fails (e.g. INSUFFICIENT_FUNDS) we undo only the money part,
    // keep the key row, and save the error so a retry gets the same answer.
    await client.query('SAVEPOINT money');
    let result: { status: number; body: unknown };
    try {
      result = await handler(client);
    } catch (err) {
      if (!(err instanceof AppError)) throw err; // unexpected crash: roll back everything, key included
      await client.query('ROLLBACK TO SAVEPOINT money');
      result = { status: err.statusCode, body: { code: err.code, message: err.message, request_id: req.id } };
    }

    // We reply with what Postgres stored (RETURNING), so the first answer and every
    // replay are byte-for-byte the same JSON.
    const { rows: [saved] } = await client.query<{ response_code: number; response_body: unknown }>(
      `UPDATE idempotency_keys
          SET status = 'COMPLETED', response_code = $2, response_body = $3::jsonb, updated_at = now()
        WHERE idempotency_key_id = $1
        RETURNING response_code, response_body`,
      [claim.rows[0].idempotency_key_id, result.status, toJson(result.body)],
    );
    return { status: saved.response_code, body: saved.response_body, replayed: false };
  });
  if (fresh) return fresh;

  // The transaction is over; this is a plain read of the committed key row.
  const { rows: [row] } = await pool.query<{
    request_hash: string; status: string; response_code: number; response_body: unknown;
  }>(
    `SELECT request_hash, status, response_code, response_body
       FROM idempotency_keys
      WHERE user_id IS NOT DISTINCT FROM $1 AND key = $2::uuid`,
    [scopeUserId, key],
  );
  if (!row || row.status === 'IN_PROGRESS') {
    throw new AppError(409, 'REQUEST_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed');
  }
  if (row.request_hash !== requestHash) {
    throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
  }
  return { status: row.response_code, body: row.response_body, replayed: true };
}

export function sendStored(reply: FastifyReply, stored: StoredResponse) {
  if (stored.replayed) reply.header('idempotent-replayed', 'true');
  return reply.status(stored.status).send(stored.body);
}
