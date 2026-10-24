import type pg from 'pg';
import { AppError } from '../errors.js';
import { assessRisk, saveFlags } from './risk.js';

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
  riskCheck?: boolean; // run the fraud rules (PEER transfers from POST /transfers)
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

  // Steps 1 + 2: lock (ascending ids) and re-check the balance under the lock
  await lockAccounts(client, fromAccountId, toAccountId, amount);

  // Fraud rules, still under the lock: a HOLD hit parks the transfer for an admin.
  const hits = input.riskCheck ? await assessRisk(client, fromAccountId, toAccountId, amount) : [];
  const status = hits.some((h) => h.action === 'HOLD') ? 'HELD' : 'COMPLETED';

  // Step 3: write everything
  const { rows: [transfer] } = await client.query<Transfer>(
    `INSERT INTO transfers (type, status, from_account_id, to_account_id, amount, reverses_transfer_id, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [type, status, fromAccountId, toAccountId, amount, input.reversesTransferId ?? null, input.note ?? null, input.createdBy ?? null],
  );
  // HELD: no ledger lines and no balance change until an admin releases it.
  if (status === 'COMPLETED') await postEntries(client, transfer);
  await saveFlags(client, transfer.transfer_id, hits);

  await client.query(
    `INSERT INTO transfer_status_audit (transfer_id, old_status, new_status, changed_by, reason)
     VALUES ($1, NULL, $2, $3, $4)`,
    [transfer.transfer_id, status, input.createdBy ?? null, status === 'HELD' ? 'held by risk rules' : 'created'],
  );

  return transfer;
}

/** Lock both accounts lowest id first; 404 if missing; 422 if the sender can't cover `amount`. */
async function lockAccounts(client: pg.PoolClient, fromAccountId: bigint, toAccountId: bigint, amount: bigint) {
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

  // System accounts (cash_in) may go negative; wallets may not.
  if (from.kind === 'USER_WALLET' && from.balance < amount) {
    throw new AppError(422, 'INSUFFICIENT_FUNDS', `Balance ${from.balance} paise is less than ${amount} paise`);
  }
}

/** The money actually moves here: one D + one C line, and both balances. Accounts must be locked. */
async function postEntries(client: pg.PoolClient, t: Transfer) {
  await client.query(
    `INSERT INTO ledger_entries (transfer_id, account_id, direction, amount)
     VALUES ($1, $2, 'D', $4), ($1, $3, 'C', $4)`,
    [t.transfer_id, t.from_account_id, t.to_account_id, t.amount],
  );
  // balance = balance - $1 (not "SET balance = <value we computed in JS>"):
  // the database does the arithmetic on the row it has locked.
  await client.query('UPDATE accounts SET balance = balance - $1 WHERE account_id = $2', [t.amount, t.from_account_id]);
  await client.query('UPDATE accounts SET balance = balance + $1 WHERE account_id = $2', [t.amount, t.to_account_id]);
}

/**
 * Admin decision on a HELD transfer. Must run inside withTransaction().
 *   release -> lock accounts, re-check balance (422 and stays HELD if the money is gone), post, COMPLETED
 *   reject  -> REJECTED; no money ever moved, so there is nothing to undo
 */
export async function decideHeld(
  client: pg.PoolClient,
  transferId: bigint,
  decision: 'release' | 'reject',
  adminId: bigint | null,
  reason: string | null,
): Promise<Transfer> {
  // Lock the transfer row so two admins deciding at once queue up.
  const { rows: [held] } = await client.query<Transfer>(
    'SELECT * FROM transfers WHERE transfer_id = $1 FOR UPDATE',
    [transferId],
  );
  if (!held) throw new AppError(404, 'TRANSFER_NOT_FOUND', `Transfer ${transferId} not found`);
  if (held.status !== 'HELD') {
    throw new AppError(409, 'NOT_HELD', `Transfer ${transferId} is ${held.status}, not HELD`);
  }

  const newStatus = decision === 'release' ? 'COMPLETED' : 'REJECTED';
  if (decision === 'release') {
    await lockAccounts(client, held.from_account_id, held.to_account_id, held.amount);
    await postEntries(client, held);
  }

  const { rows: [updated] } = await client.query<Transfer>(
    'UPDATE transfers SET status = $2 WHERE transfer_id = $1 RETURNING *',
    [transferId, newStatus],
  );
  await client.query(
    `INSERT INTO transfer_status_audit (transfer_id, old_status, new_status, changed_by, reason)
     VALUES ($1, 'HELD', $2, $3, $4)`,
    [transferId, newStatus, adminId, reason ?? `admin ${decision}`],
  );
  await client.query(
    `UPDATE risk_flags SET resolution = $2, resolved_by = $3, resolved_at = now()
      WHERE transfer_id = $1 AND action = 'HOLD'`,
    [transferId, decision === 'release' ? 'RELEASED' : 'REJECTED', adminId],
  );
  return updated;
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
