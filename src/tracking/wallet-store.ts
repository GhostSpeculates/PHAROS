import crypto from 'node:crypto';
import type { Sql } from 'postgres';

export type Modality = 'chat' | 'image' | 'video' | 'voice' | 'embedding' | 'classify';
import { generateUserApiKey } from '../utils/id.js';
import type { Logger } from '../utils/logger.js';

export interface WalletStoreOptions {
    sql: Sql;
    logger: Logger;
}

// camelCase User — used by new async API (race test, future code)
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

// snake_case User — preserved for route files that access user.balance_cents etc.
export interface UserRow {
    id: number;
    email: string;
    stripe_customer_id: string | null;
    pharos_api_key_hash: string;
    balance_cents: number;
    daily_cap_cents: number | null;
    monthly_cap_cents: number | null;
    role: string;
    org_id: number | null;
    created_at: string;
    active: number;
    frozen: number;
}

export interface LedgerRow {
    id: number;
    user_id: number;
    txn_type: string;
    amount_cents: number;
    model: string | null;
    provider: string | null;
    modality: string | null;
    policy: string | null;
    tokens_in: number | null;
    tokens_out: number | null;
    request_id: string | null;
    stripe_event_id: string | null;
    ts: string;
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

// SQL SELECT fragment that returns camelCase columns
const USER_COLS = `
    id, email,
    stripe_customer_id AS "stripeCustomerId",
    pharos_api_key_hash AS "pharosApiKeyHash",
    balance_cents AS "balanceCents",
    daily_cap_cents AS "dailyCapCents",
    monthly_cap_cents AS "monthlyCapCents",
    role, org_id AS "orgId", created_at AS "createdAt",
    active, frozen
`;

// SQL SELECT fragment that returns snake_case columns (for route-layer compat)
const USER_COLS_SNAKE = `
    id, email,
    stripe_customer_id,
    pharos_api_key_hash,
    balance_cents,
    daily_cap_cents,
    monthly_cap_cents,
    role, org_id, created_at,
    active, frozen
`;

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

    // ── New async API (camelCase, used by race test + future callers) ──────

    async getUserByEmail(email: string): Promise<User | undefined> {
        const rows = await this.sql<User[]>`
            SELECT ${this.sql.unsafe(USER_COLS)}
            FROM users WHERE email = ${email}
        `;
        return rows[0];
    }

    async getUserByApiKeyHash(hash: string): Promise<User | undefined> {
        const rows = await this.sql<User[]>`
            SELECT ${this.sql.unsafe(USER_COLS)}
            FROM users WHERE pharos_api_key_hash = ${hash} AND active = 1
        `;
        return rows[0];
    }

    async createUser(input: CreateUserInput): Promise<User> {
        const balanceCents = input.balanceCents ?? 0;
        const [row] = await this.sql<User[]>`
            INSERT INTO users (email, pharos_api_key_hash, balance_cents, stripe_customer_id)
            VALUES (${input.email}, ${input.apiKeyHash}, ${balanceCents}, ${input.stripeCustomerId ?? null})
            RETURNING ${this.sql.unsafe(USER_COLS)}
        `;
        return row;
    }

    async getUserById(id: number): Promise<User | undefined> {
        const rows = await this.sql<User[]>`
            SELECT ${this.sql.unsafe(USER_COLS)}
            FROM users WHERE id = ${id}
        `;
        return rows[0];
    }

    async getBalanceCents(userId: number): Promise<number> {
        const rows = await this.sql<{ balance: string | number }[]>`
            SELECT balance_cents AS balance FROM users WHERE id = ${userId}
        `;
        return Number(rows[0]?.balance ?? 0);
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

    // ── Legacy sync-shaped API (now async) — used by route files ────────
    // Route files call these synchronously today; async is backward-compat
    // since Fastify route handlers are already async. Task 9 will do a proper
    // wire-up with await; for now these let the routes compile and the tests
    // that call them directly just need to await them.

    /** Find user by email (admin/lookup). Returns snake_case shape. */
    async findUserByEmail(email: string): Promise<UserRow | null> {
        const rows = await this.sql<UserRow[]>`
            SELECT ${this.sql.unsafe(USER_COLS_SNAKE)}
            FROM users WHERE email = ${email}
        `;
        return rows[0] ?? null;
    }

    /** Find user by Pharos API key (auth path). Returns snake_case shape. */
    async findUserByApiKey(rawKey: string): Promise<UserRow | null> {
        const hash = WalletStore.hashApiKey(rawKey);
        const rows = await this.sql<UserRow[]>`
            SELECT ${this.sql.unsafe(USER_COLS_SNAKE)}
            FROM users WHERE pharos_api_key_hash = ${hash} AND active = 1
        `;
        return rows[0] ?? null;
    }

    /** Find user by id (admin lookup). Returns snake_case shape. */
    async findUserById(id: number): Promise<UserRow | null> {
        const rows = await this.sql<UserRow[]>`
            SELECT ${this.sql.unsafe(USER_COLS_SNAKE)}
            FROM users WHERE id = ${id}
        `;
        return rows[0] ?? null;
    }

    /**
     * Create a new user from a raw API key. Returns the new user id.
     * (Legacy signature used by route files + existing tests.)
     */
    async createUserLegacy(params: {
        email: string;
        rawApiKey: string;
        balanceCents?: number;
        role?: string;
    }): Promise<number> {
        const hash = WalletStore.hashApiKey(params.rawApiKey);
        const [row] = await this.sql<{ id: string | number }[]>`
            INSERT INTO users (email, pharos_api_key_hash, balance_cents, role)
            VALUES (${params.email}, ${hash}, ${params.balanceCents ?? 0}, ${params.role ?? 'user'})
            RETURNING id
        `;
        return Number(row.id);
    }

    /** Apply a Stripe top-up. Idempotent on stripe_event_id. */
    async applyTopup(params: {
        userId: number;
        amountCents: number;
        stripeEventId: string;
    }): Promise<{ id: number; deduped: boolean }> {
        try {
            const [row] = await this.sql<{ id: string | number }[]>`
                INSERT INTO wallet_ledger (user_id, txn_type, amount_cents, stripe_event_id)
                VALUES (${params.userId}, 'topup', ${Math.abs(params.amountCents)}, ${params.stripeEventId})
                RETURNING id
            `;
            // Mirror balance update onto the users row
            await this.sql`
                UPDATE users SET balance_cents = balance_cents + ${Math.abs(params.amountCents)}
                WHERE id = ${params.userId}
            `;
            return { id: Number(row.id), deduped: false };
        } catch (e: unknown) {
            const err = e as { code?: string; constraint?: string; message?: string };
            // Postgres unique violation = 23505
            if (err.code === '23505') {
                this.logger.warn({ stripeEventId: params.stripeEventId }, '[wallet] dedup top-up — stripe event already applied');
                return { id: -1, deduped: true };
            }
            throw e;
        }
    }

    /** Aggregate balance for /v1/credits. */
    async creditsForUser(userId: number): Promise<{ totalCreditsUsd: number; totalUsageUsd: number }> {
        const [credits] = await this.sql<{ s: number }[]>`
            SELECT COALESCE(SUM(amount_cents), 0) AS s
            FROM wallet_ledger
            WHERE user_id = ${userId} AND txn_type IN ('topup', 'adjust') AND amount_cents > 0
        `;
        const [usage] = await this.sql<{ s: number }[]>`
            SELECT COALESCE(SUM(-amount_cents), 0) AS s
            FROM wallet_ledger
            WHERE user_id = ${userId} AND txn_type = 'debit' AND amount_cents < 0
        `;
        return {
            totalCreditsUsd: Number(credits?.s ?? 0) / 100,
            totalUsageUsd: Number(usage?.s ?? 0) / 100,
        };
    }

    /** Insert a debit row at request entry. Returns ledger id for later settle. */
    async reserveDebit(params: {
        userId: number;
        estimateCents: number;
        model?: string;
        provider?: string;
        modality?: string;
        policy?: string;
        requestId?: string;
    }): Promise<number> {
        const [row] = await this.sql<{ id: string | number }[]>`
            INSERT INTO wallet_ledger
                (user_id, txn_type, amount_cents, model, provider, modality, policy, request_id)
            VALUES (
                ${params.userId}, 'debit', ${-Math.abs(params.estimateCents)},
                ${params.model ?? null}, ${params.provider ?? null}, ${params.modality ?? null},
                ${params.policy ?? null}, ${params.requestId ?? null}
            )
            RETURNING id
        `;
        return Number(row.id);
    }

    /** Settle a reserved debit with actual usage. */
    async settleDebit(ledgerId: number, params: {
        actualCents: number;
        tokensIn?: number;
        tokensOut?: number;
    }): Promise<void> {
        await this.sql`
            UPDATE wallet_ledger
               SET amount_cents = ${-Math.abs(params.actualCents)},
                   tokens_in = ${params.tokensIn ?? null},
                   tokens_out = ${params.tokensOut ?? null}
             WHERE id = ${ledgerId}
        `;
    }

    /** Convert a reserved debit into a refund on inference failure. */
    async refundDebit(ledgerId: number): Promise<void> {
        await this.sql`
            UPDATE wallet_ledger
               SET amount_cents = 0, txn_type = 'refund'
             WHERE id = ${ledgerId}
        `;
    }

    /**
     * Credit a user's wallet with an admin-issued amount (manual refund or
     * goodwill credit).
     */
    async creditUser(userId: number, cents: number, reason: string): Promise<{ ledgerId: number; newBalanceCents: number }> {
        const syntheticEventId = `admin-refund-${crypto.randomUUID()}`;
        const [row] = await this.sql<{ id: string | number }[]>`
            INSERT INTO wallet_ledger (user_id, txn_type, amount_cents, stripe_event_id, policy)
            VALUES (${userId}, 'topup', ${Math.abs(cents)}, ${syntheticEventId}, ${reason})
            RETURNING id
        `;
        await this.sql`
            UPDATE users SET balance_cents = balance_cents + ${Math.abs(cents)}
            WHERE id = ${userId}
        `;
        const newBalanceCents = await this.getBalanceCents(userId);
        return { ledgerId: Number(row.id), newBalanceCents };
    }

    /**
     * Rotate a user's API key. Returns the new raw key (shown once).
     * (Legacy signature — route layer calls this and expects the raw key back.)
     */
    async rotateApiKeyLegacy(userId: number): Promise<string> {
        const rawKey = generateUserApiKey();
        const hash = WalletStore.hashApiKey(rawKey);
        await this.sql`UPDATE users SET pharos_api_key_hash = ${hash} WHERE id = ${userId}`;
        return rawKey;
    }

    /**
     * Per-user usage breakdown from wallet_ledger (debit rows only).
     */
    async getUsageByUser(userId: number, sinceIso?: string): Promise<{
        totalRequests: number;
        totalCostUsd: number;
        byModel: Array<{ model: string; count: number; costUsd: number }>;
        byDay: Array<{ date: string; requests: number; costUsd: number }>;
    }> {
        const since = sinceIso ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

        const [totals] = await this.sql<{ cnt: number; cost_cents: number }[]>`
            SELECT COUNT(*) AS cnt, COALESCE(SUM(-amount_cents), 0) AS cost_cents
            FROM wallet_ledger
            WHERE user_id = ${userId} AND txn_type = 'debit' AND amount_cents < 0 AND ts >= ${since}
        `;

        const byModel = await this.sql<{ model: string; cnt: number; cost_cents: number }[]>`
            SELECT model, COUNT(*) AS cnt, COALESCE(SUM(-amount_cents), 0) AS cost_cents
            FROM wallet_ledger
            WHERE user_id = ${userId} AND txn_type = 'debit' AND amount_cents < 0 AND ts >= ${since}
              AND model IS NOT NULL
            GROUP BY model
            ORDER BY cost_cents DESC
        `;

        const byDay = await this.sql<{ day: string; cnt: number; cost_cents: number }[]>`
            SELECT DATE(ts) AS day, COUNT(*) AS cnt, COALESCE(SUM(-amount_cents), 0) AS cost_cents
            FROM wallet_ledger
            WHERE user_id = ${userId} AND txn_type = 'debit' AND amount_cents < 0 AND ts >= ${since}
            GROUP BY day
            ORDER BY day ASC
        `;

        return {
            totalRequests: Number(totals?.cnt ?? 0),
            totalCostUsd: Number(totals?.cost_cents ?? 0) / 100,
            byModel: byModel.map(r => ({ model: r.model, count: Number(r.cnt), costUsd: Number(r.cost_cents) / 100 })),
            byDay: byDay.map(r => ({ date: r.day, requests: Number(r.cnt), costUsd: Number(r.cost_cents) / 100 })),
        };
    }

    /** No-op — kept for test teardown compatibility. Postgres connections are managed externally. */
    close(): void {
        // postgres.js connections are pooled and managed by the caller.
        // Call sql.end() directly if you need to drain the pool.
    }
}
