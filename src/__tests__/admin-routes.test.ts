/**
 * admin-routes.test.ts — operator-gated /admin/* HTTP surface.
 *
 * Covers all 7 admin routes + the frozen-blocks-customer path in auth.ts.
 * Uses Fastify inject() + in-memory SQLite so each test starts clean.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerAdminRoutes } from '../gateway/admin-routes.js';
import { registerRoutes } from '../gateway/router.js';
import { WalletStore } from '../tracking/wallet-store.js';
import { TrackingStore } from '../tracking/store.js';
import { createLogger } from '../utils/logger.js';
import type { PharosConfig } from '../config/schema.js';

const OPERATOR_KEY = 'test-operator-key';

function makeConfig(): PharosConfig {
    return {
        auth: { apiKey: OPERATOR_KEY },
        server: {
            port: 0,
            host: '127.0.0.1',
            agentRateLimitPerMinute: 1000,
            bodyLimitMb: 10,
            rateLimitPerMinute: 1000,
            selfTest: false,
            debugLogging: false,
        },
        tracking: {
            enabled: true,
            dbPath: ':memory:',
            retentionDays: 30,
            baselineModel: 'claude-sonnet-4-20250514',
            baselineCostPerMillionInput: 3,
            baselineCostPerMillionOutput: 15,
        },
        classifier: {
            providers: [{ provider: 'google', model: 'gemini-2.5-flash' }],
            fallbackTier: 'economical',
            timeoutMs: 3000,
            maxConcurrent: 5,
            cacheMaxSize: 100,
            cacheTtlMs: 30000,
        },
        tiers: {
            free: { scoreRange: [1, 3], models: [{ provider: 'google', model: 'gemini-2.5-flash' }] },
            economical: { scoreRange: [4, 6], models: [{ provider: 'google', model: 'gemini-2.5-flash' }] },
            premium: { scoreRange: [7, 8], models: [{ provider: 'anthropic', model: 'claude-sonnet-4-20250514' }] },
            frontier: { scoreRange: [9, 10], models: [{ provider: 'anthropic', model: 'claude-opus-4-20250514' }] },
        },
        providers: {},
        logging: { level: 'error', pretty: false },
        spending: { dailyLimit: null, monthlyLimit: null },
    } as unknown as PharosConfig;
}

/** Stub registry that reports one healthy provider. */
function makeRegistry() {
    return {
        getStatus: () => ({
            google: { available: true, healthy: true, latency: { avgMs: 50, p95Ms: 80, samples: 10, degraded: false } },
        }),
        listAvailable: () => ['google'],
    } as any;
}

async function buildApp(wallet: WalletStore, tracker: TrackingStore | null): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    const logger = createLogger('error', false);
    const config = makeConfig();
    const registry = makeRegistry();
    registerAdminRoutes({ fastify: app, wallet, tracker, registry, config, logger });
    await app.ready();
    return app;
}

function authHeader() {
    return { authorization: `Bearer ${OPERATOR_KEY}` };
}

function freshStores() {
    const logger = createLogger('error', false);
    const wallet = new WalletStore(':memory:', logger);
    const tracker = new TrackingStore(':memory:', logger);
    return { wallet, tracker };
}

describe('admin routes', () => {
    let app: FastifyInstance;
    let wallet: WalletStore;
    let tracker: TrackingStore;

    beforeEach(async () => {
        ({ wallet, tracker } = freshStores());
        app = await buildApp(wallet, tracker);
    });

    afterEach(async () => {
        await app.close();
        wallet.close();
        tracker.close();
    });

    // ── GET /admin/health/full ─────────────────────────────────────────
    describe('GET /admin/health/full', () => {
        it('returns 401 without operator key', async () => {
            const res = await app.inject({ method: 'GET', url: '/admin/health/full' });
            expect(res.statusCode).toBe(401);
        });

        it('returns full health shape', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/admin/health/full',
                headers: authHeader(),
            });
            expect(res.statusCode).toBe(200);
            const body = res.json();
            expect(['ok', 'degraded', 'down']).toContain(body.status);
            expect(typeof body.uptime_s).toBe('number');
            expect(typeof body.providers).toBe('object');
            expect(['ok', 'error']).toContain(body.db);
            expect(typeof body.sentry_dsn_configured).toBe('boolean');
            expect(body.version).toBe('0.1.0');
        });

        it('reports provider as healthy', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/admin/health/full',
                headers: authHeader(),
            });
            const body = res.json();
            expect(body.providers.google).toBe('healthy');
        });
    });

    // ── GET /admin/users ───────────────────────────────────────────────
    describe('GET /admin/users', () => {
        it('returns 401 without operator key', async () => {
            const res = await app.inject({ method: 'GET', url: '/admin/users?email=x@y.com' });
            expect(res.statusCode).toBe(401);
        });

        it('returns 400 when email param missing', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/admin/users',
                headers: authHeader(),
            });
            expect(res.statusCode).toBe(400);
        });

        it('returns 404 for unknown email', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/admin/users?email=nobody@x.com',
                headers: authHeader(),
            });
            expect(res.statusCode).toBe(404);
        });

        it('returns user record without api_key_hash', async () => {
            wallet.createUser({ email: 'alice@test.com', rawApiKey: 'pharos-test-alice' });
            const res = await app.inject({
                method: 'GET',
                url: '/admin/users?email=alice@test.com',
                headers: authHeader(),
            });
            expect(res.statusCode).toBe(200);
            const body = res.json();
            expect(body.email).toBe('alice@test.com');
            expect(body.role).toBe('user');
            expect(typeof body.balance_usd).toBe('number');
            expect(typeof body.frozen).toBe('boolean');
            expect(body).not.toHaveProperty('pharos_api_key_hash');
            expect(body).not.toHaveProperty('api_key_hash');
        });
    });

    // ── GET /admin/users/:id/usage ─────────────────────────────────────
    describe('GET /admin/users/:id/usage', () => {
        it('returns 401 without operator key', async () => {
            const res = await app.inject({ method: 'GET', url: '/admin/users/1/usage' });
            expect(res.statusCode).toBe(401);
        });

        it('returns usage breakdown for valid user (empty)', async () => {
            const id = wallet.createUser({ email: 'bob@test.com', rawApiKey: 'pharos-test-bob' });
            const res = await app.inject({
                method: 'GET',
                url: `/admin/users/${id}/usage`,
                headers: authHeader(),
            });
            expect(res.statusCode).toBe(200);
            const body = res.json();
            expect(body.user_id).toBe(id);
            expect(body.total_requests).toBe(0);
            expect(body.total_cost_usd).toBe(0);
            expect(Array.isArray(body.by_model)).toBe(true);
            expect(Array.isArray(body.by_day)).toBe(true);
        });

        it('returns 400 for non-integer user id', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/admin/users/notanumber/usage',
                headers: authHeader(),
            });
            expect(res.statusCode).toBe(400);
        });
    });

    // ── GET /admin/trace/:request_id ───────────────────────────────────
    describe('GET /admin/trace/:request_id', () => {
        it('returns 401 without operator key', async () => {
            const res = await app.inject({ method: 'GET', url: '/admin/trace/abc-123' });
            expect(res.statusCode).toBe(401);
        });

        it('returns 404 for unknown request id', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/admin/trace/nonexistent-id',
                headers: authHeader(),
            });
            expect(res.statusCode).toBe(404);
        });

        it('returns full record for existing request', async () => {
            tracker.record({
                id: 'req-trace-test-1',
                timestamp: new Date().toISOString(),
                tier: 'economical',
                provider: 'google',
                model: 'gemini-2.5-flash',
                classificationScore: 5,
                classificationType: 'conversation',
                classificationLatencyMs: 50,
                classifierProvider: 'google',
                tokensIn: 100,
                tokensOut: 50,
                estimatedCost: 0.001,
                baselineCost: 0.003,
                savings: 0.002,
                totalLatencyMs: 300,
                stream: false,
                isDirectRoute: false,
            });
            const res = await app.inject({
                method: 'GET',
                url: '/admin/trace/req-trace-test-1',
                headers: authHeader(),
            });
            expect(res.statusCode).toBe(200);
            const body = res.json();
            expect(body.id).toBe('req-trace-test-1');
            expect(body.provider).toBe('google');
            expect(body.model).toBe('gemini-2.5-flash');
        });
    });

    // ── POST /admin/users/:id/rotate-key ──────────────────────────────
    describe('POST /admin/users/:id/rotate-key', () => {
        it('returns 401 without operator key', async () => {
            const res = await app.inject({ method: 'POST', url: '/admin/users/1/rotate-key' });
            expect(res.statusCode).toBe(401);
        });

        it('returns 404 for unknown user', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/admin/users/9999/rotate-key',
                headers: authHeader(),
            });
            expect(res.statusCode).toBe(404);
        });

        it('returns new api key and old key no longer works', async () => {
            const oldKey = 'pharos-old-key-rotate-test';
            const id = wallet.createUser({ email: 'rotate@test.com', rawApiKey: oldKey });

            const res = await app.inject({
                method: 'POST',
                url: `/admin/users/${id}/rotate-key`,
                headers: authHeader(),
            });
            expect(res.statusCode).toBe(200);
            const body = res.json();
            expect(body.user_id).toBe(id);
            expect(typeof body.new_api_key).toBe('string');
            expect(body.new_api_key).toMatch(/^pharos-/);
            expect(body.new_api_key).not.toBe(oldKey);

            // Old key should no longer authenticate
            expect(wallet.findUserByApiKey(oldKey)).toBeNull();
            // New key should authenticate
            expect(wallet.findUserByApiKey(body.new_api_key)).not.toBeNull();
        });
    });

    // ── POST /admin/refund ─────────────────────────────────────────────
    describe('POST /admin/refund', () => {
        it('returns 401 without operator key', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/admin/refund',
                payload: { user_id: 1, cents: 100, reason: 'test' },
            });
            expect(res.statusCode).toBe(401);
        });

        it('returns 400 for missing cents', async () => {
            const id = wallet.createUser({ email: 'refund1@test.com', rawApiKey: 'pharos-r1' });
            const res = await app.inject({
                method: 'POST',
                url: '/admin/refund',
                payload: { user_id: id, reason: 'test' },
                headers: authHeader(),
            });
            expect(res.statusCode).toBe(400);
        });

        it('returns 400 for cents = 0', async () => {
            const id = wallet.createUser({ email: 'refund2@test.com', rawApiKey: 'pharos-r2' });
            const res = await app.inject({
                method: 'POST',
                url: '/admin/refund',
                payload: { user_id: id, cents: 0, reason: 'test' },
                headers: authHeader(),
            });
            expect(res.statusCode).toBe(400);
        });

        it('returns 400 for cents > 100000', async () => {
            const id = wallet.createUser({ email: 'refund3@test.com', rawApiKey: 'pharos-r3' });
            const res = await app.inject({
                method: 'POST',
                url: '/admin/refund',
                payload: { user_id: id, cents: 100001, reason: 'test' },
                headers: authHeader(),
            });
            expect(res.statusCode).toBe(400);
        });

        it('returns 400 for empty reason', async () => {
            const id = wallet.createUser({ email: 'refund4@test.com', rawApiKey: 'pharos-r4' });
            const res = await app.inject({
                method: 'POST',
                url: '/admin/refund',
                payload: { user_id: id, cents: 500, reason: '' },
                headers: authHeader(),
            });
            expect(res.statusCode).toBe(400);
        });

        it('returns 404 for unknown user', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/admin/refund',
                payload: { user_id: 9999, cents: 100, reason: 'test' },
                headers: authHeader(),
            });
            expect(res.statusCode).toBe(404);
        });

        it('credits user and returns new balance', async () => {
            const id = wallet.createUser({ email: 'refund5@test.com', rawApiKey: 'pharos-r5' });
            const res = await app.inject({
                method: 'POST',
                url: '/admin/refund',
                payload: { user_id: id, cents: 500, reason: 'goodwill credit' },
                headers: authHeader(),
            });
            expect(res.statusCode).toBe(200);
            const body = res.json();
            expect(body.user_id).toBe(id);
            expect(body.cents).toBe(500);
            expect(body.new_balance_cents).toBe(500);
            expect(typeof body.ledger_id).toBe('number');

            // Verify the balance actually increased
            expect(wallet.getBalanceCents(id)).toBe(500);
        });
    });

    // ── POST /admin/freeze/:id ─────────────────────────────────────────
    describe('POST /admin/freeze/:id', () => {
        it('returns 401 without operator key', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/admin/freeze/1',
                payload: { frozen: true },
            });
            expect(res.statusCode).toBe(401);
        });

        it('returns 404 for unknown user', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/admin/freeze/9999',
                payload: { frozen: true },
                headers: authHeader(),
            });
            expect(res.statusCode).toBe(404);
        });

        it('returns 400 when frozen is not boolean', async () => {
            const id = wallet.createUser({ email: 'freeze1@test.com', rawApiKey: 'pharos-f1' });
            const res = await app.inject({
                method: 'POST',
                url: `/admin/freeze/${id}`,
                payload: { frozen: 'yes' },
                headers: authHeader(),
            });
            expect(res.statusCode).toBe(400);
        });

        it('freezes and unfreezes a user', async () => {
            const id = wallet.createUser({ email: 'freeze2@test.com', rawApiKey: 'pharos-f2' });

            const freezeRes = await app.inject({
                method: 'POST',
                url: `/admin/freeze/${id}`,
                payload: { frozen: true, reason: 'fraud investigation' },
                headers: authHeader(),
            });
            expect(freezeRes.statusCode).toBe(200);
            const freezeBody = freezeRes.json();
            expect(freezeBody.frozen).toBe(true);
            expect(freezeBody.reason).toBe('fraud investigation');

            const user = wallet.findUserById(id);
            expect(user?.frozen).toBe(1);

            // Unfreeze
            const unfreezeRes = await app.inject({
                method: 'POST',
                url: `/admin/freeze/${id}`,
                payload: { frozen: false },
                headers: authHeader(),
            });
            expect(unfreezeRes.statusCode).toBe(200);
            expect(unfreezeRes.json().frozen).toBe(false);
            expect(wallet.findUserById(id)?.frozen).toBe(0);
        });
    });

    // ── Freeze enforcement: frozen customer gets 403 on inference ──────
    describe('frozen user blocked at auth', () => {
        it('returns 403 on /v1/chat/completions when account is frozen', async () => {
            // Build a separate app that wires the auth middleware (via registerRoutes)
            const authApp = Fastify({ logger: false });
            const logger = createLogger('error', false);
            const config = makeConfig();
            const registry = makeRegistry();
            const rawKey = 'pharos-frozen-user-test';

            // Separate in-memory stores so we don't pollute the outer test
            const frozenWallet = new WalletStore(':memory:', logger);
            const frozenTracker = new TrackingStore(':memory:', logger);
            const userId = frozenWallet.createUser({ email: 'frozen@test.com', rawApiKey: rawKey });

            // Give them credits so the 402 path doesn't fire first
            frozenWallet.applyTopup({ userId, amountCents: 1000, stripeEventId: 'evt_freeze_test' });

            // Stub classifier/router that would never be reached for frozen user
            const classifier = {
                classify: async () => ({ score: 5, type: 'conversation', classifierProvider: 'stub', latencyMs: 5, isFallback: false }),
                getMetrics: () => ({}),
            } as any;
            const router = {
                resolveDirectModel: () => null,
                resolveTaskTypeOverride: () => null,
                route: () => ({ tier: 'economical', provider: 'stub', model: 'stub-model', failoverAttempts: 0, isDirectRoute: false }),
                routeDirect: () => {},
                getCandidates: () => [],
            } as any;

            registerRoutes(authApp, config, classifier, router, registry, frozenTracker, logger, undefined, undefined, undefined, frozenWallet);
            await authApp.ready();

            // Un-frozen user gets a provider error (not 403)
            const okRes = await authApp.inject({
                method: 'POST',
                url: '/v1/chat/completions',
                payload: { model: 'pharos-auto', messages: [{ role: 'user', content: 'hi' }] },
                headers: { authorization: `Bearer ${rawKey}` },
            });
            // Should NOT be 403 (may be 500 because stub provider isn't real)
            expect(okRes.statusCode).not.toBe(403);

            // Now freeze the user
            frozenWallet.setFrozen(userId, true);

            const frozenRes = await authApp.inject({
                method: 'POST',
                url: '/v1/chat/completions',
                payload: { model: 'pharos-auto', messages: [{ role: 'user', content: 'hi' }] },
                headers: { authorization: `Bearer ${rawKey}` },
            });
            expect(frozenRes.statusCode).toBe(403);
            expect(frozenRes.json().error).toBe('account_frozen');

            await authApp.close();
            frozenWallet.close();
            frozenTracker.close();
        });
    });
});
