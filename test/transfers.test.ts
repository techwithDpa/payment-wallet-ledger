import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { balanceOf, createUserWithWallet, headers, ledgerBalanceOf, unbalancedTransfers } from './helpers.js';

const app = buildApp();

afterAll(async () => {
  await app.close();
  await pool.end();
});

async function topup(userId: bigint, walletId: bigint, amount: number | string) {
  return app.inject({
    method: 'POST', url: '/transfers/topup', headers: headers(userId),
    payload: { wallet_id: walletId.toString(), amount },
  });
}

describe('transfers', () => {
  it('top-up credits the wallet and writes one D and one C line', async () => {
    const a = await createUserWithWallet();
    const res = await topup(a.userId, a.walletId, 50000);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ type: 'TOPUP', status: 'COMPLETED', amount: '50000' });

    expect(await balanceOf(a.walletId)).toBe(50000n);
    const { rows } = await pool.query(
      'SELECT direction, amount FROM ledger_entries WHERE transfer_id = $1 ORDER BY direction', [res.json().transfer_id]);
    expect(rows).toEqual([{ direction: 'C', amount: 50000n }, { direction: 'D', amount: 50000n }]);
  });

  it('peer transfer moves money between two wallets', async () => {
    const a = await createUserWithWallet();
    const b = await createUserWithWallet();
    await topup(a.userId, a.walletId, 10000);
    const res = await app.inject({
      method: 'POST', url: '/transfers', headers: headers(a.userId),
      payload: { from_wallet_id: a.walletId.toString(), to_wallet_id: b.walletId.toString(), amount: 2500 },
    });
    expect(res.statusCode).toBe(201);
    expect(await balanceOf(a.walletId)).toBe(7500n);
    expect(await balanceOf(b.walletId)).toBe(2500n);
  });

  it('rejects overdraft with 422 INSUFFICIENT_FUNDS and moves nothing', async () => {
    const a = await createUserWithWallet();
    const b = await createUserWithWallet();
    await topup(a.userId, a.walletId, 100);
    const res = await app.inject({
      method: 'POST', url: '/transfers', headers: headers(a.userId),
      payload: { from_wallet_id: a.walletId.toString(), to_wallet_id: b.walletId.toString(), amount: 101 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'INSUFFICIENT_FUNDS', request_id: expect.any(String) });
    expect(await balanceOf(a.walletId)).toBe(100n);
    expect(await balanceOf(b.walletId)).toBe(0n);
  });

  it('cannot send from a wallet you do not own', async () => {
    const a = await createUserWithWallet();
    const b = await createUserWithWallet();
    await topup(a.userId, a.walletId, 1000);
    const res = await app.inject({
      method: 'POST', url: '/transfers', headers: headers(b.userId), // b tries to spend a's money
      payload: { from_wallet_id: a.walletId.toString(), to_wallet_id: b.walletId.toString(), amount: 1000 },
    });
    expect(res.statusCode).toBe(404);
    expect(await balanceOf(a.walletId)).toBe(1000n);
  });

  it.each([
    ['a float', 10.5],
    ['zero', 0],
    ['a negative', -100],
    ['a decimal string', '10.50'],
    ['scientific notation', '1e5'],
  ])('rejects %s amount with 400', async (_label, amount) => {
    const a = await createUserWithWallet();
    const res = await topup(a.userId, a.walletId, amount);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('requires X-User-Id', async () => {
    const res = await app.inject({ method: 'POST', url: '/transfers/topup', payload: { wallet_id: '1', amount: 1 } });
    expect(res.statusCode).toBe(401);
  });
});

describe('stampede', () => {
  // This test is about locking, not fraud: 100 transfers in a second would trip the
  // velocity rule (>5 in 10 min -> HELD). Switch it off for this test only.
  // Safe because test files run one at a time (vitest.config.ts).
  beforeAll(async () => {
    await pool.query(`UPDATE risk_rules SET enabled = false WHERE code = 'VELOCITY'`);
  });
  afterAll(async () => {
    await pool.query(`UPDATE risk_rules SET enabled = true WHERE code = 'VELOCITY'`);
  });

  // ₹500 wallet, 100 parallel ₹10 transfers -> exactly 50 succeed, balance ends at 0, never negative.
  it('100 parallel ₹10 transfers from a ₹500 wallet: exactly 50 succeed (x20)', async () => {
    for (let round = 1; round <= 20; round++) {
      const a = await createUserWithWallet();
      const b = await createUserWithWallet();
      await topup(a.userId, a.walletId, 50000); // ₹500 = 50000 paise

      const results = await Promise.all(
        Array.from({ length: 100 }, () =>
          app.inject({
            method: 'POST', url: '/transfers', headers: headers(a.userId),
            payload: { from_wallet_id: a.walletId.toString(), to_wallet_id: b.walletId.toString(), amount: 1000 },
          }),
        ),
      );
      const codes = results.map((r) => r.statusCode);
      expect(codes.filter((c) => c === 201).length, `round ${round}`).toBe(50);
      expect(codes.filter((c) => c === 422).length, `round ${round}`).toBe(50);

      expect(await balanceOf(a.walletId)).toBe(0n);
      expect(await balanceOf(b.walletId)).toBe(50000n);
      // stored balance == what the ledger proves
      expect(await ledgerBalanceOf(a.walletId)).toBe(0n);
      expect(await ledgerBalanceOf(b.walletId)).toBe(50000n);
    }
    expect(await unbalancedTransfers()).toEqual([]); // debits = credits for every transfer
  }, 60_000);
});
