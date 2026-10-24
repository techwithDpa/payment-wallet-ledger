import type pg from 'pg';
import { AppError } from '../errors.js';

export type TransferType = 'TOPUP' | 'PEER' | 'WITHDRAWAL' | 'FEE' | 'REVERSAL';

export interface Account {
  account_id: bigint;
  user_id: bigint | null;
  kind: 'USER_WALLET' | 'SYSTEM';
  balance: bigint;
}

export interface Transfer {
  transfer_id: bigint;
  type: TransferType;
  status: string;
  from_account_id: bigint;
  to_account_id: bigint;
  amount: bigint;
  reverses_transfer_id: bigint | null;
  note: string | null;
  created_by: bigint | null;
  created_at: Date;
}

export interface MoveMoneyInput {
  type: TransferType;
  fromAccountId: bigint;
  toAccountId: bigint;
  amount: bigint;
  note?: string | null;
  createdBy?: bigint | null;
  reversesTransferId?: bigint | null;
}

/**
 * Move `amount` paise from one account to another. Must run inside withTransaction().
 *
 * 1. Lock both account rows, lowest account_id first. Two transfers A->B and B->A
 *    then always queue in the same order, so they can never deadlock.
 * 2. Re-check the balance AFTER the lock. Before the lock, another transfer could
 *    still spend the money; after it, nobody else can touch these rows until we commit.
 * 3. Write the transfer, one debit + one credit line, both balances, an audit row.
 *    All or nothing: if anything throws, withTransaction rolls the whole thing back.
 */
export async function moveMoney(client: pg.PoolClient, input: MoveMoneyInput): Promise<Transfer> {
  const { type, fromAccountId, toAccountId, amount } = input;
  if (fromAccountId === toAccountId) {
    throw new AppError(422, 'SAME_ACCOUNT', 'Cannot transfer to the same wallet');
  }

  // Step 1: lock (ascending ids)
  const { rows: locked } = await client.query<Account>(
    `SELECT account_id, user_id, kind, balance
       FROM accounts
      WHERE account_id = ANY($1::bigint[])
      ORDER BY account_id
        FOR UPDATE`,
    [[fromAccountId, toAccountId]],
  );
  const from = locked.find((a) => a.account_id === fromAccountId);
  const to = locked.find((a) => a.account_id === toAccountId);
  if (!from) throw new AppError(404, 'WALLET_NOT_FOUND', `Wallet ${fromAccountId} not found`);
  if (!to) throw new AppError(404, 'WALLET_NOT_FOUND', `Wallet ${toAccountId} not found`);

  // Step 2: re-check under the lock. System accounts (cash_in) may go negative.
  if (from.kind === 'USER_WALLET' && from.balance < amount) {
    throw new AppError(422, 'INSUFFICIENT_FUNDS', `Balance ${from.balance} paise is less than ${amount} paise`);
  }

  // Step 3: write everything
  const { rows: [transfer] } = await client.query<Transfer>(
    `INSERT INTO transfers (type, status, from_account_id, to_account_id, amount, reverses_transfer_id, note, created_by)
     VALUES ($1, 'COMPLETED', $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [type, fromAccountId, toAccountId, amount, input.reversesTransferId ?? null, input.note ?? null, input.createdBy ?? null],
  );

  await client.query(
    `INSERT INTO ledger_entries (transfer_id, account_id, direction, amount)
     VALUES ($1, $2, 'D', $4), ($1, $3, 'C', $4)`,
    [transfer.transfer_id, fromAccountId, toAccountId, amount],
  );

  // balance = balance - $1 (not "SET balance = <value we computed in JS>"):
  // the database does the arithmetic on the row it has locked.
  await client.query('UPDATE accounts SET balance = balance - $1 WHERE account_id = $2', [amount, fromAccountId]);
  await client.query('UPDATE accounts SET balance = balance + $1 WHERE account_id = $2', [amount, toAccountId]);

  await client.query(
    `INSERT INTO transfer_status_audit (transfer_id, old_status, new_status, changed_by, reason)
     VALUES ($1, NULL, 'COMPLETED', $2, 'created')`,
    [transfer.transfer_id, input.createdBy ?? null],
  );

  return transfer;
}

/** Read one account without locking (for ownership checks). */
export async function getAccount(client: pg.PoolClient, accountId: bigint): Promise<Account | null> {
  const { rows } = await client.query<Account>(
    'SELECT account_id, user_id, kind, balance FROM accounts WHERE account_id = $1',
    [accountId],
  );
  return rows[0] ?? null;
}

/** The wallet must exist, be a user wallet, and belong to `userId`. */
export async function requireOwnWallet(client: pg.PoolClient, accountId: bigint, userId: bigint): Promise<Account> {
  const acct = await getAccount(client, accountId);
  // Same 404 for "doesn't exist" and "not yours": don't reveal other people's wallet ids.
  if (!acct || acct.kind !== 'USER_WALLET' || acct.user_id !== userId) {
    throw new AppError(404, 'WALLET_NOT_FOUND', `Wallet ${accountId} not found`);
  }
  return acct;
}

export async function systemAccountId(client: pg.PoolClient, code: 'cash_in' | 'cash_out' | 'fee_revenue'): Promise<bigint> {
  const { rows } = await client.query<{ account_id: bigint }>(
    'SELECT account_id FROM accounts WHERE system_code = $1',
    [code],
  );
  return rows[0].account_id;
}

/**
 * Undo a COMPLETED transfer with a new REVERSAL transfer in the opposite direction.
 * We never edit or delete the original ledger lines; we add new ones.
 * Must run inside withTransaction().
 */
export async function reverseTransfer(
  client: pg.PoolClient,
  transferId: bigint,
  reason: string | null,
  changedBy: bigint | null,
): Promise<Transfer> {
  // Lock the original so two admins reversing at once queue up; the second sees REVERSED.
  const { rows: [original] } = await client.query<Transfer>(
    'SELECT * FROM transfers WHERE transfer_id = $1 FOR UPDATE',
    [transferId],
  );
  if (!original) throw new AppError(404, 'TRANSFER_NOT_FOUND', `Transfer ${transferId} not found`);
  if (original.type === 'REVERSAL') {
    throw new AppError(409, 'NOT_REVERSIBLE', 'A reversal cannot itself be reversed');
  }
  if (original.status === 'REVERSED') {
    throw new AppError(409, 'ALREADY_REVERSED', `Transfer ${transferId} was already reversed`);
  }
  if (original.status !== 'COMPLETED') {
    throw new AppError(409, 'NOT_REVERSIBLE', `Only COMPLETED transfers can be reversed (status is ${original.status})`);
  }

  // Money goes back: to -> from. If the receiver already spent it, this is 422 INSUFFICIENT_FUNDS.
  const reversal = await moveMoney(client, {
    type: 'REVERSAL',
    fromAccountId: original.to_account_id,
    toAccountId: original.from_account_id,
    amount: original.amount,
    note: reason,
    createdBy: changedBy,
    reversesTransferId: original.transfer_id,
  });

  await client.query(`UPDATE transfers SET status = 'REVERSED' WHERE transfer_id = $1`, [transferId]);
  await client.query(
    `INSERT INTO transfer_status_audit (transfer_id, old_status, new_status, changed_by, reason)
     VALUES ($1, 'COMPLETED', 'REVERSED', $2, $3)`,
    [transferId, changedBy, reason ?? `reversed by transfer ${reversal.transfer_id}`],
  );
  return reversal;
}
