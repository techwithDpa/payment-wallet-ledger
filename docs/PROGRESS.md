# Progress log

Newest first. At the end of every working session, add: what was done, what's next, anything surprising.

## 2026-10-24 02:10 — Step 0 done
- Done: repo skeleton, Docker Compose (db, migrate, api, worker), first migration (`job_locks`), `GET /health`, `withTransaction()` helper, error shape, 4 passing tests, CI workflow.
- Verified: migration + tests + API + worker against Postgres 16. `docker compose up` itself still to be verified on the laptop.
- Next: push to GitHub and confirm CI is green, then **Step 1: schema migrations** (see docs/PLAN.md "Schema decisions") + `docs/schema.md`.
