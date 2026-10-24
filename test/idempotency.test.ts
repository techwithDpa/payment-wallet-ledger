import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { balanceOf, createUserWithWallet, headers } from './helpers.js';

const app = buildApp();

afterAll(async () => {
  await app.close();
  await pool.end();
});

async function fundedPair(paise: number) {
  const a = await createUserWithWallet();
  const b = await createUserWithWallet();
  const res = await app.inject({
    method: 'POST', url: '/transfers/topup', headers: headers(a.userId),
    payload: { wallet_id: a.walletId.toString(), amount: paise },
  });
  expect(res.statusCode).toBe(201);
  return { a, b };
}

function send(from: { userId: bigint; walletId: bigint }, toWalletId: bigint, amount: number, key: string) {
  return app.inject({
    method: 'POST', url: '/transfers', headers: headers(from.userId, { 'idempotency-key': key }),
    payload: { from_wallet_id: from.walletId.toString(), to_wallet_id: toWalletId.toString(), amount },
  });
}

async function transfersFrom(walletId: bigint) {
  const { rows } = await pool.query(`SELECT count(*) AS n FROM transfers WHERE from_account_id = $1`, [walletId]);
  return rows[0].n as bigint;
}

describe('idempotency', () => {
  it('same request x5 -> 1 transfer, 5 identical responses', async () => {
    const { a, b } = await fundedPair(10000);
    const key = crypto.randomUUID();
    const responses = [];
    for (let i = 0; i < 5; i++) responses.push(await send(a, b.walletId, 1000, key));

    expect(responses.map((r) => r.statusCode)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(responses.map((r) => r.body)).size).toBe(1); // byte-for-byte identical
    expect(responses[0].headers['idempotent-replayed']).toBeUndefined();
    expect(responses[1].headers['idempotent-replayed']).toBe('true');
    expect(await transfersFrom(a.walletId)).toBe(1n);
    expect(await balanceOf(a.walletId)).toBe(9000n);
  });

  it('same key x10 in parallel -> 1 transfer', async () => {
    const { a, b } = await fundedPair(10000);
    const key = crypto.randomUUID();
    const responses = await Promise.all(Array.from({ length: 10 }, () => send(a, b.walletId, 1000, key)));

    expect(responses.every((r) => r.statusCode === 201)).toBe(true);
    expect(new Set(responses.map((r) => r.body)).size).toBe(1);
    expect(await transfersFrom(a.walletId)).toBe(1n);
    expect(await balanceOf(a.walletId)).toBe(9000n);
    expect(await balanceOf(b.walletId)).toBe(1000n);
  });

  it('same key, different amount -> 422, no money moves', async () => {
    const { a, b } = await fundedPair(10000);
    const key = crypto.randomUUID();
    expect((await send(a, b.walletId, 1000, key)).statusCode).toBe(201);

    const res = await send(a, b.walletId, 5000, key);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', request_id: expect.any(String) });
    expect(await transfersFrom(a.walletId)).toBe(1n);
    expect(await balanceOf(a.walletId)).toBe(9000n);
  });

  it('a failed transfer is remembered too: retry replays the same 422', async () => {
    const { a, b } = await fundedPair(500);
    const key = crypto.randomUUID();
    const first = await send(a, b.walletId, 1000, key);
    expect(first.statusCode).toBe(422);
    expect(first.json().code).toBe('INSUFFICIENT_FUNDS');

    // Even after the wallet gets money, the same key keeps its original answer.
    await app.inject({
      method: 'POST', url: '/transfers/topup', headers: headers(a.userId),
      payload: { wallet_id: a.walletId.toString(), amount: 5000 },
    });
    const retry = await send(a, b.walletId, 1000, key);
    expect(retry.statusCode).toBe(422);
    expect(retry.body).toBe(first.body);
    expect(await transfersFrom(a.walletId)).toBe(0n);
  });

  it('the same key from two different users is two different requests', async () => {
    const p1 = await fundedPair(5000);
    const p2 = await fundedPair(5000);
    const key = crypto.randomUUID();
    expect((await send(p1.a, p1.b.walletId, 1000, key)).statusCode).toBe(201);
    expect((await send(p2.a, p2.b.walletId, 1000, key)).statusCode).toBe(201);
    expect(await balanceOf(p2.a.walletId)).toBe(4000n);
  });

  it.each([
    ['missing', undefined],
    ['not a UUID', 'abc'],
  ])('Idempotency-Key %s -> 400', async (_label, key) => {
    const { a, b } = await fundedPair(1000);
    const h: Record<string, string> = { 'x-user-id': a.userId.toString() };
    if (key) h['idempotency-key'] = key;
    const res = await app.inject({
      method: 'POST', url: '/transfers', headers: h,
      payload: { from_wallet_id: a.walletId.toString(), to_wallet_id: b.walletId.toString(), amount: 100 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(await balanceOf(a.walletId)).toBe(1000n);
  });
});
