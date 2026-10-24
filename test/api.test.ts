import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { balanceOf, ledgerBalanceOf, unbalancedTransfers } from './helpers.js';

const app = buildApp();

afterAll(async () => {
  await app.close();
  await pool.end();
});

// Small client: every POST gets a fresh Idempotency-Key unless one is given.
function post(url: string, payload: object, h: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url, payload, headers: { 'idempotency-key': crypto.randomUUID(), ...h } });
}
function get(url: string, h: Record<string, string> = {}) {
  return app.inject({ method: 'GET', url, headers: h });
}
const as = (userId: string) => ({ 'x-user-id': userId });
const admin = { 'x-admin': 'true' };

async function signUp() {
  const u = await post('/users', { name: 'Asha', email: `asha-${crypto.randomUUID()}@test.local` });
  expect(u.statusCode).toBe(201);
  const userId: string = u.json().user_id;
  const w = await post(`/users/${userId}/wallets`, {}, as(userId));
  expect(w.statusCode).toBe(201);
  return { userId, walletId: w.json().wallet_id as string };
}

describe('users and wallets', () => {
  it('creates a user and a wallet that starts at 0 paise', async () => {
    const { userId, walletId } = await signUp();
    const res = await get(`/wallets/${walletId}/balance`, as(userId));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ wallet_id: walletId, user_id: userId, currency: 'INR', balance: '0' });
  });

  it('duplicate email -> 409 EMAIL_TAKEN', async () => {
    const email = `dup-${crypto.randomUUID()}@test.local`;
    expect((await post('/users', { name: 'A', email })).statusCode).toBe(201);
    const res = await post('/users', { name: 'B', email });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('EMAIL_TAKEN');
  });

  it('cannot open a wallet for someone else, or read their balance', async () => {
    const a = await signUp();
    const b = await signUp();
    expect((await post(`/users/${a.userId}/wallets`, {}, as(b.userId))).statusCode).toBe(403);
    expect((await get(`/wallets/${a.walletId}/balance`, as(b.userId))).statusCode).toBe(404);
    expect((await get(`/wallets/${a.walletId}/balance`, admin)).statusCode).toBe(200);
  });

  it('wallet for a missing user -> 404', async () => {
    const res = await post('/users/999999999/wallets', {}, admin);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('USER_NOT_FOUND');
  });
});

describe('money flow', () => {
  it('topup, transfer, withdraw, statement, reverse', async () => {
    const a = await signUp();
    const b = await signUp();

    expect((await post('/transfers/topup', { wallet_id: a.walletId, amount: 100000 }, as(a.userId))).statusCode).toBe(201);
    const peer = await post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 30000, note: 'rent' }, as(a.userId));
    expect(peer.statusCode).toBe(201);
    const wd = await post('/transfers/withdraw', { wallet_id: b.walletId, amount: 5000 }, as(b.userId));
    expect(wd.statusCode).toBe(201);
    expect(wd.json().type).toBe('WITHDRAWAL');

    // withdraw more than you have -> 422
    const over = await post('/transfers/withdraw', { wallet_id: b.walletId, amount: 999999 }, as(b.userId));
    expect(over.statusCode).toBe(422);
    expect(over.json().code).toBe('INSUFFICIENT_FUNDS');

    // statement: newest first
    const st = await get(`/wallets/${b.walletId}/statement?limit=10`, as(b.userId));
    expect(st.statusCode).toBe(200);
    expect(st.json().balance).toBe('25000');
    expect(st.json().entries.map((e: { type: string; direction: string; amount: string }) => [e.type, e.direction, e.amount]))
      .toEqual([['WITHDRAWAL', 'D', '5000'], ['PEER', 'C', '30000']]);

    // pagination
    const page2 = await get(`/wallets/${b.walletId}/statement?limit=1&offset=1`, as(b.userId));
    expect(page2.json().entries).toHaveLength(1);
    expect(page2.json().entries[0].type).toBe('PEER');

    // only admins reverse
    const peerId: string = peer.json().transfer_id;
    expect((await post(`/transfers/${peerId}/reverse`, {}, as(a.userId))).statusCode).toBe(403);

    // b only has 25000 left of the 30000, so the reversal can't pull it all back
    const tooMuch = await post(`/transfers/${peerId}/reverse`, { reason: 'fraud' }, admin);
    expect(tooMuch.statusCode).toBe(422);
    expect(tooMuch.json().code).toBe('INSUFFICIENT_FUNDS');

    await post('/transfers/topup', { wallet_id: b.walletId, amount: 5000 }, as(b.userId));
    const rev = await post(`/transfers/${peerId}/reverse`, { reason: 'sent by mistake' }, admin);
    expect(rev.statusCode).toBe(201);
    expect(rev.json()).toMatchObject({ type: 'REVERSAL', reverses_transfer_id: peerId, amount: '30000' });

    expect(await balanceOf(BigInt(a.walletId))).toBe(100000n);
    expect(await balanceOf(BigInt(b.walletId))).toBe(0n);
    expect(await ledgerBalanceOf(BigInt(b.walletId))).toBe(0n);

    // reversing twice -> 409
    const again = await post(`/transfers/${peerId}/reverse`, {}, admin);
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('ALREADY_REVERSED');

    // reversing the reversal -> 409
    expect((await post(`/transfers/${rev.json().transfer_id}/reverse`, {}, admin)).statusCode).toBe(409);

    // GET /transfers/:id shows entries and the full status history
    const detail = await get(`/transfers/${peerId}`, as(b.userId));
    expect(detail.statusCode).toBe(200);
    expect(detail.json().status).toBe('REVERSED');
    expect(detail.json().entries).toHaveLength(2);
    expect(detail.json().status_history.map((h: { new_status: string }) => h.new_status)).toEqual(['COMPLETED', 'REVERSED']);
    expect(detail.json().from_user_id).toBeUndefined();

    // a stranger can't see it
    const c = await signUp();
    expect((await get(`/transfers/${peerId}`, as(c.userId))).statusCode).toBe(404);

    expect(await unbalancedTransfers()).toEqual([]);
  });

  it('two admins reversing the same transfer at once: exactly one wins', async () => {
    const a = await signUp();
    const b = await signUp();
    await post('/transfers/topup', { wallet_id: a.walletId, amount: 1000 }, as(a.userId));
    const peer = await post('/transfers', { from_wallet_id: a.walletId, to_wallet_id: b.walletId, amount: 1000 }, as(a.userId));
    const id = peer.json().transfer_id;

    const results = await Promise.all(Array.from({ length: 5 }, () => post(`/transfers/${id}/reverse`, {}, admin)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409, 409, 409]);
    expect(await balanceOf(BigInt(a.walletId))).toBe(1000n);
    expect(await balanceOf(BigInt(b.walletId))).toBe(0n);
  });
});
