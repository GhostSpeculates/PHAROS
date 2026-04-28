/**
 * wallet-routes.ts — wallet HTTP surface for Pharos (Wave 5 / Phase 8.2).
 *
 * Routes:
 *   GET  /v1/credits        — OpenRouter-shape balance response
 *   GET  /wallet/me         — full user record (auth required)
 *
 * Stripe top-up (`POST /wallet/topup`) and webhook handler (`POST /webhook/stripe`)
 * are stubbed below — wire when STRIPE_SECRET_KEY env var is set.
 *
 * Auth: Bearer token in Authorization header → WalletStore.findUserByApiKey().
 * If no user matches → 401. If balance == 0 → callers should 402 at the
 * pre-call balance guard (added in middleware later).
 */

import type { FastifyInstance } from 'fastify';
import type { WalletStore } from '../tracking/wallet-store.js';
import type { Logger } from '../utils/logger.js';

export function registerWalletRoutes(opts: {
    fastify: FastifyInstance;
    wallet: WalletStore;
    logger: Logger;
}): void {
    const { fastify, wallet, logger } = opts;

    // Helper: extract user from Authorization header.
    function authUser(req: { headers: Record<string, string | string[] | undefined> }) {
        const raw = req.headers['authorization'];
        if (!raw || typeof raw !== 'string') return null;
        const m = raw.match(/^Bearer\s+(.+)$/i);
        if (!m) return null;
        return wallet.findUserByApiKey(m[1].trim());
    }

    // GET /v1/credits — OpenRouter-shape: {data: {total_credits, total_usage}}.
    // Both fields are USD floats. Mirrors OR exactly so OR-fluent clients
    // (Cline, Continue, OpenWebUI) work without code changes.
    fastify.get('/v1/credits', (req, reply) => {
        const user = authUser(req as { headers: Record<string, string | string[] | undefined> });
        if (!user) {
            reply.status(401);
            return { error: { message: 'invalid api key', type: 'authentication_error' } };
        }
        const { totalCreditsUsd, totalUsageUsd } = wallet.creditsForUser(user.id);
        return {
            data: {
                total_credits: totalCreditsUsd,
                total_usage: totalUsageUsd,
            },
        };
    });

    // GET /wallet/me — full user record (Pharos-native shape, not OR-mirrored).
    fastify.get('/wallet/me', (req, reply) => {
        const user = authUser(req as { headers: Record<string, string | string[] | undefined> });
        if (!user) {
            reply.status(401);
            return { error: 'invalid api key' };
        }
        return {
            id: user.id,
            email: user.email,
            balance_usd: user.balance_cents / 100,
            daily_cap_usd: user.daily_cap_cents != null ? user.daily_cap_cents / 100 : null,
            monthly_cap_usd: user.monthly_cap_cents != null ? user.monthly_cap_cents / 100 : null,
            role: user.role,
            stripe_linked: !!user.stripe_customer_id,
            created_at: user.created_at,
        };
    });

    // POST /wallet/topup — placeholder. Wire to Stripe when STRIPE_SECRET_KEY is set.
    // Returns 501 until Stripe is configured so failure is loud per Indie-Dev rule 6.
    fastify.post('/wallet/topup', (req, reply) => {
        const user = authUser(req as { headers: Record<string, string | string[] | undefined> });
        if (!user) {
            reply.status(401);
            return { error: 'invalid api key' };
        }
        const stripeKey = process.env.STRIPE_SECRET_KEY;
        if (!stripeKey) {
            reply.status(501);
            return {
                error: 'stripe not configured',
                message: 'set STRIPE_SECRET_KEY env var and redeploy. Until then, top-ups via /wallet/admin/credit (operator only).',
            };
        }
        // TODO Wave 5 follow-up: build Stripe checkout session, return session URL.
        reply.status(501);
        return { error: 'stripe wiring pending — see TODO in wallet-routes.ts' };
    });

    logger.info('[wallet] routes registered: /v1/credits, /wallet/me, /wallet/topup');
}
