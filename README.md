# Wallet Ledger

Backend of a payments-grade digital wallet: double-entry ledger, safe concurrent transfers, idempotent payments, reversals, and an audit trail.

Stack: Node 22, TypeScript (strict), Fastify 5, `pg` with plain SQL (no ORM), PostgreSQL 16, dbmate migrations, zod, Vitest against a real Postgres.

## Run it

```bash
docker compose up --build -d                  # db, migrate (runs once), api :3000, worker
curl localhost:3000/health                    # {"ok":true,"db":"up","job_locks":1}
docker compose run --rm api node dist/seed.js # demo users Asha, Ravi, Meera with wallets and history
```

## Run the tests

```bash
docker compose up -d db migrate   # database + schema
npm install
npm test                          # 41 tests, ~6 s, includes the 100-request stampede x20 and 10k-transfer reconciliation
npm run seed                      # same demo data, from your laptop
```

CI (`.github/workflows/ci.yml`) runs migrations, typecheck and all tests against Postgres 16 on every push and PR.

## API

Auth is a header (see Assumptions): `X-User-Id: <id>`; admin endpoints also need `X-Admin: true`.
Every POST needs `Idempotency-Key: <uuid>`. Money is **whole paise**: send `"amount": 50000` or `"50000"` for ₹500.00; responses return amounts and ids as strings.
Errors are always `{"code": "...", "message": "...", "request_id": "..."}`.

| Method | Path | Who | Responses |
| --- | --- | --- | --- |
| POST | `/users` `{name, email}` | anyone | 201, 409 `EMAIL_TAKEN` |
| POST | `/users/{id}/wallets` | that user or admin | 201, 403, 404 |
| GET | `/wallets/{id}/balance` | owner or admin | 200, 404 |
| GET | `/wallets/{id}/statement?limit=20&offset=0` | owner or admin | 200 (newest first) |
| POST | `/transfers/topup` `{wallet_id, amount, note?}` | owner | 201, 404 |
| POST | `/transfers` `{from_wallet_id, to_wallet_id, amount, note?}` | owner of `from` | 201, 404, 422 `INSUFFICIENT_FUNDS` |
| POST | `/transfers/withdraw` `{wallet_id, amount, note?}` | owner | 201, 422 |
| POST | `/transfers/{id}/reverse` `{reason?}` | admin | 201, 404, 409 `ALREADY_REVERSED` / `NOT_REVERSIBLE`, 422 |
| GET | `/transfers/{id}` | either party or admin | 200 with `entries` and `status_history` |
| POST | `/admin/reconciliation/run` | admin | 202 `{recon_run_id, status_url}`; the check runs in the background |
| GET | `/admin/reconciliation/runs/{id}` | admin | 200 run summary + `issues`, 404 |
| GET | `/health` | anyone | 200 |

Idempotency errors on any POST: 400 `IDEMPOTENCY_KEY_REQUIRED`, 409 `REQUEST_IN_PROGRESS`, 422 `IDEMPOTENCY_KEY_REUSED`. A replay returns the saved status and body with header `idempotent-replayed: true`.

### Try it

```bash
K() { uuidgen; }   # a fresh Idempotency-Key
curl -s -XPOST localhost:3000/users -H "idempotency-key: $(K)" -H 'content-type: application/json' \
  -d '{"name":"Asha","email":"asha@example.in"}'                       # -> user_id
curl -s -XPOST localhost:3000/users/1/wallets -H 'x-user-id: 1' -H "idempotency-key: $(K)" \
  -H 'content-type: application/json' -d '{}'                          # -> wallet_id
curl -s -XPOST localhost:3000/transfers/topup -H 'x-user-id: 1' -H "idempotency-key: $(K)" \
  -H 'content-type: application/json' -d '{"wallet_id":"4","amount":50000}'
curl -s localhost:3000/wallets/4/statement -H 'x-user-id: 1'
```

(Use the ids your calls return; wallet ids start after the 3 system accounts.)

## Design

### Data model
Full detail and ER diagram: [`docs/schema.md`](docs/schema.md).

- **One `accounts` table for user wallets and system accounts** (`cash_in`, `cash_out`, `fee_revenue`). Every movement is "from account → to account": a top-up is `cash_in → wallet`, a withdrawal is `wallet → cash_out`. One code path moves all money.
- **Double entry.** Each completed transfer writes exactly one debit line (subtracts) and one credit line (adds) of the same amount, so the sum of all debits always equals the sum of all credits. `cash_in` goes negative as money enters the system: that negative number *is* the total money users brought in.
- **Balance stored AND provable.** `accounts.balance` gives O(1) reads and is the row we lock. The ledger proves it: `SUM(credits) − SUM(debits)` per account must equal `balance` (the tests check this; the nightly reconciliation will too).
- **Money is `BIGINT` paise** in Postgres and `bigint` in TypeScript (a type parser converts Postgres BIGINT to `bigint`). No floats, no `NUMERIC` rounding, no `parseFloat`. JSON carries amounts as strings so no client loses precision above 2^53.

### Safe concurrent transfers
Inside one `READ COMMITTED` transaction (`src/services/transfers.ts`, `moveMoney()`):

1. `SELECT ... WHERE account_id = ANY($1) ORDER BY account_id FOR UPDATE`: lock both accounts, **lowest id first**. Two opposite transfers (A→B, B→A) queue in the same order, so they can't deadlock.
2. **Re-check the balance after the lock.** A check before the lock is a race: 100 requests would all see ₹500 and all pass.
3. Insert transfer + D/C lines, `UPDATE accounts SET balance = balance ± $1` (Postgres does the arithmetic on the locked row), insert an audit row, commit.

Proof: the stampede test (₹500 wallet, 100 parallel ₹10 transfers) gets exactly 50 successes and ends at 0 in all 20 rounds.
The database is the last line of defence: `CHECK (kind = 'SYSTEM' OR balance >= 0)` refuses a negative wallet even if the code had a bug.

**Why row locks and not SERIALIZABLE?** Locks make conflicting transfers *wait* instead of fail. SERIALIZABLE would abort them with serialization errors that every caller must retry. For a hot wallet, waiting is cheaper and simpler to reason about.

### Idempotency
`src/services/idempotency.ts`, `idempotent()`:

- The key row (`IN_PROGRESS`) is inserted **in the same transaction** as the money. Key and money commit together or not at all, so a crash can never leave "money moved but key not saved".
- A parallel duplicate's `INSERT ... ON CONFLICT DO NOTHING` waits on the unique index until the first commits, then replays its result. 10 parallel identical requests → 1 transfer.
- Business errors (e.g. `INSUFFICIENT_FUNDS`) roll back to a `SAVEPOINT`: the money work is undone but the error response is saved, so a retry gets the same answer even if the wallet was topped up in between.
- The request is fingerprinted (sha256 of method + path + body). Same key with a different amount → 422, no money moves.
- Responses are replayed from the stored JSONB, so the first response and every replay are byte-identical.

### Corrections: append-only ledger + reversals
`ledger_entries` has a trigger that raises on UPDATE, DELETE and TRUNCATE. A mistake is fixed with a **REVERSAL** transfer that moves the same amount back, and the original is marked `REVERSED` in `transfer_status_audit`. `reverses_transfer_id UNIQUE` plus a row lock on the original guarantee a transfer is reversed at most once (5 parallel reversals → exactly one 201).

### Reconciliation
`src/services/reconciliation.ts`. Runs nightly at 02:30 in the worker, or on demand via `POST /admin/reconciliation/run`.

- **One snapshot.** The whole check runs in one `REPEATABLE READ` transaction, so transfers committing during the run can't look like mismatches.
- **Never two at once.** A run takes the `job_locks` row with `FOR UPDATE NOWAIT`; a second run gives up immediately and is recorded as `SKIPPED`.
- **Root problems, not symptoms.** Two checks:
  1. *Transfer check:* every moved transfer has exactly one D line on its sender and one C line on its receiver, both equal to its amount (HELD/REJECTED: no lines). A broken one → `TRANSFER_LEDGER_MISMATCH`.
  2. *Balance check:* each stored balance is compared with two independent views: **L** (credits − debits in the ledger) and **T** (money in − money out in the transfers table). A broken transfer makes L and T disagree, but the stored balance still matches one of them, so it's a symptom already reported by check 1. Only a balance that matches **neither** was itself changed → `ACCOUNT_BALANCE_MISMATCH`.
- Proof: 10,000 transfers, then corrupt one amount, delete one credit line and change one stored balance → exactly 3 issues. A naive "balance ≠ ledger" check would report 5. After repair → 0. The run also stores total debits vs total credits.

### Trade-offs
| Choice | Gain | Cost |
| --- | --- | --- |
| Stored balance + ledger | fast reads, a row to lock | two sources that must agree → needs reconciliation |
| Pessimistic row locks | no retries, simple | a very hot wallet serializes its transfers |
| Key + money in one transaction | no half states | a duplicate holds a DB connection while it waits |
| Plain SQL, no ORM | every lock and query is visible and reviewable | more hand-written SQL |
| OFFSET pagination | simple | slow at deep offsets (keyset pagination is in Next) |
| Reconciliation scans everything | simple, catches anything | O(ledger size) per run; at scale, check only accounts touched since the last run |
| Header auth | lets the project focus on the ledger | not real security |

## Assumptions
- Auth is `X-User-Id` (caller) and `X-Admin: true` (admin). A real system would use signed tokens.
- `POST /users` needs no `X-User-Id`; its idempotency scope is "anonymous".
- One currency, INR. A user may open several wallets.
- KYC status is stored, not enforced.
- Only admins reverse transfers. A reversal is refused (422) if the receiver already spent the money, so a wallet never goes negative. A reversal can't itself be reversed.
- Asking for a wallet or transfer that isn't yours returns 404, the same as one that doesn't exist, so ids can't be probed.

## Done / Not done / Next

**Done**
- [x] Skeleton: Docker Compose (db, migrate, api, worker), dbmate migrations, CI
- [x] Schema with DB-enforced money rules ([`docs/schema.md`](docs/schema.md))
- [x] Safe transfers + stampede test (×20)
- [x] Idempotency (sequential, parallel, key reuse, saved errors)
- [x] Users, wallets, balance, statement, top-up, transfer, withdraw, reverse, transfer details
- [x] Seed data (`npm run seed`)
- [x] Reconciliation: nightly worker job + admin endpoints, root-cause issues, no overlapping runs

**Not done yet**
- [ ] Fraud rules: HELD transfers (`202`), `/admin/risk/*` (Step 6)
- [ ] Statement Q&A with mock LLM (Step 7)
- [ ] `docs/isolation.md` (4 two-session psql cases)
- [ ] Fees (the `FEE` type exists, nothing charges one)

**Next**
- LLM explanations for risk flags; `EXPLAIN` study on 1M ledger rows; keyset pagination for statements; sharding by wallet.
