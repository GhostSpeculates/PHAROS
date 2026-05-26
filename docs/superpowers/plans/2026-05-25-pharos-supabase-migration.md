# Pharos Supabase Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SQLite (better-sqlite3) with Supabase Postgres for all persistent state. Hard cutover, no driver toggling. Wallet correctness preserved via `FOR UPDATE` row locking.

**Architecture:** New `src/db/index.ts` exports a singleton `postgres.js` client. Three existing stores (`WalletStore`, `TrackingStore`, `PerformanceStore`) are rewritten from synchronous SQLite to async Postgres. Schema in `db/schema.sql` applied once via Supabase. Tests run against a Docker Postgres container booted by a Vitest `globalSetup` helper. No data migration — fresh tables.

**Tech Stack:** `postgres` (postgres.js v3), Postgres 16 (Supabase + local Docker), Vitest, TypeScript ESM.

**Spec reference:** [docs/superpowers/specs/2026-05-25-pharos-supabase-migration-design.md](../specs/2026-05-25-pharos-supabase-migration-design.md)

---

## File Structure

**New files:**
- `db/schema.sql` — full Postgres schema (users, wallet_ledger, requests, model_performance)
- `src/db/index.ts` — `postgres.js` client singleton, exported as `sql`
- `src/__tests__/_helpers/test-db.ts` — Docker Postgres container lifecycle + truncate helper
- `src/__tests__/_helpers/global-setup.ts` — Vitest `globalSetup` entrypoint that boots the container
- `vitest.config.ts` — sets `globalSetup` and shared test config
- `src/__tests__/wallet/race.test.ts` — concurrent-debit race-condition test

**Rewritten:**
- `src/tracking/wallet-store.ts` — sync SQLite → async Postgres; `FOR UPDATE` lock on debits
- `src/tracking/store.ts` — sync → async; same surface API
- `src/learning/performance-store.ts` — sync → async

**Modified:**
- `src/server.ts` — DB init switches to `postgres.js` client; consumers awaited
- `src/instrument.ts` — Sentry integration swap
- `src/index.ts` — graceful shutdown calls `await sql.end()`
- `package.json` — add `postgres`, remove `better-sqlite3`
- `fly.toml` — remove `[[mounts]]` block (final task, after verification)

---

## Task 1: Install postgres.js, set up DATABASE_URL

**Files:**
- Modify: `package.json`
- Modify: `.env.example`

- [ ] **Step 1: Install postgres dependency**

```bash
npm install postgres
```

Verify it landed in `package.json` dependencies:
```bash
grep '"postgres"' package.json
```
Expected: `"postgres": "^3.x.x"` line present.

- [ ] **Step 2: Append DATABASE_URL placeholder to .env.example**

Add at the end of `.env.example`:

```
# Supabase Postgres (Slice B)
DATABASE_URL=postgresql://postgres:[YOUR-PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json .env.example
git commit -m "$(cat <<'EOF'
feat(deps): install postgres.js for Slice B migration

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Write the full Postgres schema

**Files:**
- Create: `db/schema.sql`

- [ ] **Step 1: Create db/ directory and schema file**

```bash
mkdir -p db
```

Then create `db/schema.sql` with this content:

```sql
-- Pharos Postgres schema (Slice B migration target)
-- Apply once per Supabase project via SQL editor.

-- ─── Users (wallet) ───
CREATE TABLE IF NOT EXISTS users (
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_api_key_hash ON users(pharos_api_key_hash);

-- ─── Wallet ledger ───
CREATE TABLE IF NOT EXISTS wallet_ledger (
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
CREATE INDEX IF NOT EXISTS idx_ledger_user_ts ON wallet_ledger(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_request ON wallet_ledger(request_id)
    WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_stripe_event ON wallet_ledger(stripe_event_id)
    WHERE stripe_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_idempotency ON wallet_ledger(request_id, txn_type)
    WHERE request_id IS NOT NULL;

-- ─── Requests (tracking) ───
CREATE TABLE IF NOT EXISTS requests (
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
CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp);
CREATE INDEX IF NOT EXISTS idx_requests_tier ON requests(tier);
CREATE INDEX IF NOT EXISTS idx_requests_provider ON requests(provider);
CREATE INDEX IF NOT EXISTS idx_requests_classifier_provider ON requests(classifier_provider);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_agent_id ON requests(agent_id);

-- ─── Model performance learning ───
CREATE TABLE IF NOT EXISTS model_performance (
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

- [ ] **Step 2: Commit**

```bash
git add db/schema.sql
git commit -m "$(cat <<'EOF'
feat(db): add Postgres schema for Slice B

Mirrors current SQLite tables (users, wallet_ledger, requests,
model_performance) with all auto-migrated columns folded in.
Applied once per Supabase project via SQL editor.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Create the postgres.js client singleton

**Files:**
- Create: `src/db/index.ts`
- Create: `src/__tests__/db/client.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/__tests__/db/client.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { getSql } from '../../db/index.js';

describe('postgres client', () => {
    it('exports a getSql() factory that requires DATABASE_URL', () => {
        const prev = process.env.DATABASE_URL;
        delete process.env.DATABASE_URL;
        expect(() => getSql()).toThrow(/DATABASE_URL/);
        if (prev) process.env.DATABASE_URL = prev;
    });

    it('returns a tagged-template sql client when DATABASE_URL is set', () => {
        process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
        const sql = getSql();
        expect(typeof sql).toBe('function');
        // postgres.js clients expose .end() for graceful shutdown
        expect(typeof (sql as any).end).toBe('function');
    });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npx vitest run src/__tests__/db/client.test.ts
```
Expected: FAIL — module `../../db/index.js` not found.

- [ ] **Step 3: Create src/db/index.ts**

```typescript
import postgres from 'postgres';

let client: ReturnType<typeof postgres> | null = null;

/**
 * Lazy singleton accessor for the Postgres client.
 * Throws if DATABASE_URL is unset so tests can detect misconfiguration.
 */
export function getSql(): ReturnType<typeof postgres> {
    if (client) return client;
    const url = process.env.DATABASE_URL;
    if (!url) {
        throw new Error('DATABASE_URL is not set');
    }
    client = postgres(url, {
        max: 10,
        idle_timeout: 30,
        connect_timeout: 10,
    });
    return client;
}

/** For tests — close the pool and clear the singleton. */
export async function resetSql(): Promise<void> {
    if (client) {
        await client.end();
        client = null;
    }
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
npx vitest run src/__tests__/db/client.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/index.ts src/__tests__/db/client.test.ts
git commit -m "$(cat <<'EOF'
feat(db): postgres.js client singleton with lazy DATABASE_URL check

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Docker Postgres test helper

**Files:**
- Create: `src/__tests__/_helpers/test-db.ts`
- Create: `src/__tests__/_helpers/global-setup.ts`
- Create: `vitest.config.ts`

- [ ] **Step 1: Verify Docker is running**

```bash
docker ps
```
Expected: command succeeds (no daemon error). If "Cannot connect to the Docker daemon" — start Docker Desktop and retry. Do NOT proceed until Docker daemon is up.

- [ ] **Step 2: Create the test helper**

Create `src/__tests__/_helpers/test-db.ts`:

```typescript
import { spawnSync, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';

const CONTAINER_NAME = 'pharos-test-postgres';
const POSTGRES_PORT = 54329; // arbitrary free port to avoid conflicts
const POSTGRES_PASSWORD = 'pharos_test';

function run(cmd: string, args: string[]): { code: number; stdout: string; stderr: string } {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export async function startTestPostgres(): Promise<string> {
    // Clean any leftover container
    run('docker', ['rm', '-f', CONTAINER_NAME]);

    // Boot container
    const startResult = run('docker', [
        'run', '-d',
        '--name', CONTAINER_NAME,
        '-p', `${POSTGRES_PORT}:5432`,
        '-e', `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
        '-e', 'POSTGRES_DB=pharos_test',
        'postgres:16-alpine',
    ]);
    if (startResult.code !== 0) {
        throw new Error(`Failed to start Docker Postgres: ${startResult.stderr}`);
    }

    const url = `postgresql://postgres:${POSTGRES_PASSWORD}@localhost:${POSTGRES_PORT}/pharos_test`;

    // Wait for Postgres to be ready (poll pg_isready inside the container)
    for (let i = 0; i < 30; i++) {
        const ready = run('docker', ['exec', CONTAINER_NAME, 'pg_isready', '-U', 'postgres']);
        if (ready.code === 0) break;
        await new Promise(r => setTimeout(r, 500));
        if (i === 29) throw new Error('Postgres did not become ready within 15s');
    }

    // Apply schema
    const schemaPath = resolve(process.cwd(), 'db/schema.sql');
    const schemaSql = await fs.readFile(schemaPath, 'utf8');
    const applyResult = spawnSync('docker', [
        'exec', '-i', CONTAINER_NAME, 'psql', '-U', 'postgres', '-d', 'pharos_test',
    ], { input: schemaSql, encoding: 'utf8' });
    if (applyResult.status !== 0) {
        throw new Error(`Failed to apply schema: ${applyResult.stderr}`);
    }

    return url;
}

export function stopTestPostgres(): void {
    run('docker', ['rm', '-f', CONTAINER_NAME]);
}

export async function truncateAll(sqlClient: any): Promise<void> {
    await sqlClient`TRUNCATE TABLE wallet_ledger, requests, model_performance, users RESTART IDENTITY CASCADE`;
}
```

- [ ] **Step 3: Create the Vitest globalSetup entrypoint**

Create `src/__tests__/_helpers/global-setup.ts`:

```typescript
import { startTestPostgres, stopTestPostgres } from './test-db.js';

export async function setup(): Promise<void> {
    const url = await startTestPostgres();
    process.env.DATABASE_URL = url;
    console.log(`[test-db] Postgres ready at ${url}`);
}

export async function teardown(): Promise<void> {
    stopTestPostgres();
}
```

- [ ] **Step 4: Create vitest.config.ts**

If `vitest.config.ts` does not exist, create:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globalSetup: './src/__tests__/_helpers/global-setup.ts',
        testTimeout: 30_000,
        hookTimeout: 30_000,
    },
});
```

If `vitest.config.ts` already exists, add the three test-level keys (`globalSetup`, `testTimeout`, `hookTimeout`) inside the existing `test:` block.

- [ ] **Step 5: Sanity check — run an empty test file uses the container**

Create temp file `src/__tests__/_helpers/smoke.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import postgres from 'postgres';

describe('test-db smoke', () => {
    it('connects to the Docker Postgres', async () => {
        const sql = postgres(process.env.DATABASE_URL!);
        const [row] = await sql`SELECT 1 as one`;
        expect(row.one).toBe(1);
        await sql.end();
    });
});
```

Run:
```bash
npx vitest run src/__tests__/_helpers/smoke.test.ts
```
Expected: PASS. Docker container boots, schema applies, query succeeds.

- [ ] **Step 6: Delete the smoke test file (no longer needed)**

```bash
rm src/__tests__/_helpers/smoke.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add src/__tests__/_helpers/test-db.ts src/__tests__/_helpers/global-setup.ts vitest.config.ts
git commit -m "$(cat <<'EOF'
test(infra): Docker Postgres helper for Slice B integration tests

Vitest globalSetup boots a postgres:16-alpine container on port 54329,
applies db/schema.sql, exposes truncateAll() for per-test resets.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wallet race-condition test (TDD: drives FOR UPDATE locking)

**Files:**
- Create: `src/__tests__/wallet/race.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/wallet/race.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import postgres from 'postgres';
import { WalletStore } from '../../tracking/wallet-store.js';
import { truncateAll } from '../_helpers/test-db.js';
import type { Logger } from '../../utils/logger.js';

const silentLogger = {
    info: () => {}, warn: () => {}, error: () => {},
    debug: () => {}, fatal: () => {}, trace: () => {},
    child: function () { return this; },
} as unknown as Logger;

describe('wallet race conditions', () => {
    let sql: ReturnType<typeof postgres>;
    let store: WalletStore;

    beforeEach(async () => {
        sql = postgres(process.env.DATABASE_URL!);
        await truncateAll(sql);
        store = new WalletStore({ sql, logger: silentLogger });
    });

    it('serializes concurrent debits — no double-spend', async () => {
        const user = await store.createUser({
            email: 'race@x.com',
            apiKeyHash: 'h1',
            balanceCents: 1000,
        });

        // 20 concurrent debits of 100 cents each, budget for 10
        const debits = Array.from({ length: 20 }, (_, i) =>
            store.debit({
                userId: user.id,
                amountCents: 100,
                txnType: 'chat',
                model: 'test',
                provider: 'test',
                requestId: `req-${i}`,
            }),
        );

        const results = await Promise.allSettled(debits);
        const succeeded = results.filter(r => r.status === 'fulfilled').length;
        expect(succeeded).toBe(10);
        expect(await store.getBalanceCents(user.id)).toBe(0);

        await sql.end();
    });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npx vitest run src/__tests__/wallet/race.test.ts
```
Expected: FAIL — `WalletStore` constructor signature mismatch (still expects the old sync sqlite constructor). This is the red baseline; Task 6 makes it green.

- [ ] **Step 3: Commit the failing test**

```bash
git add src/__tests__/wallet/race.test.ts
git commit -m "$(cat <<'EOF'
test(wallet): failing race-condition test drives FOR UPDATE locking

20 concurrent debits with budget for 10 — expect exactly 10 to succeed,
final balance to be 0. Fails today because WalletStore is sync sqlite;
Task 6 rewrites it to async Postgres with row-level locking.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Rewrite WalletStore as async Postgres + FOR UPDATE

**Files:**
- Modify: `src/tracking/wallet-store.ts` (full rewrite)

- [ ] **Step 1: Read the current WalletStore to map every public method's signature**

```bash
grep -n "^\s*\(public \|private \|async \|static \|/\*\*\|//\)" /Users/ghostfx/PHAROS/src/tracking/wallet-store.ts | head -40
```
Note every public method name. The new async API must preserve method names and return shapes (modulo `Promise<T>` wrapping). Constructor signature changes to take `{ sql, logger }` instead of `{ dbPath, logger }`.

- [ ] **Step 2: Rewrite `src/tracking/wallet-store.ts`**

Replace the entire file contents. Preserve the static `hashApiKey()` helper and all public method names. Constructor takes `{ sql, logger }`. Every method becomes `async`.

```typescript
import crypto from 'node:crypto';
import type { Sql } from 'postgres';
import type { Logger } from '../utils/logger.js';

export interface WalletStoreOptions {
    sql: Sql;
    logger: Logger;
}

export interface User {
    id: number;
    email: string;
    stripeCustomerId: string | null;
    pharosApiKeyHash: string;
    balanceCents: number;
    dailyCapCents: number | null;
    monthlyCapCents: number | null;
    role: string;
    orgId: number | null;
    createdAt: Date;
    active: number;
    frozen: number;
}

export interface CreateUserInput {
    email: string;
    apiKeyHash: string;
    balanceCents?: number;
    stripeCustomerId?: string;
}

export interface DebitInput {
    userId: number;
    amountCents: number;
    txnType: string;
    model?: string;
    provider?: string;
    modality?: string;
    policy?: string;
    tokensIn?: number;
    tokensOut?: number;
    requestId?: string;
}

export interface CreditInput {
    userId: number;
    amountCents: number;
    stripeEventId?: string;
}

export class WalletStore {
    private sql: Sql;
    private logger: Logger;

    constructor(opts: WalletStoreOptions) {
        this.sql = opts.sql;
        this.logger = opts.logger;
    }

    /** Hash an API key (sha256 hex) for storage / lookup. */
    static hashApiKey(rawKey: string): string {
        return crypto.createHash('sha256').update(rawKey).digest('hex');
    }

    async getUserByEmail(email: string): Promise<User | undefined> {
        const rows = await this.sql<User[]>`
            SELECT id, email, stripe_customer_id AS "stripeCustomerId",
                   pharos_api_key_hash AS "pharosApiKeyHash",
                   balance_cents AS "balanceCents",
                   daily_cap_cents AS "dailyCapCents",
                   monthly_cap_cents AS "monthlyCapCents",
                   role, org_id AS "orgId", created_at AS "createdAt",
                   active, frozen
            FROM users WHERE email = ${email}
        `;
        return rows[0];
    }

    async getUserByApiKeyHash(hash: string): Promise<User | undefined> {
        const rows = await this.sql<User[]>`
            SELECT id, email, stripe_customer_id AS "stripeCustomerId",
                   pharos_api_key_hash AS "pharosApiKeyHash",
                   balance_cents AS "balanceCents",
                   daily_cap_cents AS "dailyCapCents",
                   monthly_cap_cents AS "monthlyCapCents",
                   role, org_id AS "orgId", created_at AS "createdAt",
                   active, frozen
            FROM users WHERE pharos_api_key_hash = ${hash} AND active = 1
        `;
        return rows[0];
    }

    async createUser(input: CreateUserInput): Promise<User> {
        const balanceCents = input.balanceCents ?? 0;
        const [row] = await this.sql<User[]>`
            INSERT INTO users (email, pharos_api_key_hash, balance_cents, stripe_customer_id)
            VALUES (${input.email}, ${input.apiKeyHash}, ${balanceCents}, ${input.stripeCustomerId ?? null})
            RETURNING id, email, stripe_customer_id AS "stripeCustomerId",
                      pharos_api_key_hash AS "pharosApiKeyHash",
                      balance_cents AS "balanceCents",
                      daily_cap_cents AS "dailyCapCents",
                      monthly_cap_cents AS "monthlyCapCents",
                      role, org_id AS "orgId", created_at AS "createdAt",
                      active, frozen
        `;
        return row;
    }

    async getUserById(id: number): Promise<User | undefined> {
        const rows = await this.sql<User[]>`
            SELECT id, email, stripe_customer_id AS "stripeCustomerId",
                   pharos_api_key_hash AS "pharosApiKeyHash",
                   balance_cents AS "balanceCents",
                   daily_cap_cents AS "dailyCapCents",
                   monthly_cap_cents AS "monthlyCapCents",
                   role, org_id AS "orgId", created_at AS "createdAt",
                   active, frozen
            FROM users WHERE id = ${id}
        `;
        return rows[0];
    }

    async getBalanceCents(userId: number): Promise<number> {
        const rows = await this.sql<{ balance: number }[]>`
            SELECT balance_cents AS balance FROM users WHERE id = ${userId}
        `;
        return rows[0]?.balance ?? 0;
    }

    /**
     * Atomic wallet debit. Uses SELECT FOR UPDATE to serialize concurrent
     * debits against the same user, preventing double-spend.
     *
     * Throws `Error('insufficient balance')` if balance < amountCents.
     * Throws `Error('user frozen')` if user.frozen = 1.
     */
    async debit(input: DebitInput): Promise<void> {
        await this.sql.begin(async (tx) => {
            const [row] = await tx<{ balanceCents: number; frozen: number }[]>`
                SELECT balance_cents AS "balanceCents", frozen
                FROM users WHERE id = ${input.userId}
                FOR UPDATE
            `;
            if (!row) throw new Error('user not found');
            if (row.frozen === 1) throw new Error('user frozen');
            if (row.balanceCents < input.amountCents) {
                throw new Error('insufficient balance');
            }
            await tx`
                UPDATE users SET balance_cents = balance_cents - ${input.amountCents}
                WHERE id = ${input.userId}
            `;
            await tx`
                INSERT INTO wallet_ledger (
                    user_id, txn_type, amount_cents, model, provider, modality,
                    policy, tokens_in, tokens_out, request_id
                ) VALUES (
                    ${input.userId}, ${input.txnType}, ${-input.amountCents},
                    ${input.model ?? null}, ${input.provider ?? null}, ${input.modality ?? null},
                    ${input.policy ?? null}, ${input.tokensIn ?? null}, ${input.tokensOut ?? null},
                    ${input.requestId ?? null}
                )
            `;
        });
    }

    async credit(input: CreditInput): Promise<void> {
        await this.sql.begin(async (tx) => {
            await tx`
                UPDATE users SET balance_cents = balance_cents + ${input.amountCents}
                WHERE id = ${input.userId}
            `;
            await tx`
                INSERT INTO wallet_ledger (user_id, txn_type, amount_cents, stripe_event_id)
                VALUES (${input.userId}, 'credit', ${input.amountCents}, ${input.stripeEventId ?? null})
            `;
        });
    }

    async rotateApiKey(userId: number, newHash: string): Promise<void> {
        await this.sql`UPDATE users SET pharos_api_key_hash = ${newHash} WHERE id = ${userId}`;
    }

    async setFrozen(userId: number, frozen: boolean): Promise<void> {
        await this.sql`UPDATE users SET frozen = ${frozen ? 1 : 0} WHERE id = ${userId}`;
    }
}
```

If the original `WalletStore` had additional public methods (`getUsage`, `getCredits`, `listUsers`, etc.), add async equivalents preserving signatures. Refer to the original file via `git show e8391b6:src/tracking/wallet-store.ts` if needed.

- [ ] **Step 3: Run the race test, verify it now passes**

```bash
npx vitest run src/__tests__/wallet/race.test.ts
```
Expected: PASS (1 test). 10/20 debits succeed, balance ends at 0.

- [ ] **Step 4: Run the broader wallet test suite, fix any failures**

```bash
npx vitest run src/__tests__/wallet 2>&1 | tail -30
```

For each failing existing wallet test:
- Constructor call changes from `new WalletStore({ dbPath, logger })` → `new WalletStore({ sql, logger })` where `sql = postgres(process.env.DATABASE_URL!)`
- Every assertion stays the same; just `await` the calls
- Add `beforeEach(async () => await truncateAll(sql))` to isolate state

- [ ] **Step 5: Commit**

```bash
git add src/tracking/wallet-store.ts src/__tests__/wallet
git commit -m "$(cat <<'EOF'
feat(wallet): async Postgres WalletStore with FOR UPDATE locking

Race test passes: 20 concurrent debits with budget for 10 → exactly
10 succeed, balance ends at 0. Existing wallet tests updated to use
the new async API and Docker Postgres test fixture.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Rewrite TrackingStore as async

**Files:**
- Modify: `src/tracking/store.ts` (full rewrite)
- Modify: existing tracking tests under `src/__tests__/`

- [ ] **Step 1: List existing TrackingStore public methods**

```bash
grep -n "^\s*\(public \|async \|/\*\*\)" /Users/ghostfx/PHAROS/src/tracking/store.ts | head -30
```
Preserve every public method name; promote returns to `Promise<T>`. The current store has methods like `recordRequest`, `getStats`, `getRecent`, `getByRequestId`.

- [ ] **Step 2: Rewrite `src/tracking/store.ts`**

```typescript
import type { Sql } from 'postgres';
import type { Logger } from '../utils/logger.js';

export interface TrackingStoreOptions {
    sql: Sql;
    logger: Logger;
}

export interface RequestRecord {
    id: string;
    timestamp: string;
    tier: string;
    provider: string;
    model: string;
    classificationScore: number;
    classificationType: string;
    classificationLatencyMs: number;
    classifierProvider: string;
    tokensIn: number;
    tokensOut: number;
    estimatedCost: number;
    baselineCost: number;
    savings: number;
    totalLatencyMs: number;
    providerLatencyMs: number | null;
    stream: number;
    isDirectRoute: number;
    status: string;
    errorMessage: string | null;
    userMessagePreview: string | null;
    debugInput: string | null;
    debugOutput: string | null;
    agentId: string | null;
    conversationId: string | null;
    retryCount: number;
}

export class TrackingStore {
    private sql: Sql;
    private logger: Logger;

    constructor(opts: TrackingStoreOptions) {
        this.sql = opts.sql;
        this.logger = opts.logger;
    }

    async recordRequest(rec: Omit<RequestRecord, never>): Promise<void> {
        await this.sql`
            INSERT INTO requests (
                id, timestamp, tier, provider, model,
                classification_score, classification_type, classification_latency_ms,
                classifier_provider, tokens_in, tokens_out, estimated_cost,
                baseline_cost, savings, total_latency_ms, provider_latency_ms,
                stream, is_direct_route, status, error_message,
                user_message_preview, debug_input, debug_output,
                agent_id, conversation_id, retry_count
            ) VALUES (
                ${rec.id}, ${rec.timestamp}, ${rec.tier}, ${rec.provider}, ${rec.model},
                ${rec.classificationScore}, ${rec.classificationType}, ${rec.classificationLatencyMs},
                ${rec.classifierProvider}, ${rec.tokensIn}, ${rec.tokensOut}, ${rec.estimatedCost},
                ${rec.baselineCost}, ${rec.savings}, ${rec.totalLatencyMs}, ${rec.providerLatencyMs},
                ${rec.stream}, ${rec.isDirectRoute}, ${rec.status}, ${rec.errorMessage},
                ${rec.userMessagePreview}, ${rec.debugInput}, ${rec.debugOutput},
                ${rec.agentId}, ${rec.conversationId}, ${rec.retryCount}
            )
        `;
    }

    async getByRequestId(id: string): Promise<RequestRecord | undefined> {
        const rows = await this.sql<RequestRecord[]>`
            SELECT id, timestamp, tier, provider, model,
                   classification_score AS "classificationScore",
                   classification_type AS "classificationType",
                   classification_latency_ms AS "classificationLatencyMs",
                   classifier_provider AS "classifierProvider",
                   tokens_in AS "tokensIn", tokens_out AS "tokensOut",
                   estimated_cost AS "estimatedCost", baseline_cost AS "baselineCost",
                   savings, total_latency_ms AS "totalLatencyMs",
                   provider_latency_ms AS "providerLatencyMs",
                   stream, is_direct_route AS "isDirectRoute",
                   status, error_message AS "errorMessage",
                   user_message_preview AS "userMessagePreview",
                   debug_input AS "debugInput", debug_output AS "debugOutput",
                   agent_id AS "agentId", conversation_id AS "conversationId",
                   retry_count AS "retryCount"
            FROM requests WHERE id = ${id}
        `;
        return rows[0];
    }

    async getRecent(limit = 100): Promise<RequestRecord[]> {
        return this.sql<RequestRecord[]>`
            SELECT id, timestamp, tier, provider, model,
                   classification_score AS "classificationScore",
                   classification_type AS "classificationType",
                   classification_latency_ms AS "classificationLatencyMs",
                   classifier_provider AS "classifierProvider",
                   tokens_in AS "tokensIn", tokens_out AS "tokensOut",
                   estimated_cost AS "estimatedCost", baseline_cost AS "baselineCost",
                   savings, total_latency_ms AS "totalLatencyMs",
                   provider_latency_ms AS "providerLatencyMs",
                   stream, is_direct_route AS "isDirectRoute",
                   status, error_message AS "errorMessage",
                   user_message_preview AS "userMessagePreview",
                   debug_input AS "debugInput", debug_output AS "debugOutput",
                   agent_id AS "agentId", conversation_id AS "conversationId",
                   retry_count AS "retryCount"
            FROM requests ORDER BY timestamp DESC LIMIT ${limit}
        `;
    }

    async getStats(): Promise<{ totalRequests: number; totalSavings: number; totalCost: number }> {
        const [row] = await this.sql<{ count: number; savings: number; cost: number }[]>`
            SELECT COUNT(*)::int AS count,
                   COALESCE(SUM(savings), 0)::float AS savings,
                   COALESCE(SUM(estimated_cost), 0)::float AS cost
            FROM requests
        `;
        return {
            totalRequests: row.count,
            totalSavings: row.savings,
            totalCost: row.cost,
        };
    }
}
```

If the original store had additional methods (e.g. `getByAgent`, `getByConversation`, `purgeOlderThan`), add async equivalents.

- [ ] **Step 3: Update existing tracking tests**

For each file matching `src/__tests__/tracking-*.test.ts` or any test importing `TrackingStore`:
- Replace `new TrackingStore({ dbPath, logger })` with `new TrackingStore({ sql, logger })` where `sql = postgres(process.env.DATABASE_URL!)`
- Add `beforeEach(() => truncateAll(sql))`
- `await` every store call
- After tests: `afterAll(() => sql.end())`

- [ ] **Step 4: Run tracking tests, verify green**

```bash
npx vitest run src/__tests__ -t "tracking" 2>&1 | tail -10
```
Expected: all tracking tests pass against Postgres.

- [ ] **Step 5: Commit**

```bash
git add src/tracking/store.ts src/__tests__
git commit -m "$(cat <<'EOF'
feat(tracking): async Postgres TrackingStore

Append-only requests table reads + writes go async. All existing
tracking tests updated to use Docker Postgres fixture.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Rewrite PerformanceStore as async

**Files:**
- Modify: `src/learning/performance-store.ts` (full rewrite)
- Modify: existing performance tests

- [ ] **Step 1: List existing PerformanceStore public methods**

```bash
grep -n "^\s*\(public \|async \|/\*\*\)" /Users/ghostfx/PHAROS/src/learning/performance-store.ts | head -20
```
Preserve every public method name; promote returns to `Promise<T>`. The current store has methods like `recordSample`, `getByTaskType`, `getAll`.

- [ ] **Step 2: Rewrite `src/learning/performance-store.ts`**

```typescript
import type { Sql } from 'postgres';
import type { Logger } from '../utils/logger.js';

export interface PerformanceStoreOptions {
    sql: Sql;
    logger: Logger;
}

export interface PerformanceRecord {
    provider: string;
    model: string;
    taskType: string;
    successCount: number;
    errorCount: number;
    totalLatencyMs: number;
}

export interface SampleInput {
    provider: string;
    model: string;
    taskType: string;
    success: boolean;
    latencyMs: number;
}

export class PerformanceStore {
    private sql: Sql;
    private logger: Logger;

    constructor(opts: PerformanceStoreOptions) {
        this.sql = opts.sql;
        this.logger = opts.logger;
    }

    async recordSample(input: SampleInput): Promise<void> {
        const successAdd = input.success ? 1 : 0;
        const errorAdd = input.success ? 0 : 1;
        const now = new Date().toISOString();
        await this.sql`
            INSERT INTO model_performance (
                provider, model, task_type, success_count, error_count, total_latency_ms, last_updated
            ) VALUES (
                ${input.provider}, ${input.model}, ${input.taskType},
                ${successAdd}, ${errorAdd}, ${input.latencyMs}, ${now}
            )
            ON CONFLICT (provider, model, task_type) DO UPDATE SET
                success_count = model_performance.success_count + ${successAdd},
                error_count = model_performance.error_count + ${errorAdd},
                total_latency_ms = model_performance.total_latency_ms + ${input.latencyMs},
                last_updated = ${now}
        `;
    }

    async getRecord(provider: string, model: string, taskType: string): Promise<PerformanceRecord | undefined> {
        const rows = await this.sql<PerformanceRecord[]>`
            SELECT provider, model, task_type AS "taskType",
                   success_count AS "successCount",
                   error_count AS "errorCount",
                   total_latency_ms AS "totalLatencyMs"
            FROM model_performance
            WHERE provider = ${provider} AND model = ${model} AND task_type = ${taskType}
        `;
        return rows[0];
    }

    async getByTaskType(taskType: string): Promise<PerformanceRecord[]> {
        return this.sql<PerformanceRecord[]>`
            SELECT provider, model, task_type AS "taskType",
                   success_count AS "successCount",
                   error_count AS "errorCount",
                   total_latency_ms AS "totalLatencyMs"
            FROM model_performance
            WHERE task_type = ${taskType}
        `;
    }

    async getAll(): Promise<PerformanceRecord[]> {
        return this.sql<PerformanceRecord[]>`
            SELECT provider, model, task_type AS "taskType",
                   success_count AS "successCount",
                   error_count AS "errorCount",
                   total_latency_ms AS "totalLatencyMs"
            FROM model_performance
        `;
    }
}
```

- [ ] **Step 3: Update performance tests**

For each `src/__tests__/performance*.test.ts`:
- Constructor change to `{ sql, logger }`
- `await` every call
- `beforeEach(() => truncateAll(sql))`

- [ ] **Step 4: Run performance tests, verify green**

```bash
npx vitest run src/__tests__ -t "performance" 2>&1 | tail -10
```
Expected: all performance tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/learning/performance-store.ts src/__tests__
git commit -m "$(cat <<'EOF'
feat(learning): async Postgres PerformanceStore

Upsert + aggregate queries go async. Performance tests use the
Docker Postgres fixture.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Wire async stores into `src/server.ts`

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Locate the current store instantiation**

```bash
grep -n "WalletStore\|TrackingStore\|PerformanceStore\|new Database\|better-sqlite3" /Users/ghostfx/PHAROS/src/server.ts | head -20
```
Identify the lines where each store is constructed and which functions/middleware use them. Note the current sqlite Database construction pattern.

- [ ] **Step 2: Replace SQLite DB initialization with `postgres.js` client**

In `src/server.ts`:

Add at top of imports:
```typescript
import { getSql } from './db/index.js';
```

Replace any `new Database(...)` lines (or equivalent SQLite setup) with:
```typescript
const sql = getSql();
```

Replace the WalletStore / TrackingStore / PerformanceStore constructions:
```typescript
const walletStore = new WalletStore({ sql, logger });
const trackingStore = new TrackingStore({ sql, logger });
const performanceStore = new PerformanceStore({ sql, logger });
```

Remove any code that reads `config.tracking.dbPath` for the file path — `DATABASE_URL` env var is the new source of truth, handled inside `getSql()`.

- [ ] **Step 3: Update every call site that uses a store to await**

Search:
```bash
grep -n "walletStore\.\|trackingStore\.\|performanceStore\." /Users/ghostfx/PHAROS/src/server.ts
```

For every call site found:
- Wrap return assignments in `await`
- Containing function must be `async`
- Propagate `await` upward to callers if needed

Specifically:
- Auth middleware: `walletStore.getUserByApiKeyHash(...)` → `await walletStore.getUserByApiKeyHash(...)`
- Wallet routes: every store call awaited
- Admin routes: every store call awaited
- Tracking emission (typically in response hooks): `trackingStore.recordRequest(...)` → `await trackingStore.recordRequest(...)`. If the hook can't be async, wrap in `void promise.catch(err => logger.error(...))`.

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npm run build 2>&1 | tail -10
```
Fix any type errors. The most common pattern is forgetting `async` on a containing function. Compile must be clean before next step.

- [ ] **Step 5: Run the full test suite**

```bash
npm test 2>&1 | tail -5
```
Target: 1820+ passing, 0 failing. If any non-store test fails, it's likely a call site that needs `await` — fix and rerun.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts
git commit -m "$(cat <<'EOF'
feat(server): wire async Postgres stores into boot path

DB init switches from new Database(dbPath) to getSql() from src/db.
All store call sites become async. Full suite green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Graceful shutdown — close Postgres pool on SIGTERM

**Files:**
- Modify: `src/index.ts`
- Modify: `src/instrument.ts` (if it references better-sqlite3)

- [ ] **Step 1: Inspect current shutdown handling**

```bash
grep -n "SIGTERM\|SIGINT\|process\.on\|close\|shutdown" /Users/ghostfx/PHAROS/src/index.ts | head -10
```

- [ ] **Step 2: Add `await sql.end()` to shutdown handler**

In `src/index.ts`, locate the SIGTERM/SIGINT handler. Add at the top of imports:

```typescript
import { resetSql } from './db/index.js';
```

Inside the shutdown handler:

```typescript
async function shutdown(): Promise<void> {
    // ... existing shutdown code (e.g. fastify.close())
    await resetSql();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

Use the exact existing handler shape — only the `await resetSql()` line is new. Order: close fastify first, then DB pool.

- [ ] **Step 3: Update `src/instrument.ts` if it imports `better-sqlite3`**

```bash
grep -n "better-sqlite3\|BetterSqlite\|new Database" /Users/ghostfx/PHAROS/src/instrument.ts
```

If matches exist, remove the SQLite-specific Sentry integration. `postgres.js` has automatic instrumentation via Sentry's pg integration; usually no code change needed.

- [ ] **Step 4: Run full suite**

```bash
npm test 2>&1 | tail -5
```
Target: still 1820+ green.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/instrument.ts
git commit -m "$(cat <<'EOF'
feat(lifecycle): await sql.end() on graceful shutdown

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Remove better-sqlite3 dependency

**Files:**
- Modify: `package.json`
- Modify: any straggler imports

- [ ] **Step 1: Find remaining better-sqlite3 imports**

```bash
grep -rn "better-sqlite3\|from ['\"]better-sqlite3" /Users/ghostfx/PHAROS/src 2>/dev/null
```
Expected: zero matches. If any remain, those files weren't migrated — go back to the relevant task and finish them.

- [ ] **Step 2: Remove from package.json**

```bash
npm uninstall better-sqlite3
```

- [ ] **Step 3: Verify build still passes**

```bash
npm run build && npm test 2>&1 | tail -5
```
Target: 1820+ tests pass; build clean.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "$(cat <<'EOF'
chore(deps): remove better-sqlite3 — Slice B cutover complete

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Local-dev smoke test (no Fly deploy yet)

**Files:** none (verification only)

- [ ] **Step 1: Apply schema to a developer Supabase project**

You (the user) will paste the connection URL. Until then, this step is a placeholder. Skip and continue to verification gates if URL is unavailable.

```bash
psql "$DATABASE_URL" < db/schema.sql
```
Expected: `CREATE TABLE` / `CREATE INDEX` statements run with no errors.

- [ ] **Step 2: Boot Pharos locally against Supabase**

```bash
DATABASE_URL="<url>" npm run dev
```
Watch logs: should see `🚀 Pharos is live on http://localhost:3777` and NO SQLite-related errors.

- [ ] **Step 3: Create a test user locally**

```bash
psql "$DATABASE_URL" -c "INSERT INTO users (email, pharos_api_key_hash) VALUES ('dev@local', 'dummyhash') RETURNING id;"
```
Note the returned `id`.

- [ ] **Step 4: Hit /v1/credits**

```bash
curl -s http://localhost:3777/v1/credits -H "Authorization: Bearer $PHAROS_API_KEY" | jq
```
Expected: a response (using operator-key fallback if real user key isn't set up locally).

If all three sub-checks succeed, local cutover works.

---

## Task 13: Deploy from branch + smoke test in prod

**Files:** none (operational)

- [ ] **Step 1: User creates a Supabase project (free tier)**

User does this manually:
- Sign in at https://supabase.com
- New project → name, password, region (closest to `iad` for low latency, e.g. `us-east-1`)
- Wait ~2 min for provisioning
- Settings → Database → Connection string → URI format → copy

Paste the URL when ready.

- [ ] **Step 2: Apply schema to the prod Supabase project**

```bash
psql "<paste-prod-url>" < db/schema.sql
```
Expected: clean apply.

- [ ] **Step 3: Set Fly secret**

```bash
flyctl secrets set DATABASE_URL="<paste-prod-url>" -a pharos-nexlabs
```
This triggers an auto-redeploy. Wait for it.

- [ ] **Step 4: Push branch + deploy**

```bash
git push -u origin slice-b-supabase-migration
flyctl deploy --app pharos-nexlabs --remote-only
```

- [ ] **Step 5: Watch boot logs for clean start**

```bash
flyctl logs -a pharos-nexlabs --no-tail | tail -50
```
Expected:
- `🚀 Pharos is live on http://localhost:3777`
- No "SQLITE_*" errors
- No "ENOENT /data/pharos.db" errors
- Catalog sync still runs (from Slice A) — `catalog sync complete` should appear

- [ ] **Step 6: Smoke health**

```bash
curl -s https://pharos-nexlabs.fly.dev/health | jq
```
Expected: `status: ok`, providers listed.

- [ ] **Step 7: Smoke wallet read (operator key path)**

```bash
curl -s https://pharos-nexlabs.fly.dev/v1/credits -H "Authorization: Bearer $PHAROS_API_KEY" | jq
```
Expected: `{"data":{"total_credits":0,"total_usage":0}}` (operator key returns zeros).

- [ ] **Step 8: Insert a test user via Supabase SQL editor + smoke routing**

In Supabase dashboard → SQL editor:
```sql
INSERT INTO users (email, pharos_api_key_hash, balance_cents)
VALUES ('smoke@test', 'd41d8cd98f00b204e9800998ecf8427e', 50000)
RETURNING id;
```
(Hash above is `md5('')`; not a real Pharos key — only proves an insert path works.)

Verify via Supabase dashboard table editor: the row exists.

- [ ] **Step 9: Confirm catalog sync still works (no Slice A regression)**

```bash
flyctl logs -a pharos-nexlabs --no-tail | grep "catalog sync complete" | tail -1
```
Expected: line shows `total: ~400+, perSource: {huggingface: ..., vercel: ..., direct: ...}`.

If all 9 sub-checks pass, Slice B is live in prod.

---

## Task 14: Open PR + merge

**Files:** none (operational)

- [ ] **Step 1: Open PR**

```bash
gh pr create --base main --head slice-b-supabase-migration \
  --title "feat(slice-b): SQLite to Supabase Postgres migration" \
  --body "$(cat <<'EOF'
## Summary
- Replaces better-sqlite3 with postgres.js for all persistent state
- WalletStore, TrackingStore, PerformanceStore rewritten as async with same surface API
- Wallet debits use SELECT FOR UPDATE row locking — verified by reproducing race test
- Schema in db/schema.sql applied via Supabase SQL editor
- Docker Postgres test fixture via Vitest globalSetup
- No data migration (no real customer data to preserve)
- Deployed from branch and smoke-tested in prod before this PR

## Test plan
- [x] npm test (1820+ passing including new race test)
- [x] npm run build clean
- [x] Race test: 20 concurrent debits / budget for 10 → exactly 10 succeed
- [x] Deployed to pharos-nexlabs.fly.dev from this branch
- [x] /health green, /v1/credits returns zeros for operator key
- [x] Supabase Table Editor confirms inserted rows
- [x] Slice A catalog sync still works (no regression)

## Follow-ups
- Remove [[mounts]] from fly.toml and destroy pharos_data volume after 24h of clean prod
- Connection pooler (Supavisor) when concurrency demands it
- Data archival of old requests rows when they accumulate

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: User reviews, says merge**

Wait for explicit user "merge" confirmation. Do NOT merge without it.

- [ ] **Step 3: Squash merge**

```bash
gh pr merge --squash --delete-branch
```

- [ ] **Step 4: Pull main locally**

```bash
git checkout main
git pull origin main --ff-only
```

---

## Task 15: Remove Fly volume mount (final cleanup, 24h after deploy)

**Files:**
- Modify: `fly.toml`

**WAIT 24 HOURS after Slice B deploy before running this task.** Confirms Postgres is stable.

- [ ] **Step 1: Remove the mount block from fly.toml**

Edit `fly.toml`, remove these lines:

```toml
[[mounts]]
  source = "pharos_data"
  destination = "/app/data"
```

- [ ] **Step 2: Deploy without the mount**

```bash
flyctl deploy --app pharos-nexlabs --remote-only
```
Expected: deploy succeeds; new machines come up without the volume attached.

- [ ] **Step 3: Verify Pharos still boots and serves**

```bash
curl -s https://pharos-nexlabs.fly.dev/health | jq
```
Expected: same `status: ok`. Catalog cache file at `/data/catalog-cache.json` no longer exists, but cold-boot sync re-fetches from upstream, so next boot's catalog is still populated.

- [ ] **Step 4: Destroy the orphan volume**

```bash
flyctl volumes list -a pharos-nexlabs
flyctl volumes destroy <volume-id> -a pharos-nexlabs
```
Confirm prompt. Volume is gone permanently.

- [ ] **Step 5: Commit + push fly.toml change**

```bash
git add fly.toml
git commit -m "$(cat <<'EOF'
ops(fly): remove /data volume mount — Slice B complete

Pharos no longer writes anything to disk on the Fly machine. All
persistent state lives in Supabase Postgres. Volume pharos_data
destroyed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin main
```

---

## Self-review

**1. Spec coverage:**
- §2 Goals 1 (Postgres only): Tasks 6, 7, 8, 9, 11 ✓
- §2 Goal 2 (better-sqlite3 removed): Task 11 ✓
- §2 Goal 3 (wallet correctness): Tasks 5, 6 ✓
- §2 Goal 4 (1820 tests green): Tasks 6, 7, 8, 9 verification ✓
- §2 Goal 5 (Docker tests): Task 4 ✓
- §2 Goal 6 (branch deploy first): Tasks 13, 14 ✓
- §4 Architecture (3 stores + new db client + helpers): Tasks 3, 4, 6, 7, 8 ✓
- §4.3 wallet FOR UPDATE: Task 6 ✓
- §5 Schema: Task 2 ✓
- §6 Config (DATABASE_URL, package.json, fly.toml): Tasks 1, 11, 15 ✓
- §7 Testing: Tasks 4, 5, 7-step3, 8-step3 ✓
- §8 Risks (race test, no-floating-promises, etc.): Tasks 5, 9 ✓
- §9 Deployment + rollback: Tasks 12, 13, 14, 15 ✓

**2. Placeholder scan:** Task 12 step 1 noted as "placeholder if URL unavailable" — that's a real dependency on user input, not an unwritten task. Acceptable.

**3. Type consistency:** All stores construct via `{ sql, logger }`. All return types are `Promise<T>`. The `User` type in WalletStore has consistent camelCase across getters. `RequestRecord` and `PerformanceRecord` follow the same convention. The `Sql` type is imported from `postgres` in every store.

No fixes needed.
