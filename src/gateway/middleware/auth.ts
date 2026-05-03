import type { FastifyRequest, FastifyReply } from 'fastify';
import type { PharosConfig } from '../../config/schema.js';
import type { WalletStore } from '../../tracking/wallet-store.js';
import { buildErrorResponse } from '../schemas/response.js';

/**
 * Module augmentation — every request that passes auth gets a `pharosUser`
 * attached. Downstream wallet middleware reads this to debit the right user.
 *
 *   isOperator=true  → admin/dev key (config.auth.apiKey). Bypasses wallet checks.
 *                       Used for /v1/stats, dashboard, internal scripts.
 *   isOperator=false → real customer paying for usage. Wallet debit applies.
 */
declare module 'fastify' {
    interface FastifyRequest {
        pharosUser?: { id: number; isOperator: boolean };
    }
}

/**
 * Auth middleware — supports two modes:
 *   1. Operator/admin key (legacy, single shared `config.auth.apiKey`)
 *   2. Multi-tenant per-user keys (looked up in WalletStore via SHA-256 hash)
 *
 * If `wallet` is passed, multi-tenant auth is enabled. Operator keys still
 * work as a bypass (so we keep dashboard/admin access without burning a wallet).
 *
 * Pre-call balance guard: if a customer (non-operator) hits their wallet at
 * ≤ 0, returns 402 Payment Required immediately. Caller doesn't even reach
 * the inference path.
 *
 * Open-mode dev fallback: if NEITHER `config.auth.apiKey` NOR `wallet` is set,
 * auth is skipped entirely (useful for local dev). Don't ship to prod that way.
 */
export function createAuthMiddleware(
    config: PharosConfig,
    wallet?: WalletStore | null,
) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        const operatorKeyConfigured = !!config.auth.apiKey;
        const multiTenantEnabled = !!wallet;

        // Open-mode dev fallback — no auth at all.
        if (!operatorKeyConfigured && !multiTenantEnabled) {
            return;
        }

        // Accept either:
        //   Authorization: Bearer <key>   (OpenAI-compat clients, Pharos default)
        //   X-Api-Key: <key>              (Anthropic SDK native — used by /v1/messages)
        const authHeader = request.headers.authorization;
        const xApiKeyHeader = request.headers['x-api-key'];

        let token: string | undefined;

        if (xApiKeyHeader && typeof xApiKeyHeader === 'string' && xApiKeyHeader.trim()) {
            // Anthropic SDK path — x-api-key header
            token = xApiKeyHeader.trim();
        } else if (authHeader) {
            const match = authHeader.match(/^Bearer\s+(\S+)$/);
            if (!match) {
                reply.status(401).send(
                    buildErrorResponse(
                        'Malformed Authorization header. Use: Authorization: Bearer <your-pharos-key>',
                        'authentication_error',
                        'invalid_api_key',
                    ),
                );
                return reply;
            }
            token = match[1];
        } else {
            reply.status(401).send(
                buildErrorResponse(
                    'Missing auth. Use Authorization: Bearer <key> or X-Api-Key: <key>',
                    'authentication_error',
                    'missing_api_key',
                ),
            );
            return reply;
        }

        // ─── Operator/admin key bypass ───────────────────────────────────
        // Operator keys skip wallet entirely — used for /v1/stats, dashboard,
        // internal scripts. Treated as id=0 so wallet writes that hit operator
        // requests don't credit a real user.
        if (operatorKeyConfigured && token === config.auth.apiKey) {
            request.pharosUser = { id: 0, isOperator: true };
            return;
        }

        // ─── Multi-tenant per-user key ───────────────────────────────────
        if (multiTenantEnabled && wallet) {
            const user = wallet.findUserByApiKey(token);
            if (user) {
                // Balance guard — block at 402 if customer is out of credits.
                const balanceCents = wallet.getBalanceCents(user.id);
                if (balanceCents <= 0) {
                    reply.status(402).send(
                        buildErrorResponse(
                            `Insufficient credits. Balance: $${(balanceCents / 100).toFixed(4)}. Top up at /wallet/topup.`,
                            'insufficient_quota',
                            'payment_required',
                        ),
                    );
                    return reply;
                }
                request.pharosUser = { id: user.id, isOperator: false };
                return;
            }
        }

        // ─── Token didn't match operator key OR any user ─────────────────
        reply.status(401).send(
            buildErrorResponse(
                'Invalid API key provided.',
                'authentication_error',
                'invalid_api_key',
            ),
        );
        return reply;
    };
}
