import { pathToFileURL } from 'node:url';
import { pool, withTransaction } from './db.js';
import { moveMoney, reverseTransfer, systemAccountId } from './services/transfers.js';

// Demo data for the video and for trying the API by hand.
// Money moves through the real moveMoney()/reverseTransfer(), never raw INSERTs,
// so the ledger is balanced exactly like real traffic.

const DEMO_USERS = [
  { name: 'Asha Rao', email: 'asha@demo.in' },
  { name: 'Ravi Kumar', email: 'ravi@demo.in' },
  { name: 'Meera Iyer', email: 'meera@demo.in' },
];

export interface SeedResult {
  created: boolean;
  users: { user_id: bigint; name: string; wallet_id: bigint; balance: bigint }[];
}

export async function seed(): Promise<SeedResult> {
  const created = await withTransaction('READ COMMITTED', async (client) => {
    // Run once: if the first demo user exists, the seed already ran.
    const { rowCount } = await client.query('SELECT 1 FROM users WHERE email = $1', [DEMO_USERS[0].email]);
    if (rowCount) return false;

    const wallets: bigint[] = [];
    const userIds: bigint[] = [];
    for (const u of DEMO_USERS) {
      const { rows: [user] } = await client.query(
        `INSERT INTO users (name, email, kyc_status) VALUES ($1, $2, 'VERIFIED') RETURNING user_id`,
        [u.name, u.email],
      );
      const { rows: [wallet] } = await client.query(
        `INSERT INTO accounts (user_id, kind) VALUES ($1, 'USER_WALLET') RETURNING account_id`,
        [user.user_id],
      );
      userIds.push(user.user_id);
      wallets.push(wallet.account_id);
    }
    const [asha, ravi, meera] = wallets;
    const cashIn = await systemAccountId(client, 'cash_in');
    const cashOut = await systemAccountId(client, 'cash_out');

    // Amounts are paise: 500000n = ₹5,000.00
    await moveMoney(client, { type: 'TOPUP', fromAccountId: cashIn, toAccountId: asha, amount: 500000n, note: 'salary', createdBy: userIds[0] });
    await moveMoney(client, { type: 'TOPUP', fromAccountId: cashIn, toAccountId: ravi, amount: 200000n, note: 'top-up', createdBy: userIds[1] });
    await moveMoney(client, { type: 'PEER', fromAccountId: asha, toAccountId: ravi, amount: 75000n, note: 'dinner split', createdBy: userIds[0] });
    await moveMoney(client, { type: 'PEER', fromAccountId: ravi, toAccountId: meera, amount: 30000n, note: 'movie tickets', createdBy: userIds[1] });
    await moveMoney(client, { type: 'WITHDRAWAL', fromAccountId: ravi, toAccountId: cashOut, amount: 50000n, note: 'to bank', createdBy: userIds[1] });
    const mistake = await moveMoney(client, { type: 'PEER', fromAccountId: asha, toAccountId: meera, amount: 12000n, note: 'sent to wrong person', createdBy: userIds[0] });
    await reverseTransfer(client, mistake.transfer_id, 'sent to wrong person', null);
    return true;
  });

  const { rows } = await pool.query(
    `SELECT u.user_id, u.name, a.account_id AS wallet_id, a.balance
       FROM users u JOIN accounts a ON a.user_id = u.user_id
      WHERE u.email = ANY($1) ORDER BY u.user_id`,
    [DEMO_USERS.map((u) => u.email)],
  );
  return { created, users: rows };
}

// Run directly: `npm run seed` (or `node dist/seed.js` in Docker)
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const result = await seed();
    console.log(result.created ? 'Seeded demo data:' : 'Demo data already present:');
    for (const u of result.users) {
      console.log(`  user ${u.user_id} ${u.name.padEnd(11)} wallet ${u.wallet_id}  balance ${u.balance} paise`);
    }
    console.log('Try: curl localhost:3000/wallets/<wallet_id>/statement -H "x-user-id: <user_id>"');
  } finally {
    await pool.end();
  }
}
