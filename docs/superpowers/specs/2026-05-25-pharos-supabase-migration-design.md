# Pharos Supabase Migration — Design Spec

**Date:** 2026-05-25
**Author:** Ghost
**Status:** Draft for review
**Slice:** B (SQLite → Supabase Free Postgres)
**Estimated effort:** ~1 week
**Blast radius:** all DB call sites (3 stores, 53 call sites). Router/classifier/sync code untouched.

## 1. Problem

Pharos's persistent state lives in a single SQLite file at `/data/pharos.db` on a Fly volume. Wallet balances, usage history, conversation tier-floor state, rate limits, idempotency keys, API keys, and performance-learning data all sit there. Three constraints push for migration:

1. **Single-machine bottleneck.** SQLite cannot share state across processes. Pharos cannot scale horizontally on Fly until the DB is external.
2. **Operability.** Fly volumes are opaque from outside the machine. No web dashboard, no point-in-time recovery, no easy querying.
3. **Future product surfaces.** The roadmap (per project memory) includes a metrics dashboard and a user-facing wallet widget, both of which need to read from Pharos's data. External Postgres + Supabase's REST/Realtime APIs make that integration trivial.

## 2. Goals

1. All DB reads/writes go to Supabase Postgres on the free tier.
2. SQLite + `better-sqlite3` removed from the codebase.
3. Wallet correctness preserved: concurrent debits cannot double-spend.
4. Existing test count (1820) stays green against Docker-Postgres.
5. Local dev experience: `npm test` runs against a Docker Postgres container; `npm run dev` connects to a developer's Supabase project via `DATABASE_URL` env var.
6. Production rollout from feature branch first, PR + merge after smoke-test passes.

## 3. Non-goals

- Migrating existing prod data. (No real customer transactions to preserve — fresh tables on first deploy.)
- Driver toggling / SQLite fallback support. Hard cutover only.
- ORM / query builder layer. Raw SQL via `postgres.js` tagged templates.
- Connection pooler (Supavisor). Direct connection on port 5432 with client-side pool. Add pooler later if scale demands.
- Real-time subscriptions, Supabase Auth, Supabase Storage. Postgres-only.

## 4. Architecture

```
BEFORE                              AFTER
──────                              ─────
pharos-nexlabs (Fly)                pharos-nexlabs (Fly)
  └─ /data/pharos.db (SQLite)         └─ async fetch over TLS
     ├─ users                              ↓
     ├─ wallet_ledger                  Supabase Postgres (AWS, free tier)
     ├─ requests                          ├─ users
     └─ model_performance                 ├─ wallet_ledger
                                          ├─ requests
                                          └─ model_performance
```

### 4.1 Components

| Component | State | Responsibility |
|---|---|---|
| `src/tracking/wallet-store.ts` | rewrite | Async Postgres calls. `FOR UPDATE` row lock on debits. |
| `src/tracking/store.ts` | rewrite | Async append + aggregate queries for `requests` table. |
| `src/learning/performance-store.ts` | rewrite | Async upsert + aggregate queries for `model_performance`. |
| `src/db/index.ts` | **new** | Single `postgres.js` client instance, exported. |
| `db/schema.sql` | **new** | Full schema applied once via Supabase SQL editor. |
| `src/server.ts` | small edit | DB init switches from `new BetterSqlite3(path)` to `import sql from './db/index.js'`. |
| `src/instrument.ts` | small edit | Sentry DB instrumentation swap. |
| `src/__tests__/_helpers/test-db.ts` | **new** | Docker Postgres container lifecycle for tests. |
| `fly.toml` | small edit | Remove `[[mounts]]` volume mount (only after Postgres verified live). |
| `package.json` | small edit | Add `postgres` dep; remove `better-sqlite3`. |
| Router / classifier / sync / gateway routes / wallet routes / admin routes | **unchanged** | Don't touch the DB layer directly. |

### 4.2 Data flow on request

```
POST /v1/chat/completions
  ↓
authMiddleware:     await walletStore.getUserByApiKey(key)    ← ~80ms (network + lookup)
  ↓
rateLimitMiddleware:await rateLimitStore.checkAndIncrement()  ← ~50ms
  ↓
classifier + router (no DB, fast)
  ↓
beforeLLMCall:      await walletStore.debit(userId, cost)     ← ~100ms (SELECT FOR UPDATE + UPDATE in txn)
  ↓
[LLM provider call — 1-30s]
  ↓
afterResponse (parallelized via Promise.all):
                    await trackingStore.recordRequest(...)    \
                    await conversationTracker.upsertTier(...)  → ~100ms parallel
                    await performanceStore.recordSample(...)  /
```

Total added latency per request: ~250-350ms. LLM calls take 1-30s, so user-visible overhead is <5%.

### 4.3 Wallet debit semantics (the critical correctness operation)

Every wallet debit:
```sql
BEGIN;
SELECT balance_cents FROM users WHERE id = $1 FOR UPDATE;
-- application checks: if balance < cost, rollback with "insufficient balance"
UPDATE users SET balance_cents = balance_cents - $2 WHERE id = $1;
INSERT INTO wallet_ledger (user_id, txn_type, amount_cents, ...) VALUES (...);
COMMIT;
```

`FOR UPDATE` blocks any concurrent transaction trying to read the same row until this transaction commits. Postgres serializes the operations. Tested by a reproducing race test (20 concurrent debits for a user with budget for only 10 — expect exactly 10 succeed).

### 4.4 Connection management

- Single `postgres.js` client instantiated at boot in `src/db/index.ts`.
- Connection URL from `process.env.DATABASE_URL`.
- Client config: `{ max: 10, idle_timeout: 30, connect_timeout: 10 }`. 10 is generous for a single Fly machine.
- Direct connection on port 5432, not Supavisor's pooler. `postgres.js` handles client-side pooling internally.
- Graceful shutdown: `await sql.end()` on SIGTERM in `src/index.ts`.

## 5. Schema

Applied via `db/schema.sql`. Postgres equivalents of every current SQLite table, with auto-migrated columns folded in.

```sql
-- ─── Users (wallet) ───
CREATE TABLE users (
    id              bigserial   PRIMARY KEY,
    email           text        UNIQUE NOT NULL,
    stripe_customer_id text,
    pharos_api_key_hash text    NOT NULL,
    balance_cents   bigint      NOT NULL DEFAULT 0,
    daily_cap_cents bigint,
    monthly_cap_cents bigint,
    role            text        NOT NULL DEFAULT 'user',
    org_id          bigint,
    created_at      timestamptz NOT NULL DEFAULT now(),
    active          integer     NOT NULL DEFAULT 1,
    frozen          integer     NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX idx_users_api_key_hash ON users(pharos_api_key_hash);

-- ─── Wallet ledger ───
CREATE TABLE wallet_ledger (
    id              bigserial   PRIMARY KEY,
    user_id         bigint      NOT NULL REFERENCES users(id),
    txn_type        text        NOT NULL,
    amount_cents    bigint      NOT NULL,
    model           text,
    provider        text,
    modality        text,
    policy          text,
    tokens_in       bigint,
    tokens_out      bigint,
    request_id      text,
    stripe_event_id text,
    ts              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ledger_user_ts ON wallet_ledger(user_id, ts DESC);
CREATE INDEX idx_ledger_request ON wallet_ledger(request_id)
    WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX idx_ledger_stripe_event ON wallet_ledger(stripe_event_id)
    WHERE stripe_event_id IS NOT NULL;
CREATE UNIQUE INDEX idx_ledger_idempotency ON wallet_ledger(request_id, txn_type)
    WHERE request_id IS NOT NULL;

-- ─── Requests (tracking) ───
CREATE TABLE requests (
    id                          text        PRIMARY KEY,
    timestamp                   text        NOT NULL,
    tier                        text        NOT NULL,
    provider                    text        NOT NULL,
    model                       text        NOT NULL,
    classification_score        integer     NOT NULL,
    classification_type         text        NOT NULL,
    classification_latency_ms   integer     NOT NULL,
    classifier_provider         text        DEFAULT 'unknown',
    tokens_in                   integer     NOT NULL DEFAULT 0,
    tokens_out                  integer     NOT NULL DEFAULT 0,
    estimated_cost              double precision NOT NULL DEFAULT 0,
    baseline_cost               double precision NOT NULL DEFAULT 0,
    savings                     double precision NOT NULL DEFAULT 0,
    total_latency_ms            integer     NOT NULL DEFAULT 0,
    provider_latency_ms         integer,
    stream                      integer     NOT NULL DEFAULT 0,
    is_direct_route             integer     NOT NULL DEFAULT 0,
    status                      text        DEFAULT 'success',
    error_message               text,
    user_message_preview        text,
    debug_input                 text,
    debug_output                text,
    agent_id                    text,
    conversation_id             text,
    retry_count                 integer     DEFAULT 0
);

CREATE INDEX idx_requests_timestamp ON requests(timestamp);
CREATE INDEX idx_requests_tier ON requests(tier);
CREATE INDEX idx_requests_provider ON requests(provider);
CREATE INDEX idx_requests_classifier_provider ON requests(classifier_provider);
CREATE INDEX idx_requests_status ON requests(status);
CREATE INDEX idx_requests_agent_id ON requests(agent_id);

-- ─── Model performance learning ───
CREATE TABLE model_performance (
    provider            text        NOT NULL,
    model               text        NOT NULL,
    task_type           text        NOT NULL,
    success_count       bigint      NOT NULL DEFAULT 0,
    error_count         bigint      NOT NULL DEFAULT 0,
    total_latency_ms    bigint      NOT NULL DEFAULT 0,
    last_updated        text        NOT NULL,
    PRIMARY KEY (provider, model, task_type)
);
```

Discovery during implementation may reveal additional tables (rate-limit counters in memory or DB? idempotency tables outside `wallet_ledger`?). If found, port using the same conventions.

## 6. Configuration

### 6.1 Environment variables

```
# Required in prod
DATABASE_URL=postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres

# In tests, set by the Docker helper at runtime — no .env entry needed.
```

### 6.2 `package.json`

```diff
- "better-sqlite3": "^11.8.0"
+ "postgres": "^3.4.4"
```

### 6.3 `fly.toml`

```diff
-[[mounts]]
-  source = "pharos_data"
-  destination = "/app/data"
```

This change applies in the **final** verification step, NOT during initial deploy. Volume stays mounted during the cutover so a rollback can re-read the old SQLite file if needed.

## 7. Testing

### 7.1 Test infrastructure

**`src/__tests__/_helpers/test-db.ts`** (new):
- Boots `postgres:16-alpine` Docker container on a random free port
- Applies `db/schema.sql`
- Returns connection URL
- Exposes `truncateAll()` for `beforeEach` resets
- Exposes `stop()` for `afterAll`

Vitest's `globalSetup` runs the container once for the whole suite (not per file) — startup cost amortized.

### 7.2 New test — wallet race

`src/__tests__/wallet/race.test.ts`:
```ts
it('serializes concurrent debits — no double-spend', async () => {
    const user = await walletStore.createUser({ email: 'r@x', balanceCents: 1000 });
    const debits = Array.from({ length: 20 }, () =>
        walletStore.debit(user.id, 100, 'chat', { provider: 'test', model: 't' }),
    );
    const results = await Promise.allSettled(debits);
    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    expect(succeeded).toBe(10);
    expect(await walletStore.getBalance(user.id)).toBe(0);
});
```
Written first. Fails without `FOR UPDATE` lock. Drives the implementation.

### 7.3 Existing test migration

Every `src/__tests__/wallet-*.test.ts`, `tracking-*.test.ts`, `performance-*.test.ts`, and any integration test that exercises stores → switches to `await`-style and uses the helper's URL. Assertions unchanged.

### 7.4 Verification gates before merge

1. `npm test` — all green against Docker Postgres (target: 1820+ passing, including the new race test)
2. `npm run lint` — clean
3. `npm run build` — clean
4. Deploy from `slice-b-supabase-migration` branch to `pharos-nexlabs`
5. Smoke: hit `/health`; hit `/v1/chat/completions` with `pharos-auto` (verifies wallet read, debit, usage record)
6. Hit `/v1/credits` with operator key (verifies basic wallet read)
7. Inspect Supabase dashboard: `users` table has at least the operator row; `wallet_ledger` has at least one txn from the smoke test; `requests` has at least one row from the smoke test

### 7.5 Goal verification

End-to-end probe: real chat completion in prod inserts a `requests` row and a `wallet_ledger` row visible in Supabase's table editor.

## 8. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Wallet correctness regression | Medium | Race test written first; `FOR UPDATE` lock enforces serialization |
| Async-fanout introduces unawaited promises | Medium | TypeScript `no-floating-promises` lint rule + careful code review; full test suite catches most |
| Supabase free-tier latency hurts UX | Low | LLM calls dwarf DB latency (1-30s vs +250-350ms total) |
| Supabase project pauses after 7d inactivity | Low | Pharos serves 24/7 — never idle; King Tut canary keeps traffic alive |
| `postgres.js` connection pool exhaustion on burst | Low | `max: 10` is generous for one Fly machine; can raise if metrics warrant |
| Docker not running on dev machine when running `npm test` | Medium | Test helper produces a clear error: "Start Docker Desktop and retry" |

## 9. Deployment plan

1. User creates a Supabase free-tier project; provides connection URL.
2. Controller applies `db/schema.sql` to the project (one-shot, via Supabase SQL editor or `psql`).
3. Controller sets Fly secret: `flyctl secrets set DATABASE_URL=<url> -a pharos-nexlabs`.
4. Controller pushes `slice-b-supabase-migration` branch and runs `fly deploy` from it.
5. Smoke tests (see §7.4).
6. If green: open PR; merge to main.
7. After 24h of clean prod operation: remove `[[mounts]]` from `fly.toml`, redeploy, run `fly volumes destroy pharos_data`.

### 9.1 Rollback

```
git checkout e8391b6           # Slice A merge commit (last SQLite)
flyctl deploy --app pharos-nexlabs
```
SQLite file still exists on the volume (mount still present until §9 step 7). ~3 minutes back to known-good.

## 10. Open questions

- None blocking implementation. `DATABASE_URL` provided by user at deploy time.

## 11. Out-of-scope follow-ups

- Multi-region Pharos: now technically possible (external DB) but not addressed here.
- Supabase Realtime for dashboard live updates.
- Connection pooler (Supavisor) when concurrency demands it.
- ORM layer if query complexity grows.
- Data archival of old `requests` rows (the table will grow unboundedly).
