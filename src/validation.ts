import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from './errors.js';

// An id in a URL or body: digits only, turned into a bigint.
export const idSchema = z
  .union([z.string().regex(/^[1-9]\d{0,17}$/), z.number().int().positive().safe()])
  .transform((v) => BigInt(v));

// Money in paise. Accepts 50000 or "50000"; never 500.00, never "5e4".
// Max 18 digits so it always fits in a Postgres BIGINT.
export const amountSchema = z
  .union([z.string().regex(/^[1-9]\d{0,17}$/), z.number().int().positive().safe()], {
    errorMap: () => ({ message: 'amount must be a positive whole number of paise' }),
  })
  .transform((v) => BigInt(v));

// Validate or throw 400 VALIDATION_ERROR with a readable message.
export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.output<T> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const msg = result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    throw new AppError(400, 'VALIDATION_ERROR', msg);
  }
  return result.data;
}

// Auth is a header for this project (see README assumptions):
//   X-User-Id: 42      -> who is calling
//   X-Admin: true      -> admin endpoints
export function callerOf(req: FastifyRequest): { userId: bigint | null; isAdmin: boolean } {
  const raw = req.headers['x-user-id'];
  const userId = typeof raw === 'string' && /^[1-9]\d{0,17}$/.test(raw) ? BigInt(raw) : null;
  return { userId, isAdmin: req.headers['x-admin'] === 'true' };
}

export function requireAdmin(req: FastifyRequest): void {
  if (!callerOf(req).isAdmin) throw new AppError(403, 'FORBIDDEN', 'Admin only (X-Admin: true)');
}

export const idParams = z.object({ id: idSchema });

export function requireUser(req: FastifyRequest): bigint {
  const { userId } = callerOf(req);
  if (userId === null) throw new AppError(401, 'UNAUTHENTICATED', 'X-User-Id header is required');
  return userId;
}
