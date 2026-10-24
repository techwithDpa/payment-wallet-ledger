# Isolation lab: 4 two-session cases

Each case is two `psql` sessions, **A** and **B**, run side by side. Each one shows *why* a choice in the code exists.
All outputs below were captured from real runs on Postgres 16 (default isolation `READ COMMITTED`).

## Setup

Open two terminals and run this in each:

```bash
docker compose exec db psql -U wallet
```

In either one, create a throwaway lab table (it never touches the real ledger):

```sql
DROP TABLE IF EXISTS lab_accounts, lab_keys;
CREATE TABLE lab_accounts (id INT PRIMARY KEY, balance BIGINT NOT NULL CHECK (balance >= 0));
INSERT INTO lab_accounts VALUES (1, 1000), (2, 1000);
CREATE TABLE lab_keys (key TEXT PRIMARY KEY);
```

Re-run the setup before each case. When finished: `DROP TABLE lab_accounts, lab_keys;`

Read the tables top to bottom: each row happens after the one above it.

---

## Case 1: double spend → why we lock with `FOR UPDATE` and re-check

Two requests each want to spend 700 from a balance of 1000. Only one should succeed.

### 1a. Read, decide in the app, write an absolute value (broken)

| # | Session A | Session B |
| --- | --- | --- |
| 1 | `BEGIN;` | |
| 2 | `SELECT balance FROM lab_accounts WHERE id = 1;` → **1000** | |
| 3 | | `BEGIN;` |
| 4 | | `SELECT balance FROM lab_accounts WHERE id = 1;` → **1000** |
| 5 | app: 1000 ≥ 700, OK → `UPDATE lab_accounts SET balance = 300 WHERE id = 1;` | |
| 6 | `COMMIT;` | |
| 7 | | app: 1000 ≥ 700, OK → `UPDATE lab_accounts SET balance = 300 WHERE id = 1;` |
| 8 | | `COMMIT;` |
| 9 | | `SELECT balance ...` → **300** |

**1400 was spent from 1000, and the balance says 300.** Both requests checked a value that was already stale. This is a *lost update*: `READ COMMITTED` alone doesn't prevent it.

### 1b. Lock first, then check (what `moveMoney()` does)

| # | Session A | Session B |
| --- | --- | --- |
| 1 | `BEGIN;` | |
| 2 | `SELECT balance FROM lab_accounts WHERE id = 1 FOR UPDATE;` → **1000** (row locked) | |
| 3 | | `BEGIN;` |
| 4 | | `SELECT balance FROM lab_accounts WHERE id = 1 FOR UPDATE;` → ⏳ **waits** |
| 5 | `UPDATE lab_accounts SET balance = balance - 700 WHERE id = 1;` | ⏳ |
| 6 | `COMMIT;` | → returns **300** |
| 7 | | app: 300 < 700 → reject (422 `INSUFFICIENT_FUNDS`), `ROLLBACK;` |

B can't read the balance until A is done, so B's check sees the truth. Two more guards in our code:
`balance = balance - $1` lets Postgres do the arithmetic on the locked row, and `CHECK (balance >= 0)` refuses a negative wallet even if the app had a bug.
The stampede test (100 parallel ₹10 transfers from ₹500 → exactly 50 succeed) is this case at scale.

---

## Case 2: deadlock → why we lock in ascending `account_id` order

A transfer 1 → 2 and a transfer 2 → 1 at the same time.

### 2a. Each locks "its sender first" (broken)

| # | Session A (1 → 2) | Session B (2 → 1) |
| --- | --- | --- |
| 1 | `BEGIN;` `SELECT * FROM lab_accounts WHERE id = 1 FOR UPDATE;` → locked 1 | |
| 2 | | `BEGIN;` `SELECT * FROM lab_accounts WHERE id = 2 FOR UPDATE;` → locked 2 |
| 3 | `SELECT * FROM lab_accounts WHERE id = 2 FOR UPDATE;` → ⏳ waits for B | |
| 4 | ⏳ | `SELECT * FROM lab_accounts WHERE id = 1 FOR UPDATE;` → ⏳ waits for A |
| 5 | after ~1 s: **`ERROR: deadlock detected`** (A is aborted) | → gets row 1 |

```
ERROR:  deadlock detected
DETAIL:  Process 18503 waits for ShareLock on transaction 39190; blocked by process 18504.
Process 18504 waits for ShareLock on transaction 39189; blocked by process 18503.
```

A waits for B, and B waits for A. Postgres breaks the circle by killing one of them, so one transfer fails for no business reason.

### 2b. Both lock lowest id first (what `moveMoney()` does)

| # | Session A (1 → 2) | Session B (2 → 1) |
| --- | --- | --- |
| 1 | `BEGIN;` `SELECT * FROM lab_accounts WHERE id IN (1, 2) ORDER BY id FOR UPDATE;` → locked 1 and 2 | |
| 2 | | `BEGIN;` `SELECT * FROM lab_accounts WHERE id IN (2, 1) ORDER BY id FOR UPDATE;` → ⏳ waits |
| 3 | `COMMIT;` | → gets 1 and 2 |
| 4 | | `COMMIT;` |

Everyone queues for account 1 first, so nobody can hold 2 while waiting for 1. B just waits its turn, and there's no deadlock.

---

## Case 3: inconsistent reads → why reconciliation uses `REPEATABLE READ`

A reader adds up two balances while B moves 100 from account 1 to account 2. The true total is always 2000.

### 3a. `READ COMMITTED` (each statement sees the latest commits)

| # | Session A (reader) | Session B (transfer) |
| --- | --- | --- |
| 1 | `BEGIN ISOLATION LEVEL READ COMMITTED;` | |
| 2 | `SELECT balance FROM lab_accounts WHERE id = 1;` → **1000** | |
| 3 | | `BEGIN;` `UPDATE ... balance - 100 WHERE id = 1;` `UPDATE ... balance + 100 WHERE id = 2;` `COMMIT;` |
| 4 | `SELECT balance FROM lab_accounts WHERE id = 2;` → **1100** | |

A computes 1000 + 1100 = **2100**: ₹100 appeared from nowhere. Each read was correct when it ran, but the two reads came from different moments.

### 3b. `REPEATABLE READ` (the whole transaction sees one snapshot)

| # | Session A (reader) | Session B (transfer) |
| --- | --- | --- |
| 1 | `BEGIN ISOLATION LEVEL REPEATABLE READ;` | |
| 2 | `SELECT balance FROM lab_accounts WHERE id = 1;` → **1000** | |
| 3 | | same transfer, `COMMIT;` |
| 4 | `SELECT balance FROM lab_accounts WHERE id = 2;` → **1000** | |

1000 + 1000 = **2000**, which is correct. A sees the database as it was at its first query, ignoring B's later commit.
Reconciliation runs several big queries (transfers, ledger lines, balances) while live transfers keep committing. Under `READ COMMITTED` that would produce false alarms like the ₹100 above, so `executeRun()` uses `REPEATABLE READ`.

---

## Case 4: duplicate requests → why parallel retries with one Idempotency-Key move money once

Two copies of the same request (same key) arrive together.

### 4a. The first one commits

| # | Session A | Session B |
| --- | --- | --- |
| 1 | `BEGIN;` `INSERT INTO lab_keys VALUES ('k1') ON CONFLICT DO NOTHING RETURNING key;` → **k1** (1 row) | |
| 2 | (would now move the money) | `BEGIN;` `INSERT INTO lab_keys VALUES ('k1') ON CONFLICT DO NOTHING RETURNING key;` → ⏳ **waits** |
| 3 | `COMMIT;` | → **0 rows** (key taken) |
| 4 | | `COMMIT;`: don't move money, replay A's saved response |

### 4b. The first one fails and rolls back

| # | Session A | Session B |
| --- | --- | --- |
| 1 | `BEGIN;` `INSERT ... ('k1') ... RETURNING key;` → **k1** | |
| 2 | | `BEGIN;` `INSERT ... ('k1') ... RETURNING key;` → ⏳ waits |
| 3 | `ROLLBACK;` (e.g. crash) | → **k1** (1 row): B owns the key now |
| 4 | | moves the money, `COMMIT;` |

B doesn't guess while A is undecided: it waits on the unique index until A commits or rolls back. That's why `idempotent()` claims the key **in the same transaction** as the money. The key and the money commit together, or neither does, and the test "same key ×10 in parallel → 1 transfer" passes.

---

## Summary

| Case | Problem at `READ COMMITTED` | Our fix | Where |
| --- | --- | --- | --- |
| 1 | lost update / double spend | `FOR UPDATE`, re-check under lock, `balance = balance - $1`, `CHECK (balance >= 0)` | `moveMoney()` |
| 2 | deadlock | lock `ORDER BY account_id` | `moveMoney()` |
| 3 | reads from different moments | `REPEATABLE READ` snapshot | `executeRun()` |
| 4 | duplicate request | unique key claimed in the money transaction | `idempotent()` |

Why not just use `SERIALIZABLE` everywhere? It would catch cases 1 and 3 too, but by **aborting** one transaction with a serialization error that the caller must retry. Locks make the second transfer *wait* instead, which is simpler for a hot wallet. `READ COMMITTED` + explicit locks is the standard choice for this kind of workload.
