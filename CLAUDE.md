# Rules for this repo (read by Claude Code)

- Money is always whole paise in BIGINT columns and `bigint` in TypeScript. Never float, never `parseFloat`.
- No ORM in the money path. Every query is plain SQL through `pg`.
- Every operation that moves money runs inside `withTransaction()` on one `PoolClient`. Never `pool.query()` inside a transaction.
- Lock account rows with `SELECT ... FOR UPDATE` in ascending `account_id` order.
- `ledger_entries` is append-only. Mistakes are fixed with a reversal transfer.
- Migrations in `db/migrations` are append-only: add a new file, never edit an applied one.
- Every POST requires an `Idempotency-Key` header.
- Errors always use `{code, message, request_id}`.
- Never push directly to `main`; work on a branch and open a PR.
