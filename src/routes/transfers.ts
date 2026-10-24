import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTransaction } from '../db.js';
import { AppError } from '../errors.js';
import { getAccount, moveMoney, requireOwnWallet, systemAccountId } from '../services/transfers.js';
import { amountSchema, idSchema, parse, requireUser } from '../validation.js';

const topupBody = z.object({
  wallet_id: idSchema,
  amount: amountSchema,
  note: z.string().max(500).optional(),
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
    const transfer = await withTransaction('READ COMMITTED', async (client) => {
      await requireOwnWallet(client, body.wallet_id, userId);
      return moveMoney(client, {
        type: 'TOPUP',
        fromAccountId: await systemAccountId(client, 'cash_in'),
        toAccountId: body.wallet_id,
        amount: body.amount,
        note: body.note,
        createdBy: userId,
      });
    });
    return reply.status(201).send(transfer);
  });

  // POST /transfers  your wallet -> someone else's wallet
  app.post('/transfers', async (req, reply) => {
    const userId = requireUser(req);
    const body = parse(peerBody, req.body);
    const transfer = await withTransaction('READ COMMITTED', async (client) => {
      await requireOwnWallet(client, body.from_wallet_id, userId);
      const to = await getAccount(client, body.to_wallet_id);
      if (!to || to.kind !== 'USER_WALLET') {
        throw new AppError(404, 'WALLET_NOT_FOUND', `Wallet ${body.to_wallet_id} not found`);
      }
      return moveMoney(client, {
        type: 'PEER',
        fromAccountId: body.from_wallet_id,
        toAccountId: body.to_wallet_id,
        amount: body.amount,
        note: body.note,
        createdBy: userId,
      });
    });
    return reply.status(201).send(transfer);
  });
}
