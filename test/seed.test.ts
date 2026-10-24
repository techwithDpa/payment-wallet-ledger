import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { seed } from '../src/seed.js';
import { ledgerBalanceOf, unbalancedTransfers } from './helpers.js';

afterAll(async () => {
  await pool.end();
});

describe('seed', () => {
  it('creates three demo users with the expected balances, and is safe to run twice', async () => {
    await seed();
    const again = await seed();
    expect(again.created).toBe(false);

    // asha 5000 - 750 = 4250 (the 120 mistake was reversed); ravi 2000 + 750 - 300 - 500 = 1950; meera 300
    expect(again.users.map((u) => [u.name, u.balance])).toEqual([
      ['Asha Rao', 425000n],
      ['Ravi Kumar', 195000n],
      ['Meera Iyer', 30000n],
    ]);
    for (const u of again.users) expect(await ledgerBalanceOf(u.wallet_id)).toBe(u.balance);
    expect(await unbalancedTransfers()).toEqual([]);
  });
});
