import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { balanceOf, createUserWithWallet, headers, ledgerBalanceOf } from './helpers.js';

const app = buildApp();
const admin = { 'x-admin': 'true', 'idempotency-key': '' };

afterAll(async () => {
  await app.close();
  await pool.end();
});

type Wallet = { userId: bigint; walletId: bigint };

async function funded(paise: bigint): Promise<Wallet> {
  const w = await createUserWithWallet();
  const res = await app.inject({
    method: 'POST', url: '/transfers/topup', headers: headers(w.userId),
    payload: { wallet_id: w.walletId.toString(), amount: paise.toString() },
  });
  expect(res.statusCode).toBe(201);
  return w;
}

function send(from: Wallet, to: Wallet, amount: bigint) {
  return app.inject({
    method: 'POST', url: '/transfers', headers: headers(from.userId),
    payload: { from_wallet_id: from.walletId.toString(), to_wallet_id: to.walletId.toString(), amount: amount.toString() },
  });
}

function decide(transferId: string, decision: string) {
  return app.inject({
    method: 'POST', url: `/admin/risk/${transferId}/decision`,
    headers: { ...admin, 'idempotency-key': crypto.randomUUID() }, payload: { decision },
  });
}

async function linesOf(transferId: string) {
  const { rows } = await pool.query('SELECT count(*) AS n FROM ledger_entries WHERE transfer_id = $1', [transferId]);
  return rows[0].n as bigint;
}

describe('velocity: more than 5 outgoing in 10 min -> HELD', () => {
  it('the 6th transfer is held: 202, no ledger lines, balances unchanged, in the admin queue', async () => {
    const a = await funded(100000n);
    const b = await createUserWithWallet();
    for (let i = 0; i < 5; i++) expect((await send(a, b, 1000n)).statusCode).toBe(201);

    const sixth = await send(a, b, 1000n);
    expect(sixth.statusCode).toBe(202);
    expect(sixth.json()).toMatchObject({ status: 'HELD', risk_flags: [{ rule_code: 'VELOCITY', action: 'HOLD' }] });
    const id: string = sixth.json().transfer_id;
    expect(await linesOf(id)).toBe(0n);
    expect(await balanceOf(a.walletId)).toBe(95000n);
    expect(await balanceOf(b.walletId)).toBe(5000n);

    const queue = await app.inject({ method: 'GET', url: '/admin/risk/queue?limit=100', headers: admin });
    expect(queue.statusCode).toBe(200);
    expect(queue.json().items.map((t: { transfer_id: string }) => t.transfer_id)).toContain(id);
    expect((await decide(id, 'reverse')).statusCode).toBe(200); // leave the queue empty for the next run
  });
});

describe('admin decision', () => {
  async function heldTransfer() {
    const a = await funded(100000n);
    const b = await createUserWithWallet();
    for (let i = 0; i < 5; i++) await send(a, b, 1000n);
    const held = await send(a, b, 1000n);
    expect(held.statusCode).toBe(202);
    return { a, b, id: held.json().transfer_id as string };
  }

  it('release: money moves now, status COMPLETED, audit HELD -> COMPLETED, flag resolved', async () => {
    const { a, b, id } = await heldTransfer();
    const res = await decide(id, 'release');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'COMPLETED', risk_flags: [{ resolution: 'RELEASED' }] });
    expect(await linesOf(id)).toBe(2n);
    expect(await balanceOf(a.walletId)).toBe(94000n);
    expect(await balanceOf(b.walletId)).toBe(6000n);
    expect(await ledgerBalanceOf(a.walletId)).toBe(94000n);

    const detail = await app.inject({ method: 'GET', url: `/transfers/${id}`, headers: { 'x-user-id': a.userId.toString() } });
    expect(detail.json().status_history.map((h: { new_status: string }) => h.new_status)).toEqual(['HELD', 'COMPLETED']);

    // deciding twice -> 409
    const again = await decide(id, 'release');
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('NOT_HELD');
  });

  it('reverse: the held transfer is REJECTED and no money ever moves', async () => {
    const { a, b, id } = await heldTransfer();
    const res = await decide(id, 'reverse');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'REJECTED', risk_flags: [{ resolution: 'REJECTED' }] });
    expect(await linesOf(id)).toBe(0n);
    expect(await balanceOf(a.walletId)).toBe(95000n);
    expect(await balanceOf(b.walletId)).toBe(5000n);
  });

  it('release when the money is gone -> 422 and it stays HELD', async () => {
    const { a, b, id } = await heldTransfer();
    // empty the wallet while the transfer waits
    await app.inject({
      method: 'POST', url: '/transfers/withdraw', headers: headers(a.userId),
      payload: { wallet_id: a.walletId.toString(), amount: '95000' },
    });
    const res = await decide(id, 'release');
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('INSUFFICIENT_FUNDS');
    const { rows } = await pool.query('SELECT status FROM transfers WHERE transfer_id = $1', [id]);
    expect(rows[0].status).toBe('HELD');
    expect(await balanceOf(b.walletId)).toBe(5000n);
    expect((await decide(id, 'reverse')).statusCode).toBe(200);
  });

  it('admin only', async () => {
    const q = await app.inject({ method: 'GET', url: '/admin/risk/queue', headers: { 'x-user-id': '1' } });
    expect(q.statusCode).toBe(403);
  });
});

describe('amount spike: above 5x the 30-day average -> HELD', () => {
  it('skipped without history; held once there is an average to compare with', async () => {
    const a = await funded(1000000n);
    const b = await createUserWithWallet();
    // first ever transfer: no history, so even a "big" one goes through
    expect((await send(a, b, 50000n)).statusCode).toBe(201);
    expect((await send(a, b, 1000n)).statusCode).toBe(201);
    expect((await send(a, b, 1000n)).statusCode).toBe(201);
    // average is now (50000 + 1000 + 1000) / 3 = 17333; 5x = 86667
    expect((await send(a, b, 86000n)).statusCode).toBe(201);
    // average now (52000 + 86000) / 4 = 34500; 5x = 172500
    const spike = await send(a, b, 172501n);
    expect(spike.statusCode).toBe(202);
    expect(spike.json().risk_flags).toEqual([expect.objectContaining({ rule_code: 'AMOUNT_SPIKE', action: 'HOLD' })]);
    expect((await decide(spike.json().transfer_id, 'reverse')).statusCode).toBe(200);
  });
});

describe('new payee above ₹10,000 -> FLAG but allow', () => {
  it('first large transfer to a payee is flagged and goes through; the second is not flagged', async () => {
    const a = await funded(5000000n);
    const b = await createUserWithWallet();
    const first = await send(a, b, 1500000n); // ₹15,000 to someone new
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ status: 'COMPLETED', risk_flags: [{ rule_code: 'NEW_PAYEE_LARGE', action: 'FLAG' }] });
    expect(await balanceOf(b.walletId)).toBe(1500000n);

    const second = await send(a, b, 1500000n);
    expect(second.statusCode).toBe(201);
    expect(second.json().risk_flags).toEqual([]);
  });

  it('exactly ₹10,000 is not "above" the threshold', async () => {
    const a = await funded(5000000n);
    const b = await createUserWithWallet();
    expect((await send(a, b, 1000000n)).json().risk_flags).toEqual([]);
  });
});
