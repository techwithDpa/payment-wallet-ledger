# Wallet Ledger

Backend of a payments-grade digital wallet: double-entry ledger, safe concurrent transfers, idempotent payments, nightly reconciliation, fraud holds and statement Q&A.

Stack: Node 22, TypeScript, Fastify, `pg` (no ORM), PostgreSQL 16, dbmate migrations, Vitest.

## Run it

```bash
docker compose up --build
curl localhost:3000/health     # {"ok":true,"db":"up","job_locks":1}
```

This starts four containers: `db` (Postgres), `migrate` (applies `db/migrations`, then exits), `api` (port 3000) and `worker` (scheduled jobs).

## Run the tests

```bash
docker compose up -d db migrate   # database + schema
npm install
npm test
```

## Status

- [x] Step 0: skeleton, Docker Compose, first migration, CI
- [x] Milestone 1: schema (see docs/schema.md)
- [x] Milestone 2: safe transfers + stampede test
- [x] Milestone 3: idempotency
- [x] Rest of the API: users, wallets, balance, statement, withdraw, reverse, transfer details
- [ ] Milestone 4: reconciliation
- [ ] Milestone 5: fraud rules + statement Q&A
