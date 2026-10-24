import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { AppError } from '../errors.js';
import { callerOf, idParams, parse } from '../validation.js';

const statementQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

// Read-only routes: no transaction needed, a single SELECT sees one consistent snapshot.
async function loadVisibleWallet(req: FastifyRequest, walletId: bigint) {
  const { rows: [w] } = await pool.query(
    `SELECT account_id AS wallet_id, user_id, currency, balance
       FROM accounts WHERE account_id = $1 AND kind = 'USER_WALLET'`,
    [walletId],
  );
  const caller = callerOf(req);
  if (!w || (w.user_id !== caller.userId && !caller.isAdmin)) {
    throw new AppError(404, 'WALLET_NOT_FOUND', `Wallet ${walletId} not found`);
  }
  return w;
}

export async function walletRoutes(app: FastifyInstance) {
  // GET /wallets/:id/balance
  app.get('/wallets/:id/balance', async (req) => {
    const { id } = parse(idParams, req.params);
    return loadVisibleWallet(req, id);
  });

  // GET /wallets/:id/statement?limit=20&offset=0  newest first
  app.get('/wallets/:id/statement', async (req) => {
    const { id } = parse(idParams, req.params);
    const { limit, offset } = parse(statementQuery, req.query);
    const wallet = await loadVisibleWallet(req, id);
    const { rows: entries } = await pool.query(
      `SELECT e.entry_id, e.transfer_id, t.type, t.status, e.direction, e.amount, t.note, e.created_at
         FROM ledger_entries e
         JOIN transfers t ON t.transfer_id = e.transfer_id
        WHERE e.account_id = $1
        ORDER BY e.created_at DESC, e.entry_id DESC
        LIMIT $2 OFFSET $3`,
      [id, limit, offset],
    );
    return { wallet_id: wallet.wallet_id, balance: wallet.balance, currency: wallet.currency, limit, offset, entries };
  });
}
