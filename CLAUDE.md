# Rules for this repo (read by Claude Code)

## Start of every session
1. Read `docs/PLAN.md` (stack, decisions, API, acceptance tests) and the top of `docs/PROGRESS.md` (where we stopped).
2. The developer is a beginner learning as they build: explain the why in plain words, keep changes small, and let them type the money path (transfer function, SQL checks) themselves when they ask to learn it.
3. At the end of a step: run `npm test`, commit on a branch, and add an entry at the top of `docs/PROGRESS.md`.

## Money rules

- Money is always whole paise in BIGINT columns and `bigint` in TypeScript. Never float, never `parseFloat`.
- No ORM in the money path. Every query is plain SQL through `pg`.
- Every operation that moves money runs inside `withTransaction()` on one `PoolClient`. Never `pool.query()` inside a transaction.
- Lock account rows with `SELECT ... FOR UPDATE` in ascending `account_id` order.
- `ledger_entries` is append-only. Mistakes are fixed with a reversal transfer.
- Migrations in `db/migrations` are append-only: add a new file, never edit an applied one.
- Every POST requires an `Idempotency-Key` header.
- Errors always use `{code, message, request_id}`.
- Never push directly to `main`; work on a branch and open a PR.
