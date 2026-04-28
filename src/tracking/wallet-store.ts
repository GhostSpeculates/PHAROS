/**
 * wallet-store.ts — Pharos wallet (Phase 8.2 / Wave 5).
 *
 * R1-refined schema (per ~/NOIR-vault/04-AGENTS/pharos.md, locked 2026-04-27):
 *   - users: balance in INTEGER cents (no float drift), nullable daily/monthly caps,
 *     RBAC role + org_id placeholders, Stripe customer link.
 *   - wallet_ledger: signed amount_cents, model + provider columns, modality,
 *     policy (Pharos differentiator), tokens_in/out, stripe_event_id (UNIQUE),
 *     idempotency on (request_id, txn_type).
 *
 * Pre-call debit + settle pattern (R1's strongest implementation note):
 *   1. Reserve at request entry: insert ledger row with txn_type='debit', amount_cents=-estimate.
 *   2. After response: UPDATE the row with the actual cost.
 *   3. On failure: UPDATE to txn_type='refund', amount_cents=0.
 *
 * /v1/credits returns OpenRouter-shape: {data: {total_credits, total_usage}}.
 *
 * NOT WIRED INTO server.ts YET — see wallet-routes.ts. Keep additive until tested.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Logger } from '../utils/logger.js';

export type TxnType = 'topup' | 'debit' | 'refund' | 'adjust';
export type Modality = 'chat' | 'image' | 'video' | 'voice' | 'embedding' | 'classify';

export interface User {
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
}

export interface LedgerRow {
    id: number;
    user_id: number;
    txn_type: TxnType;
    amount_cents: number;
    model: string | null;
    provider: string | null;
    modality: Modality | null;
    policy: string | null;
    tokens_in: number | null;
    tokens_out: number | null;
    request_id: string | null;
    stripe_event_id: string | null;
    ts: string;
}

export class WalletStore {
    private db: Database.Database;
    private logger: Logger;

    constructor(dbPath: string, logger: Logger) {
        this.logger = logger;
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                stripe_customer_id TEXT,
                pharos_api_key_hash TEXT NOT NULL,
                balance_cents INTEGER NOT NULL DEFAULT 0,
                daily_cap_cents INTEGER,
                monthly_cap_cents INTEGER,
                role TEXT NOT NULL DEFAULT 'user',
                org_id INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                active INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS wallet_ledger (
                id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                txn_type TEXT NOT NULL,
                amount_cents INTEGER NOT NULL,
                model TEXT,
                provider TEXT,
                modality TEXT,
                policy TEXT,
                tokens_in INTEGER,
                tokens_out INTEGER,
                request_id TEXT,
                stripe_event_id TEXT,
                ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_ledger_user_ts
                ON wallet_ledger(user_id, ts DESC);
            CREATE INDEX IF NOT EXISTS idx_ledger_request
                ON wallet_ledger(request_id) WHERE request_id IS NOT NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_stripe_event
                ON wallet_ledger(stripe_event_id) WHERE stripe_event_id IS NOT NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_idempotency
                ON wallet_ledger(request_id, txn_type) WHERE request_id IS NOT NULL;
        `);

        logger.info({ dbPath }, '[wallet] schema initialized');
    }

    /** Hash an API key for storage (constant-time-safe to compare via crypto.timingSafeEqual). */
    static hashApiKey(rawKey: string): string {
        return crypto.createHash('sha256').update(rawKey).digest('hex');
    }

    /** Find user by email (admin/lookup). */
    findUserByEmail(email: string): User | null {
        const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
        return (row as User | undefined) ?? null;
    }

    /** Find user by Pharos API key (auth path). */
    findUserByApiKey(rawKey: string): User | null {
        const hash = WalletStore.hashApiKey(rawKey);
        const row = this.db.prepare('SELECT * FROM users WHERE pharos_api_key_hash = ? AND active = 1').get(hash);
        return (row as User | undefined) ?? null;
    }

    /** Create a new user. Returns the new user id. */
    createUser(params: {
        email: string;
        rawApiKey: string;
        balanceCents?: number;
        role?: string;
    }): number {
        const hash = WalletStore.hashApiKey(params.rawApiKey);
        const result = this.db.prepare(`
            INSERT INTO users (email, pharos_api_key_hash, balance_cents, role)
            VALUES (?, ?, ?, ?)
        `).run(params.email, hash, params.balanceCents ?? 0, params.role ?? 'user');
        return Number(result.lastInsertRowid);
    }

    /** Aggregate balance for /v1/credits — sums signed amount_cents across the ledger. */
    creditsForUser(userId: number): { totalCreditsUsd: number; totalUsageUsd: number } {
        const credits = this.db.prepare(`
            SELECT COALESCE(SUM(amount_cents), 0) AS s
            FROM wallet_ledger
            WHERE user_id = ? AND txn_type IN ('topup', 'adjust') AND amount_cents > 0
        `).get(userId) as { s: number };
        const usage = this.db.prepare(`
            SELECT COALESCE(SUM(-amount_cents), 0) AS s
            FROM wallet_ledger
            WHERE user_id = ? AND txn_type = 'debit' AND amount_cents < 0
        `).get(userId) as { s: number };
        return {
            totalCreditsUsd: (credits.s ?? 0) / 100,
            totalUsageUsd: (usage.s ?? 0) / 100,
        };
    }

    /** Insert a debit row at request entry. Returns ledger id for later settle. */
    reserveDebit(params: {
        userId: number;
        estimateCents: number;
        model?: string;
        provider?: string;
        modality?: Modality;
        policy?: string;
        requestId?: string;
    }): number {
        const result = this.db.prepare(`
            INSERT INTO wallet_ledger
                (user_id, txn_type, amount_cents, model, provider, modality, policy, request_id)
            VALUES (?, 'debit', ?, ?, ?, ?, ?, ?)
        `).run(
            params.userId,
            -Math.abs(params.estimateCents),
            params.model ?? null,
            params.provider ?? null,
            params.modality ?? null,
            params.policy ?? null,
            params.requestId ?? null,
        );
        return Number(result.lastInsertRowid);
    }

    /** Settle a reserved debit with actual usage. */
    settleDebit(ledgerId: number, params: {
        actualCents: number;
        tokensIn?: number;
        tokensOut?: number;
    }): void {
        this.db.prepare(`
            UPDATE wallet_ledger
               SET amount_cents = ?, tokens_in = ?, tokens_out = ?
             WHERE id = ?
        `).run(
            -Math.abs(params.actualCents),
            params.tokensIn ?? null,
            params.tokensOut ?? null,
            ledgerId,
        );
    }

    /** Convert a reserved debit into a refund on inference failure. */
    refundDebit(ledgerId: number): void {
        this.db.prepare(`
            UPDATE wallet_ledger
               SET amount_cents = 0, txn_type = 'refund'
             WHERE id = ?
        `).run(ledgerId);
    }

    /** Apply a Stripe top-up. Idempotent on stripe_event_id. */
    applyTopup(params: {
        userId: number;
        amountCents: number;
        stripeEventId: string;
    }): { id: number; deduped: boolean } {
        try {
            const result = this.db.prepare(`
                INSERT INTO wallet_ledger (user_id, txn_type, amount_cents, stripe_event_id)
                VALUES (?, 'topup', ?, ?)
            `).run(params.userId, Math.abs(params.amountCents), params.stripeEventId);
            return { id: Number(result.lastInsertRowid), deduped: false };
        } catch (e: unknown) {
            const err = e as { code?: string; message?: string };
            if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.message?.includes('idx_ledger_stripe_event')) {
                this.logger.warn({ stripeEventId: params.stripeEventId }, '[wallet] dedup top-up — stripe event already applied');
                return { id: -1, deduped: true };
            }
            throw e;
        }
    }

    close(): void {
        this.db.close();
    }
}
