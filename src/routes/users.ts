import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { idempotent, sendStored } from '../services/idempotency.js';
import type { LlmClient } from '../services/llm.js';
import { askStatement } from '../services/statementQa.js';
import { callerOf, idParams, parse, requireUser } from '../validation.js';

const createUserBody = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(320),
});

const askBody = z.object({
  question: z.string().trim().min(1).max(500),
});

export async function userRoutes(app: FastifyInstance, opts: { llm: LlmClient }) {
  // POST /users  sign up (no X-User-Id needed: you don't have one yet)
  app.post('/users', async (req, reply) => {
    const body = parse(createUserBody, req.body);
    const stored = await idempotent(req, null, async (client) => {
      try {
        const { rows: [user] } = await client.query(
          `INSERT INTO users (name, email) VALUES ($1, $2)
           RETURNING user_id, name, email, kyc_status, created_at`,
          [body.name, body.email],
        );
        return { status: 201, body: user };
      } catch (err) {
        // 23505 = unique_violation: that email is already registered
        if ((err as { code?: string }).code === '23505') {
          throw new AppError(409, 'EMAIL_TAKEN', 'A user with this email already exists');
        }
        throw err;
      }
    });
    return sendStored(reply, stored);
  });

  // POST /users/:id/wallets  open a new INR wallet (yourself, or an admin)
  app.post('/users/:id/wallets', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const caller = callerOf(req);
    if (caller.userId !== id && !caller.isAdmin) {
      throw new AppError(403, 'FORBIDDEN', 'You can only open wallets for yourself');
    }
    const stored = await idempotent(req, caller.userId, async (client) => {
      const { rowCount } = await client.query('SELECT 1 FROM users WHERE user_id = $1', [id]);
      if (rowCount === 0) throw new AppError(404, 'USER_NOT_FOUND', `User ${id} not found`);
      const { rows: [wallet] } = await client.query(
        `INSERT INTO accounts (user_id, kind) VALUES ($1, 'USER_WALLET')
         RETURNING account_id AS wallet_id, user_id, currency, balance, created_at`,
        [id],
      );
      return { status: 201, body: wallet };
    });
    return sendStored(reply, stored);
  });

  // POST /users/:id/statement/ask  {question}  -> plain-language answer about YOUR statement
  app.post('/users/:id/statement/ask', async (req, reply) => {
    const userId = requireUser(req);
    const { id } = parse(idParams, req.params);
    // Only about yourself. Not even admins: this endpoint is the user's own assistant.
    if (id !== userId) throw new AppError(403, 'FORBIDDEN', 'You can only ask about your own statement');
    const { question } = parse(askBody, req.body);
    const stored = await idempotent(req, userId, async (client) => ({
      status: 200,
      body: await askStatement(client, opts.llm, userId, question),
    }));
    return sendStored(reply, stored);
  });
}
