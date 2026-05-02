import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { WalletStore, Modality } from '../../tracking/wallet-store.js';
import type { Logger } from '../../utils/logger.js';

/**
 * Per-request wallet debit — the "Pharos charges customers" half of the
 * SaaS pipeline.
 *
 * Pattern (single-shot, Wave 1): each route handler computes its own
 * upstream cost and stamps `request.pharosBilling = { ... }` on the
 * success path. A global `onResponse` hook fires after the response is
 * sent and writes a single ledger row debiting the customer.
 *
 *   customer_cost = ceil(upstream_cost_usd × markup_factor × 100)  // cents
 *
 * Reserve/settle (two-phase) is the right pattern at scale — that's what
 * `WalletStore.reserveDebit` + `settleDebit` are built for. Wave 1 uses
 * the simpler single-shot approach because:
 *   1. Lower code surface (one hook vs intrusive per-route changes)
 *   2. Fine for low-volume single-customer workloads
 *   3. The auth-time balance guard prevents the obvious overdraw case
 *      (one big request when balance is $0.0001)
 *
 * Concurrency note: with single-shot, a customer who fires N requests in
 * parallel when their balance is X could spend up to X+N×avg before any
 * settles land. Acceptable for Wave 1; revisit when traffic justifies
 * the reserve/settle complexity.
 */

declare module 'fastify' {
    interface FastifyRequest {
        /** Set by route handlers on the success path. Read by the onResponse hook. */
        pharosBilling?: {
            upstream_usd: number;
            model: string;
            provider: string;
            modality: Modality;
            request_id: string;
        };
    }
}

/** Pharos margin over upstream cost. 1.30 = 30% markup. */
export const DEFAULT_MARKUP_FACTOR = 1.30;

/**
 * Convert an upstream USD float to customer-charge cents (rounded up).
 * Example: 0.023 USD upstream × 1.30 markup = 0.0299 USD = 3 cents
 */
export function customerChargeCents(upstreamUsd: number, markup = DEFAULT_MARKUP_FACTOR): number {
    return Math.max(1, Math.ceil(upstreamUsd * markup * 100));
}

/**
 * Register the global `onResponse` wallet debit hook.
 * No-op for: missing wallet, operator requests, requests with no billing stamp,
 * non-2xx responses (we don't bill failures).
 */
export function registerWalletDebitHook(
    app: FastifyInstance,
    wallet: WalletStore,
    logger: Logger,
    markup = DEFAULT_MARKUP_FACTOR,
): void {
    app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            const billing = request.pharosBilling;
            const user = request.pharosUser;
            const status = reply.statusCode;

            // Skip: no user, operator, no billing stamp, or failed response.
            if (!billing || !user || user.isOperator) return;
            if (status < 200 || status >= 300) return;
            if (billing.upstream_usd <= 0) return;

            const cents = customerChargeCents(billing.upstream_usd, markup);
            wallet.reserveDebit({
                userId: user.id,
                estimateCents: cents,
                model: billing.model,
                provider: billing.provider,
                modality: billing.modality,
                requestId: billing.request_id,
            });

            logger.debug(
                {
                    requestId: billing.request_id,
                    userId: user.id,
                    upstreamUsd: billing.upstream_usd,
                    customerCents: cents,
                    markup,
                },
                '[wallet] debit recorded',
            );
        } catch (err) {
            // Billing failures must NOT break the response (response was already sent).
            // Just log and move on — the request_id ties this back to the requests table
            // for manual reconciliation if needed.
            logger.error(
                { err: err instanceof Error ? err.message : 'unknown' },
                '[wallet] debit hook failed (response already sent — manual reconcile via request_id)',
            );
        }
    });

    logger.info(`[wallet] debit hook registered (markup ${markup}x)`);
}
