# Demo video script (~5 min)

Record your terminal (and editor for the code part). Commands are copy-paste ready.

## 1. Start everything (30 s)
```bash
docker compose up --build -d
docker compose ps                     # db healthy, migrate exited 0, api + worker up
curl -s localhost:3000/health
```
Say: one command starts Postgres, runs migrations once, then the API and the worker.

## 2. Seed and look at a statement (60 s)
```bash
docker compose run --rm api node dist/seed.js
```
Use the printed ids (example: user 1 / wallet 4 on a fresh DB):
```bash
curl -s localhost:3000/wallets/4/balance   -H 'x-user-id: 1'
curl -s localhost:3000/wallets/4/statement -H 'x-user-id: 1'
```
Say: amounts are paise and come back as strings. Point at the `REVERSAL` row: the mistake was fixed by a new transfer, not by editing history.

## 3. Insufficient funds + idempotency live (60 s)
```bash
KEY=$(uuidgen)
send() { curl -s -i -XPOST localhost:3000/transfers -H 'x-user-id: 1' -H "idempotency-key: $KEY" \
  -H 'content-type: application/json' -d "{\"from_wallet_id\":\"4\",\"to_wallet_id\":\"5\",\"amount\":$1}"; echo; }
send 1000      # 201
send 1000      # 201 again, same body, header idempotent-replayed: true, no second transfer
send 5000      # 422 IDEMPOTENCY_KEY_REUSED: same key, different amount
KEY=$(uuidgen); send 999999999   # 422 INSUFFICIENT_FUNDS
```

## 4. The money path in code (60 s)
Open `src/services/transfers.ts` → `moveMoney()`:
lock both rows `FOR UPDATE` lowest id first → re-check balance under the lock → transfer + D/C lines → `balance = balance ± amount` → audit row.
Open `src/services/idempotency.ts` → key claimed in the same transaction, `SAVEPOINT` for business errors.

## 5. Proof: the tests (60 s)
```bash
npx vitest run test/transfers.test.ts test/idempotency.test.ts
```
Say: 100 parallel ₹10 transfers from ₹500, exactly 50 succeed, 20 rounds in a row. Same key 10× in parallel moves money once.
Show the database refusing bad states:
```bash
docker compose exec db psql -U wallet -c "UPDATE ledger_entries SET amount = 1 WHERE entry_id = (SELECT min(entry_id) FROM ledger_entries);"
# ERROR: ledger_entries is append-only: UPDATE is not allowed
```

## 6. Wrap-up (30 s)
Show README "Done / Not done / Next" and the green CI run on the PR.
