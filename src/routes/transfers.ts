import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { AppError } from '../errors.js';
import { idempotent, sendStored } from '../services/idempotency.js';
import { getAccount, moveMoney, requireOwnWallet, reverseTransfer, systemAccountId } from '../services/transfers.js';
import { amountSchema, callerOf, idParams, idSchema, parse, requireAdmin, requireUser } from '../validation.js';

const topupBody = z.object({
  wallet_id: idSchema,
  amount: amountSchema,
  note: z.string().max(500).optional(),
});

const withdrawBody = topupBody;

const reverseBody = z.object({
  reason: z.string().max(500).optional(),
});

const peerBody = z.object({
  from_wallet_id: idSchema,
  to_wallet_id: idSchema,
  amount: amountSchema,
  note: z.string().max(500).optional(),
});

export async function transferRoutes(app: FastifyInstance) {
  // POST /transfers/topup  cash_in -> your wallet
  app.post('/transfers/topup', async (req, reply) => {
    const userId = requireUser(req);
    const body = parse(topupBody, req.body);
    const stored = await idempotent(req, userId, async (client) => {
      await requireOwnWallet(client, body.wallet_id, userId);
      const transfer = await moveMoney(client, {
        type: 'TOPUP',
        fromAccountId: await systemAccountId(client, 'cash_in'),
        toAccountId: body.wallet_id,
        amount: body.amount,
        note: body.note,
        createdBy: userId,
      });
      return { status: 201, body: transfer };
    });
    return sendStored(reply, stored);
  });

  // POST /transfers  your wallet -> someone else's wallet
  app.post('/transfers', async (req, reply) => {
    const userId = requireUser(req);
    const body = parse(peerBody, req.body);
    const stored = await idempotent(req, userId, async (client) => {
      await requireOwnWallet(client, body.from_wallet_id, userId);
      const to = await getAccount(client, body.to_wallet_id);
      if (!to || to.kind !== 'USER_WALLET') {
        throw new AppError(404, 'WALLET_NOT_FOUND', `Wallet ${body.to_wallet_id} not found`);
      }
      const transfer = await moveMoney(client, {
        type: 'PEER',
        fromAccountId: body.from_wallet_id,
        toAccountId: body.to_wallet_id,
        amount: body.amount,
        note: body.note,
        createdBy: userId,
      });
      return { status: 201, body: transfer };
    });
    return sendStored(reply, stored);
  });

  // POST /transfers/withdraw  your wallet -> cash_out (money leaves to your bank)
  app.post('/transfers/withdraw', async (req, reply) => {
    const userId = requireUser(req);
    const body = parse(withdrawBody, req.body);
    const stored = await idempotent(req, userId, async (client) => {
      await requireOwnWallet(client, body.wallet_id, userId);
      const transfer = await moveMoney(client, {
        type: 'WITHDRAWAL',
        fromAccountId: body.wallet_id,
        toAccountId: await systemAccountId(client, 'cash_out'),
        amount: body.amount,
        note: body.note,
        createdBy: userId,
      });
      return { status: 201, body: transfer };
    });
    return sendStored(reply, stored);
  });

  // POST /transfers/:id/reverse  admin only; writes a REVERSAL transfer
  app.post('/transfers/:id/reverse', async (req, reply) => {
    requireAdmin(req);
    const { id } = parse(idParams, req.params);
    const body = parse(reverseBody, req.body);
    const adminId = callerOf(req).userId;
    const stored = await idempotent(req, adminId, async (client) => {
      const reversal = await reverseTransfer(client, id, body.reason ?? null, adminId);
      return { status: 201, body: reversal };
    });
    return sendStored(reply, stored);
  });

  // GET /transfers/:id  the transfer, its ledger lines and its status history
  app.get('/transfers/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const caller = callerOf(req);
    const { rows: [transfer] } = await pool.query(
      `SELECT t.*, fa.user_id AS from_user_id, ta.user_id AS to_user_id
         FROM transfers t
         JOIN accounts fa ON fa.account_id = t.from_account_id
         JOIN accounts ta ON ta.account_id = t.to_account_id
        WHERE t.transfer_id = $1`,
      [id],
    );
    const isParty = transfer && caller.userId !== null &&
      (transfer.from_user_id === caller.userId || transfer.to_user_id === caller.userId);
    if (!transfer || (!isParty && !caller.isAdmin)) {
      throw new AppError(404, 'TRANSFER_NOT_FOUND', `Transfer ${id} not found`);
    }
    const { from_user_id: _f, to_user_id: _t, ...rest } = transfer;
    const { rows: entries } = await pool.query(
      `SELECT entry_id, account_id, direction, amount, created_at
         FROM ledger_entries WHERE transfer_id = $1 ORDER BY entry_id`,
      [id],
    );
    const { rows: statusHistory } = await pool.query(
      `SELECT old_status, new_status, changed_by, reason, created_at
         FROM transfer_status_audit WHERE transfer_id = $1 ORDER BY audit_id`,
      [id],
    );
    return { ...rest, entries, status_history: statusHistory };
  });
}
