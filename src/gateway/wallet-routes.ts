/**
 * wallet-routes.ts — wallet HTTP surface for Pharos (Wave 1 Day 2).
 *
 * Routes:
 *   GET  /v1/credits        — OpenRouter-shape balance response (auth)
 *   GET  /wallet/me         — full user record (auth)
 *   POST /wallet/topup      — Stripe Checkout for an EXISTING customer (auth)
 *   POST /wallet/checkout   — Stripe Checkout for a NEW or returning user (public, takes email)
 *   POST /webhook/stripe    — Stripe webhook: verify sig, applyTopup, signup on first payment
 *
 * Auth: Bearer token in Authorization header → WalletStore.findUserByApiKey().
 * If no user matches → 401. If balance == 0 → callers get 402 at the
 * pre-call balance guard in middleware/auth.ts.
 *
 * Degrades to 501 when STRIPE_SECRET_KEY is missing — same pattern as
 * the previous stub. Resend email is best-effort: a failed send does not
 * roll back the top-up. The credit landed in the ledger; we just lost
 * the welcome email and Ghost will be notified via logs.
 *
 * IDEMPOTENCY: applyTopup is unique-indexed on stripe_event_id. Stripe
 * webhook retries are safe — second delivery dedups silently.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { WalletStore } from '../tracking/wallet-store.js';
import type { Logger } from '../utils/logger.js';
import { generateUserApiKey } from '../utils/id.js';
import { sendWelcomeEmail } from '../utils/email.js';

const TOPUP_MIN_USD = 5;
const TOPUP_MAX_USD = 500;

interface TopupBody {
    amount_usd?: number;
}

interface CheckoutBody {
    email?: string;
    amount_usd?: number;
}

/**
 * Lazy-loaded Stripe client. Returns null when STRIPE_SECRET_KEY is unset.
 * Pinned to the API version baked into the installed SDK (no manual override —
 * that way an `npm update stripe` is the only thing that bumps it, never a
 * silent dashboard change).
 */
let cachedStripe: import('stripe').Stripe | null = null;
async function getStripe(): Promise<import('stripe').Stripe | null> {
    if (cachedStripe) return cachedStripe;
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) return null;
    const StripeMod = (await import('stripe')).default;
    cachedStripe = new StripeMod(key);
    return cachedStripe;
}

/** Validate amount_usd from request body. Returns parsed cents or null on bad input. */
function parseAmount(body: unknown): number | null {
    if (!body || typeof body !== 'object') return null;
    const amount = (body as { amount_usd?: unknown }).amount_usd;
    if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
    if (amount < TOPUP_MIN_USD || amount > TOPUP_MAX_USD) return null;
    return Math.round(amount * 100);
}

/** Build success/cancel URLs for Checkout. Defaults to localhost dev landing page. */
function publicUrl(path: string): string {
    const base = process.env.PHAROS_PUBLIC_URL || 'http://localhost:3000';
    return `${base.replace(/\/$/, '')}${path}`;
}

export function registerWalletRoutes(opts: {
    fastify: FastifyInstance;
    wallet: WalletStore;
    logger: Logger;
}): void {
    const { fastify, wallet, logger } = opts;

    // Helper: extract user from Authorization header.
    function authUser(req: FastifyRequest) {
        const raw = req.headers['authorization'];
        if (!raw || typeof raw !== 'string') return null;
        const m = raw.match(/^Bearer\s+(.+)$/i);
        if (!m) return null;
        return wallet.findUserByApiKey(m[1].trim());
    }

    // ── GET /v1/credits ─────────────────────────────────────────────────
    // OpenRouter-shape: {data: {total_credits, total_usage}}. Both USD floats.
    fastify.get('/v1/credits', (req, reply) => {
        const user = authUser(req);
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

    // ── GET /wallet/me ──────────────────────────────────────────────────
    fastify.get('/wallet/me', (req, reply) => {
        const user = authUser(req);
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

    // ── POST /wallet/topup ──────────────────────────────────────────────
    // Authed existing-customer top-up. Body: {amount_usd: number}.
    // Returns {url} to redirect the user to Stripe Checkout.
    fastify.post<{ Body: TopupBody }>('/wallet/topup', async (req, reply) => {
        const user = authUser(req);
        if (!user) {
            reply.status(401);
            return { error: 'invalid api key' };
        }
        const stripe = await getStripe();
        if (!stripe) {
            reply.status(501);
            return {
                error: 'stripe not configured',
                message: 'set STRIPE_SECRET_KEY env var and redeploy',
            };
        }
        const cents = parseAmount(req.body);
        if (cents == null) {
            reply.status(400);
            return { error: `amount_usd must be a number between ${TOPUP_MIN_USD} and ${TOPUP_MAX_USD}` };
        }

        try {
            const session = await stripe.checkout.sessions.create({
                mode: 'payment',
                payment_method_types: ['card'],
                line_items: [{
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: 'Pharos credits',
                            description: `$${(cents / 100).toFixed(2)} in API credits`,
                        },
                        unit_amount: cents,
                    },
                    quantity: 1,
                }],
                customer_email: user.email,
                client_reference_id: String(user.id),
                metadata: {
                    email: user.email,
                    user_id: String(user.id),
                    purpose: 'pharos_credits',
                },
                success_url: publicUrl('/wallet/topup/success?session_id={CHECKOUT_SESSION_ID}'),
                cancel_url: publicUrl('/wallet/topup/cancel'),
            });
            logger.info({ userId: user.id, cents, sessionId: session.id }, '[wallet] checkout session created (topup)');
            return { url: session.url, session_id: session.id };
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logger.error({ err: msg, userId: user.id }, '[wallet] stripe checkout creation failed');
            reply.status(502);
            return { error: 'stripe error', message: msg };
        }
    });

    // ── POST /wallet/checkout ───────────────────────────────────────────
    // Public signup OR returning-user top-up. Body: {email, amount_usd}.
    // For brand-new users, the webhook will create the account + email the
    // raw API key. For known emails, it just credits the existing wallet.
    fastify.post<{ Body: CheckoutBody }>('/wallet/checkout', async (req, reply) => {
        const stripe = await getStripe();
        if (!stripe) {
            reply.status(501);
            return {
                error: 'stripe not configured',
                message: 'set STRIPE_SECRET_KEY env var and redeploy',
            };
        }
        const body = req.body || {};
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
            reply.status(400);
            return { error: 'valid email required' };
        }
        const cents = parseAmount(body);
        if (cents == null) {
            reply.status(400);
            return { error: `amount_usd must be a number between ${TOPUP_MIN_USD} and ${TOPUP_MAX_USD}` };
        }

        try {
            const session = await stripe.checkout.sessions.create({
                mode: 'payment',
                payment_method_types: ['card'],
                line_items: [{
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: 'Pharos credits',
                            description: `$${(cents / 100).toFixed(2)} in API credits`,
                        },
                        unit_amount: cents,
                    },
                    quantity: 1,
                }],
                customer_email: email,
                metadata: {
                    email,
                    purpose: 'pharos_credits',
                },
                success_url: publicUrl('/wallet/topup/success?session_id={CHECKOUT_SESSION_ID}'),
                cancel_url: publicUrl('/wallet/topup/cancel'),
            });
            logger.info({ email, cents, sessionId: session.id }, '[wallet] checkout session created (signup-or-returning)');
            return { url: session.url, session_id: session.id };
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logger.error({ err: msg, email }, '[wallet] stripe checkout creation failed');
            reply.status(502);
            return { error: 'stripe error', message: msg };
        }
    });

    // ── POST /webhook/stripe ────────────────────────────────────────────
    // Verifies Stripe signature against the raw body, then dispatches on
    // event.type. Only `checkout.session.completed` actually mutates state;
    // everything else is acked with 200 and ignored.
    //
    // Raw body capture is configured in server.ts via fastify-raw-body
    // ({rawBody: true} on this route) — request.rawBody is a Buffer/string
    // of the unparsed payload that Stripe signs.
    fastify.post('/webhook/stripe', { config: { rawBody: true } }, async (req: FastifyRequest & { rawBody?: string | Buffer }, reply: FastifyReply) => {
        const stripe = await getStripe();
        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
        if (!stripe || !webhookSecret) {
            reply.status(501);
            return {
                error: 'stripe webhook not configured',
                message: 'set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET env vars and redeploy',
            };
        }

        const sig = req.headers['stripe-signature'];
        if (!sig || typeof sig !== 'string') {
            reply.status(400);
            return { error: 'missing stripe-signature header' };
        }

        const raw = req.rawBody;
        if (!raw) {
            logger.error('[wallet] /webhook/stripe missing rawBody — fastify-raw-body not registered for this route');
            reply.status(500);
            return { error: 'raw body capture misconfigured' };
        }

        let event: import('stripe').Stripe.Event;
        try {
            event = stripe.webhooks.constructEvent(raw, sig, webhookSecret);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn({ err: msg }, '[wallet] stripe webhook signature verify failed');
            reply.status(400);
            return { error: 'invalid signature', message: msg };
        }

        if (event.type !== 'checkout.session.completed') {
            logger.debug({ type: event.type, id: event.id }, '[wallet] stripe webhook event ignored');
            return { received: true, ignored: event.type };
        }

        const session = event.data.object as import('stripe').Stripe.Checkout.Session;
        const metadata = session.metadata ?? {};
        const email = (metadata.email ?? session.customer_email ?? '').toLowerCase();
        const amountCents = session.amount_total ?? 0;

        if (!email || amountCents <= 0) {
            logger.warn({ eventId: event.id, email, amountCents }, '[wallet] webhook missing email or amount — skipping');
            return { received: true, skipped: 'missing_email_or_amount' };
        }

        if (session.payment_status !== 'paid') {
            logger.info({ eventId: event.id, status: session.payment_status }, '[wallet] webhook session not paid — skipping');
            return { received: true, skipped: 'not_paid' };
        }

        let user = wallet.findUserByEmail(email);
        let isNewUser = false;
        let rawApiKey: string | null = null;

        if (!user) {
            // First payment — provision the account.
            rawApiKey = generateUserApiKey();
            try {
                const userId = wallet.createUser({
                    email,
                    rawApiKey,
                    balanceCents: 0,  // balance comes from the topup ledger row below
                });
                user = wallet.findUserByEmail(email);
                logger.info({ userId, email }, '[wallet] new user created from stripe webhook');
                isNewUser = true;
            } catch (e) {
                const err = e as { code?: string };
                if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                    user = wallet.findUserByEmail(email);
                    rawApiKey = null;
                    logger.warn({ email }, '[wallet] race: user created by concurrent webhook delivery');
                } else {
                    throw e;
                }
            }
        }

        if (!user) {
            logger.error({ email, eventId: event.id }, '[wallet] user lookup failed after createUser');
            reply.status(500);
            return { error: 'user provisioning failed' };
        }

        const topup = wallet.applyTopup({
            userId: user.id,
            amountCents,
            stripeEventId: event.id,
        });

        if (topup.deduped) {
            logger.info({ eventId: event.id, userId: user.id }, '[wallet] webhook dedup — already applied');
            return { received: true, deduped: true };
        }

        logger.info(
            { userId: user.id, email, cents: amountCents, isNewUser, eventId: event.id },
            '[wallet] topup applied via webhook',
        );

        if (isNewUser && rawApiKey) {
            const result = await sendWelcomeEmail({
                to: email,
                apiKey: rawApiKey,
                creditsUsd: amountCents / 100,
                logger,
            });
            if (!result.ok) {
                // Don't fail the webhook — top-up already landed. Operator
                // can recover by issuing the user a manual reset/key reissue.
                logger.error(
                    { email, userId: user.id, reason: result.reason, err: result.error },
                    '[wallet] welcome email failed to send — manual intervention needed',
                );
            } else {
                logger.info({ email, emailId: result.id }, '[wallet] welcome email sent');
            }
        }

        return { received: true, applied: true, ledger_id: topup.id };
    });

    logger.info('[wallet] routes registered: /v1/credits, /wallet/me, /wallet/topup, /wallet/checkout, /webhook/stripe');
}
