/**
 * wallet-routes.test.ts — Wave 5 wallet HTTP surface.
 *
 * Covers /v1/credits, /wallet/me, /wallet/checkout, /wallet/topup, /webhook/stripe.
 * Stripe is mocked; Resend is mocked via the email module spy. WalletStore uses
 * an in-memory SQLite DB so each test starts fresh.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import rawBody from 'fastify-raw-body';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerWalletRoutes } from '../gateway/wallet-routes.js';
import { WalletStore } from '../tracking/wallet-store.js';
import { createLogger } from '../utils/logger.js';
import * as emailModule from '../utils/email.js';

// ── Stripe mock ─────────────────────────────────────────────────────────
// vi.mock is hoisted; the factory must not close over outer vars, so we
// expose a mutable mock-state holder that tests can mutate before calling.
const stripeMockState = {
    createSession: vi.fn(),
    constructEvent: vi.fn(),
};

vi.mock('stripe', () => {
    // Must be a real function (not arrow) so `new StripeMod(key)` works.
    function StripeCtor(this: unknown) {
        return {
            checkout: {
                sessions: {
                    create: (...args: unknown[]) => stripeMockState.createSession(...args),
                },
            },
            webhooks: {
                constructEvent: (...args: unknown[]) => stripeMockState.constructEvent(...args),
            },
        };
    }
    return { default: StripeCtor };
});

async function buildApp(wallet: WalletStore): Promise<FastifyInstance> {
    const app = Fastify({ logger: { level: 'error' } });
    await app.register(rawBody, {
        field: 'rawBody',
        global: false,
        encoding: 'utf8',
        runFirst: true,
    });
    const logger = createLogger('error', false);
    registerWalletRoutes({ fastify: app, wallet, logger });
    await app.ready();
    return app;
}

function freshWallet(): WalletStore {
    const logger = createLogger('error', false);
    return new WalletStore(':memory:', logger);
}

describe('wallet routes', () => {
    let app: FastifyInstance;
    let wallet: WalletStore;
    let resendSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
        wallet = freshWallet();
        app = await buildApp(wallet);
        stripeMockState.createSession.mockReset();
        stripeMockState.constructEvent.mockReset();
        // Reset the cached Stripe client between tests since the module memoizes it.
        // We do this by re-importing — but simpler: just toggle the env var.
        process.env.STRIPE_SECRET_KEY = 'mocked-in-tests';
        process.env.STRIPE_WEBHOOK_SECRET = 'mocked-in-tests';
        process.env.PHAROS_PUBLIC_URL = 'https://example.com';
        resendSpy = vi
            .spyOn(emailModule, 'sendWelcomeEmail')
            .mockResolvedValue({ ok: true, id: 'email_test' });
    });

    afterEach(async () => {
        await app.close();
        wallet.close();
        resendSpy.mockRestore();
        delete process.env.STRIPE_SECRET_KEY;
        delete process.env.STRIPE_WEBHOOK_SECRET;
        delete process.env.PHAROS_PUBLIC_URL;
    });

    // ── GET /v1/credits ────────────────────────────────────────────────
    describe('GET /v1/credits', () => {
        it('returns 401 with no Authorization header', async () => {
            const res = await app.inject({ method: 'GET', url: '/v1/credits' });
            expect(res.statusCode).toBe(401);
        });

        it('returns 401 with invalid api key', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/v1/credits',
                headers: { authorization: 'Bearer bogus' },
            });
            expect(res.statusCode).toBe(401);
        });

        it('returns OpenRouter-shape body for a valid user', async () => {
            const rawKey = 'pharos-test-key-credits';
            const userId = wallet.createUser({ email: 'a@b.com', rawApiKey: rawKey });
            wallet.applyTopup({ userId, amountCents: 500, stripeEventId: 'evt_seed' });
            const res = await app.inject({
                method: 'GET',
                url: '/v1/credits',
                headers: { authorization: `Bearer ${rawKey}` },
            });
            expect(res.statusCode).toBe(200);
            const body = res.json();
            expect(body.data.total_credits).toBe(5);
            expect(body.data.total_usage).toBe(0);
        });
    });

    // ── GET /wallet/me ─────────────────────────────────────────────────
    describe('GET /wallet/me', () => {
        it('returns 401 with no auth', async () => {
            const res = await app.inject({ method: 'GET', url: '/wallet/me' });
            expect(res.statusCode).toBe(401);
        });

        it('returns full user record for valid user', async () => {
            const rawKey = 'pharos-test-key-me';
            wallet.createUser({ email: 'b@c.com', rawApiKey: rawKey });
            const res = await app.inject({
                method: 'GET',
                url: '/wallet/me',
                headers: { authorization: `Bearer ${rawKey}` },
            });
            expect(res.statusCode).toBe(200);
            const body = res.json();
            expect(body.email).toBe('b@c.com');
            expect(body.balance_usd).toBe(0);
            expect(body.role).toBe('user');
        });
    });

    // ── POST /wallet/checkout ──────────────────────────────────────────
    describe('POST /wallet/checkout', () => {
        it('returns 501 when STRIPE_SECRET_KEY missing', async () => {
            delete process.env.STRIPE_SECRET_KEY;
            const res = await app.inject({
                method: 'POST',
                url: '/wallet/checkout',
                payload: { email: 'x@y.com', amount_usd: 10 },
            });
            expect(res.statusCode).toBe(501);
        });

        it('rejects missing email', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/wallet/checkout',
                payload: { amount_usd: 10 },
            });
            expect(res.statusCode).toBe(400);
        });

        it('rejects malformed email', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/wallet/checkout',
                payload: { email: 'not-an-email', amount_usd: 10 },
            });
            expect(res.statusCode).toBe(400);
        });

        it('rejects amount below min', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/wallet/checkout',
                payload: { email: 'x@y.com', amount_usd: 1 },
            });
            expect(res.statusCode).toBe(400);
        });

        it('rejects amount above max', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/wallet/checkout',
                payload: { email: 'x@y.com', amount_usd: 9999 },
            });
            expect(res.statusCode).toBe(400);
        });

        it('returns Stripe session url for valid input', async () => {
            stripeMockState.createSession.mockResolvedValueOnce({
                id: 'cs_test_123',
                url: 'https://stripe.test/redirect',
            });
            const res = await app.inject({
                method: 'POST',
                url: '/wallet/checkout',
                payload: { email: 'new@user.com', amount_usd: 20 },
            });
            expect(res.statusCode).toBe(200);
            const body = res.json();
            expect(body.url).toBe('https://stripe.test/redirect');
            expect(body.session_id).toBe('cs_test_123');
            expect(stripeMockState.createSession).toHaveBeenCalledTimes(1);
            const call = stripeMockState.createSession.mock.calls[0][0];
            expect(call.line_items[0].price_data.unit_amount).toBe(2000);
            expect(call.customer_email).toBe('new@user.com');
        });
    });

    // ── POST /wallet/topup ─────────────────────────────────────────────
    describe('POST /wallet/topup', () => {
        it('returns 401 with no auth', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/wallet/topup',
                payload: { amount_usd: 10 },
            });
            expect(res.statusCode).toBe(401);
        });

        it('rejects bad amount for authed user', async () => {
            const rawKey = 'pharos-test-key-topup-bad';
            wallet.createUser({ email: 't@b.com', rawApiKey: rawKey });
            const res = await app.inject({
                method: 'POST',
                url: '/wallet/topup',
                payload: { amount_usd: 0.5 },
                headers: { authorization: `Bearer ${rawKey}` },
            });
            expect(res.statusCode).toBe(400);
        });

        it('returns session url for authed user', async () => {
            const rawKey = 'pharos-test-key-topup-ok';
            wallet.createUser({ email: 't2@b.com', rawApiKey: rawKey });
            stripeMockState.createSession.mockResolvedValueOnce({
                id: 'cs_topup_1',
                url: 'https://stripe.test/topup',
            });
            const res = await app.inject({
                method: 'POST',
                url: '/wallet/topup',
                payload: { amount_usd: 25 },
                headers: { authorization: `Bearer ${rawKey}` },
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().url).toBe('https://stripe.test/topup');
        });
    });

    // ── POST /webhook/stripe ───────────────────────────────────────────
    describe('POST /webhook/stripe', () => {
        it('returns 400 when signature header missing', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/webhook/stripe',
                payload: 'raw-body',
                headers: { 'content-type': 'application/json' },
            });
            expect(res.statusCode).toBe(400);
        });

        it('returns 400 on invalid signature', async () => {
            stripeMockState.constructEvent.mockImplementationOnce(() => {
                throw new Error('invalid signature');
            });
            const res = await app.inject({
                method: 'POST',
                url: '/webhook/stripe',
                payload: 'raw-body',
                headers: { 'stripe-signature': 't=1,v1=bogus', 'content-type': 'application/json' },
            });
            expect(res.statusCode).toBe(400);
        });

        it('ignores non-checkout events', async () => {
            stripeMockState.constructEvent.mockReturnValueOnce({
                id: 'evt_ignore',
                type: 'customer.created',
                data: { object: {} },
            });
            const res = await app.inject({
                method: 'POST',
                url: '/webhook/stripe',
                payload: '{}',
                headers: { 'stripe-signature': 't=1,v1=x', 'content-type': 'application/json' },
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().ignored).toBe('customer.created');
        });

        it('creates new user + applies topup + sends welcome email on first payment', async () => {
            stripeMockState.constructEvent.mockReturnValueOnce({
                id: 'evt_new_user_1',
                type: 'checkout.session.completed',
                data: {
                    object: {
                        payment_status: 'paid',
                        amount_total: 500,
                        customer_email: 'fresh@user.com',
                        metadata: { email: 'fresh@user.com' },
                    },
                },
            });

            const res = await app.inject({
                method: 'POST',
                url: '/webhook/stripe',
                payload: '{}',
                headers: { 'stripe-signature': 't=1,v1=x', 'content-type': 'application/json' },
            });

            expect(res.statusCode).toBe(200);
            expect(res.json().applied).toBe(true);
            const user = wallet.findUserByEmail('fresh@user.com');
            expect(user).not.toBeNull();
            expect(wallet.getBalanceCents(user!.id)).toBe(500);
            expect(resendSpy).toHaveBeenCalledTimes(1);
            const emailCall = resendSpy.mock.calls[0][0] as { to: string; apiKey: string; creditsUsd: number };
            expect(emailCall.to).toBe('fresh@user.com');
            expect(emailCall.creditsUsd).toBe(5);
            expect(emailCall.apiKey).toMatch(/^pharos-/);
        });

        it('credits existing user without sending welcome email', async () => {
            const rawKey = 'pharos-existing-user';
            wallet.createUser({ email: 'returning@user.com', rawApiKey: rawKey });

            stripeMockState.constructEvent.mockReturnValueOnce({
                id: 'evt_returning_1',
                type: 'checkout.session.completed',
                data: {
                    object: {
                        payment_status: 'paid',
                        amount_total: 2000,
                        customer_email: 'returning@user.com',
                        metadata: { email: 'returning@user.com' },
                    },
                },
            });

            const res = await app.inject({
                method: 'POST',
                url: '/webhook/stripe',
                payload: '{}',
                headers: { 'stripe-signature': 't=1,v1=x', 'content-type': 'application/json' },
            });

            expect(res.statusCode).toBe(200);
            const user = wallet.findUserByEmail('returning@user.com')!;
            expect(wallet.getBalanceCents(user.id)).toBe(2000);
            expect(resendSpy).not.toHaveBeenCalled();
        });

        it('dedups on repeat webhook delivery (same stripe_event_id)', async () => {
            stripeMockState.constructEvent.mockReturnValue({
                id: 'evt_dedup_1',
                type: 'checkout.session.completed',
                data: {
                    object: {
                        payment_status: 'paid',
                        amount_total: 500,
                        customer_email: 'dedup@user.com',
                        metadata: { email: 'dedup@user.com' },
                    },
                },
            });

            const r1 = await app.inject({
                method: 'POST',
                url: '/webhook/stripe',
                payload: '{}',
                headers: { 'stripe-signature': 't=1,v1=x', 'content-type': 'application/json' },
            });
            expect(r1.statusCode).toBe(200);
            expect(r1.json().applied).toBe(true);

            const r2 = await app.inject({
                method: 'POST',
                url: '/webhook/stripe',
                payload: '{}',
                headers: { 'stripe-signature': 't=1,v1=x', 'content-type': 'application/json' },
            });
            expect(r2.statusCode).toBe(200);
            expect(r2.json().deduped).toBe(true);

            const user = wallet.findUserByEmail('dedup@user.com')!;
            expect(wallet.getBalanceCents(user.id)).toBe(500);
        });

        it('skips on unpaid checkout session', async () => {
            stripeMockState.constructEvent.mockReturnValueOnce({
                id: 'evt_unpaid_1',
                type: 'checkout.session.completed',
                data: {
                    object: {
                        payment_status: 'unpaid',
                        amount_total: 500,
                        customer_email: 'x@y.com',
                        metadata: { email: 'x@y.com' },
                    },
                },
            });
            const res = await app.inject({
                method: 'POST',
                url: '/webhook/stripe',
                payload: '{}',
                headers: { 'stripe-signature': 't=1,v1=x', 'content-type': 'application/json' },
            });
            expect(res.statusCode).toBe(200);
            expect(res.json().skipped).toBe('not_paid');
            expect(wallet.findUserByEmail('x@y.com')).toBeNull();
        });
    });
});
