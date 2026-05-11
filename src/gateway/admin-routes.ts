/**
 * admin-routes.ts — operator-only /admin/* HTTP surface for Pharos.
 *
 * Routes:
 *   GET  /admin/health/full          — detailed provider + db + sentry health
 *   GET  /admin/users?email=<email>  — lookup user by email
 *   GET  /admin/users/:id/usage      — per-user cost breakdown (last 30d default)
 *   GET  /admin/trace/:request_id    — full tracking row for a request
 *   POST /admin/users/:id/rotate-key — issue a new API key for a user
 *   POST /admin/refund               — manually credit a user's wallet
 *   POST /admin/freeze/:id           — freeze or unfreeze a user account
 *
 * Auth: every route requires Authorization: Bearer <operator_key>
 *       (config.auth.apiKey). Returns 401 on mismatch.
 *
 * All mutations are logged at info level via Pino structured logging.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { WalletStore } from '../tracking/wallet-store.js';
import type { TrackingStore } from '../tracking/store.js';
import type { ProviderRegistry } from '../providers/index.js';
import type { PharosConfig } from '../config/schema.js';
import type { Logger } from '../utils/logger.js';

/** Returns false and sends 401 when the request is not authenticated as the operator. */
function requireOperator(req: FastifyRequest, reply: FastifyReply, config: PharosConfig): boolean {
    const raw = req.headers['authorization'];
    const match = typeof raw === 'string' ? raw.match(/^Bearer\s+(\S+)$/) : null;
    if (!match || match[1] !== config.auth.apiKey) {
        reply.status(401).send({ error: 'operator key required' });
        return false;
    }
    return true;
}

export function registerAdminRoutes(opts: {
    fastify: FastifyInstance;
    wallet: WalletStore;
    tracker: TrackingStore | null;
    registry: ProviderRegistry;
    config: PharosConfig;
    logger: Logger;
}): void {
    const { fastify, wallet, tracker, registry, config, logger } = opts;

    // ── GET /admin/health/full ──────────────────────────────────────────
    fastify.get('/admin/health/full', async (req, reply) => {
        if (!requireOperator(req, reply, config)) return;

        const providerStatus = registry.getStatus();
        const providers: Record<string, 'healthy' | 'unhealthy' | 'unknown'> = {};
        let anyUnhealthy = false;

        for (const [name, info] of Object.entries(providerStatus)) {
            if (!info.available) {
                providers[name] = 'unknown';
            } else if (info.healthy) {
                providers[name] = 'healthy';
            } else {
                providers[name] = 'unhealthy';
                anyUnhealthy = true;
            }
        }

        let dbStatus: 'ok' | 'error' = 'ok';
        try {
            // A live query confirms the db is reachable; no-op on failure path.
            wallet.findUserByEmail('__admin_health_probe__');
        } catch {
            dbStatus = 'error';
        }

        const allUnknown = Object.values(providers).every(s => s === 'unknown');
        const status = dbStatus === 'error'
            ? 'down'
            : anyUnhealthy
                ? 'degraded'
                : allUnknown
                    ? 'degraded'
                    : 'ok';

        return {
            status,
            uptime_s: Math.floor(process.uptime()),
            providers,
            db: dbStatus,
            sentry_dsn_configured: !!process.env.SENTRY_DSN,
            version: '0.1.0',
        };
    });

    // ── GET /admin/users ────────────────────────────────────────────────
    fastify.get('/admin/users', async (req, reply) => {
        if (!requireOperator(req, reply, config)) return;

        const email = (req.query as Record<string, string>).email;
        if (!email) {
            reply.status(400);
            return { error: 'email query parameter required' };
        }

        const user = wallet.findUserByEmail(email.toLowerCase());
        if (!user) {
            reply.status(404);
            return { error: 'user not found' };
        }

        return {
            id: user.id,
            email: user.email,
            balance_usd: user.balance_cents / 100,
            role: user.role,
            daily_cap_usd: user.daily_cap_cents != null ? user.daily_cap_cents / 100 : null,
            monthly_cap_usd: user.monthly_cap_cents != null ? user.monthly_cap_cents / 100 : null,
            frozen: !!user.frozen,
            stripe_linked: !!user.stripe_customer_id,
            created_at: user.created_at,
        };
    });

    // ── GET /admin/users/:id/usage ──────────────────────────────────────
    fastify.get<{ Params: { id: string }; Querystring: { since?: string } }>(
        '/admin/users/:id/usage',
        async (req, reply) => {
            if (!requireOperator(req, reply, config)) return;

            const userId = parseInt(req.params.id, 10);
            if (isNaN(userId)) {
                reply.status(400);
                return { error: 'invalid user id' };
            }

            const since = req.query.since;
            const defaultSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
            const usage = wallet.getUsageByUser(userId, since);

            return {
                user_id: userId,
                since: since ?? defaultSince,
                total_requests: usage.totalRequests,
                total_cost_usd: usage.totalCostUsd,
                // Savings cannot be derived from wallet_ledger alone; always 0 here.
                total_savings_usd: 0,
                by_model: usage.byModel,
                by_day: usage.byDay,
            };
        },
    );

    // ── GET /admin/trace/:request_id ────────────────────────────────────
    fastify.get<{ Params: { request_id: string } }>(
        '/admin/trace/:request_id',
        async (req, reply) => {
            if (!requireOperator(req, reply, config)) return;

            if (!tracker) {
                reply.status(503);
                return { error: 'tracking not enabled' };
            }

            const record = tracker.findByRequestId(req.params.request_id);
            if (!record) {
                reply.status(404);
                return { error: 'request not found' };
            }

            return record;
        },
    );

    // ── POST /admin/users/:id/rotate-key ────────────────────────────────
    fastify.post<{ Params: { id: string } }>(
        '/admin/users/:id/rotate-key',
        async (req, reply) => {
            if (!requireOperator(req, reply, config)) return;

            const userId = parseInt(req.params.id, 10);
            if (isNaN(userId)) {
                reply.status(400);
                return { error: 'invalid user id' };
            }

            const user = wallet.findUserById(userId);
            if (!user) {
                reply.status(404);
                return { error: 'user not found' };
            }

            const newKey = wallet.rotateApiKey(userId);
            logger.info({ userId, email: user.email }, '[admin] api key rotated');

            return { user_id: userId, new_api_key: newKey };
        },
    );

    // ── POST /admin/refund ──────────────────────────────────────────────
    fastify.post('/admin/refund', async (req, reply) => {
        if (!requireOperator(req, reply, config)) return;

        const body = req.body as Record<string, unknown> | null | undefined;
        const userId = typeof body?.user_id === 'number' ? body.user_id : null;
        const cents = typeof body?.cents === 'number' ? body.cents : null;
        const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';

        if (userId == null || !Number.isInteger(userId)) {
            reply.status(400);
            return { error: 'user_id must be an integer' };
        }
        if (cents == null || !Number.isInteger(cents) || cents <= 0 || cents > 100_000) {
            reply.status(400);
            return { error: 'cents must be an integer between 1 and 100000' };
        }
        if (!reason) {
            reply.status(400);
            return { error: 'reason must be a non-empty string' };
        }

        const user = wallet.findUserById(userId);
        if (!user) {
            reply.status(404);
            return { error: 'user not found' };
        }

        const { ledgerId, newBalanceCents } = wallet.creditUser(userId, cents, reason);
        logger.info({ userId, cents, reason, ledgerId }, '[admin] manual credit applied');

        return { ledger_id: ledgerId, user_id: userId, cents, new_balance_cents: newBalanceCents };
    });

    // ── POST /admin/freeze/:id ──────────────────────────────────────────
    fastify.post<{ Params: { id: string } }>(
        '/admin/freeze/:id',
        async (req, reply) => {
            if (!requireOperator(req, reply, config)) return;

            const userId = parseInt(req.params.id, 10);
            if (isNaN(userId)) {
                reply.status(400);
                return { error: 'invalid user id' };
            }

            const user = wallet.findUserById(userId);
            if (!user) {
                reply.status(404);
                return { error: 'user not found' };
            }

            const body = req.body as Record<string, unknown> | null | undefined;
            if (typeof body?.frozen !== 'boolean') {
                reply.status(400);
                return { error: 'frozen must be a boolean' };
            }

            const reason = typeof body.reason === 'string' ? body.reason.trim() : undefined;
            wallet.setFrozen(userId, body.frozen);
            logger.info({ userId, email: user.email, frozen: body.frozen, reason }, '[admin] account freeze updated');

            return { user_id: userId, frozen: body.frozen, reason: reason ?? null };
        },
    );

    logger.info('[admin] routes registered: /admin/health/full, /admin/users, /admin/users/:id/usage, /admin/trace/:request_id, /admin/users/:id/rotate-key, /admin/refund, /admin/freeze/:id');
}
