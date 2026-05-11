/**
 * checkout-rate-limit.test.ts
 *
 * Tests for the checkout rate limiter middleware (unit) and the
 * /wallet/checkout route integration (IP + email limits).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import rawBody from 'fastify-raw-body';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSlidingWindowLimiter } from '../gateway/middleware/checkout-rate-limit.js';
import { registerWalletRoutes } from '../gateway/wallet-routes.js';
import { WalletStore } from '../tracking/wallet-store.js';
import { createLogger } from '../utils/logger.js';

// ── Stripe mock (same pattern as wallet-routes.test.ts) ─────────────────────
const stripeMockState = {
    createSession: vi.fn(),
    constructEvent: vi.fn(),
};

vi.mock('stripe', () => {
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

// ── Unit tests: createSlidingWindowLimiter ───────────────────────────────────

const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
} as any;

describe('createSlidingWindowLimiter', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('allows requests under the max', () => {
        const limiter = createSlidingWindowLimiter(3600_000, 3, 'email', mockLogger);
        for (let i = 0; i < 3; i++) {
            expect(limiter.check('a@b.com').allowed).toBe(true);
        }
    });

    it('blocks the (max+1)th request within the window', () => {
        const limiter = createSlidingWindowLimiter(3600_000, 3, 'email', mockLogger);
        limiter.check('a@b.com');
        limiter.check('a@b.com');
        limiter.check('a@b.com');
        const result = limiter.check('a@b.com');
        expect(result.allowed).toBe(false);
        expect(result.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('returns correct retryAfterSeconds at midpoint of window', () => {
        const limiter = createSlidingWindowLimiter(3600_000, 1, 'ip', mockLogger);
        limiter.check('1.2.3.4');
        vi.advanceTimersByTime(1800_000); // 30 min elapsed
        const result = limiter.check('1.2.3.4');
        expect(result.allowed).toBe(false);
        expect(result.retryAfterSeconds).toBe(1800);
    });

    it('resets after the window expires', () => {
        const limiter = createSlidingWindowLimiter(3600_000, 2, 'ip', mockLogger);
        limiter.check('1.2.3.4');
        limiter.check('1.2.3.4');
        expect(limiter.check('1.2.3.4').allowed).toBe(false);

        vi.advanceTimersByTime(3600_000);

        expect(limiter.check('1.2.3.4').allowed).toBe(true);
    });

    it('different keys have independent buckets', () => {
        const limiter = createSlidingWindowLimiter(3600_000, 1, 'ip', mockLogger);
        expect(limiter.check('1.1.1.1').allowed).toBe(true);
        expect(limiter.check('1.1.1.1').allowed).toBe(false);
        expect(limiter.check('2.2.2.2').allowed).toBe(true);
    });

    it('logs a warning when rate limited', () => {
        const limiter = createSlidingWindowLimiter(3600_000, 1, 'ip', mockLogger);
        limiter.check('1.2.3.4');
        limiter.check('1.2.3.4');
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ key: '1.2.3.4', max: 1, label: 'ip' }),
            'checkout rate limited',
        );
    });

    it('cleanup interval removes expired entries and logs', () => {
        const limiter = createSlidingWindowLimiter(3600_000, 5, 'ip', mockLogger);
        limiter.check('a@b.com');
        limiter.check('c@d.com');

        vi.advanceTimersByTime(3600_000);

        expect(mockLogger.debug).toHaveBeenCalledWith(
            expect.objectContaining({ cleaned: 2, remaining: 0, label: 'ip' }),
            'checkout rate limiter cleanup',
        );
    });
});

// ── Integration tests: /wallet/checkout route ────────────────────────────────

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
    return new WalletStore(':memory:', createLogger('error', false));
}

// Helper: inject a valid checkout request with a custom remoteAddress (simulates req.ip).
async function checkout(
    app: FastifyInstance,
    email: string,
    remoteAddress = '1.2.3.4',
) {
    return app.inject({
        method: 'POST',
        url: '/wallet/checkout',
        remoteAddress,
        payload: { email, amount_usd: 10 },
    });
}

describe('/wallet/checkout rate limiting (integration)', () => {
    let app: FastifyInstance;
    let wallet: WalletStore;

    beforeEach(async () => {
        // Each test gets a fresh app (fresh limiters with empty windows).
        wallet = freshWallet();
        app = await buildApp(wallet);
        stripeMockState.createSession.mockReset();
        stripeMockState.constructEvent.mockReset();
        process.env.STRIPE_SECRET_KEY = 'mocked-in-tests';
        // Make Stripe return a session so successful requests don't error.
        stripeMockState.createSession.mockResolvedValue({
            id: 'cs_test',
            url: 'https://stripe.test/pay',
        });
    });

    afterEach(async () => {
        await app.close();
        wallet.close();
        delete process.env.STRIPE_SECRET_KEY;
    });

    it('allows the first 10 requests from the same IP', async () => {
        for (let i = 0; i < 10; i++) {
            const res = await checkout(app, `user${i}@example.com`);
            expect(res.statusCode).toBe(200);
        }
    });

    it('blocks the 11th request from the same IP with 429', async () => {
        for (let i = 0; i < 10; i++) {
            await checkout(app, `user${i}@example.com`);
        }
        const res = await checkout(app, 'user10@example.com');
        expect(res.statusCode).toBe(429);
        expect(res.headers['retry-after']).toBeDefined();
        const body = res.json();
        expect(body.error).toBe('rate_limited');
        expect(body.scope).toBe('ip');
    });

    it('a different IP is not affected by first IP exhausting its limit', async () => {
        for (let i = 0; i < 10; i++) {
            await checkout(app, `user${i}@example.com`, '1.2.3.4');
        }
        // 11th from 1.2.3.4 is blocked
        expect((await checkout(app, 'block@example.com', '1.2.3.4')).statusCode).toBe(429);
        // But a different IP is fine
        const res = await checkout(app, 'other@example.com', '5.6.7.8');
        expect(res.statusCode).toBe(200);
    });

    it('allows the first 3 requests for the same email', async () => {
        for (let i = 0; i < 3; i++) {
            const res = await checkout(app, 'repeat@example.com', `10.0.0.${i + 1}`);
            expect(res.statusCode).toBe(200);
        }
    });

    it('blocks the 4th request for the same email with 429', async () => {
        for (let i = 0; i < 3; i++) {
            await checkout(app, 'repeat@example.com', `10.0.0.${i + 1}`);
        }
        const res = await checkout(app, 'repeat@example.com', '10.0.0.99');
        expect(res.statusCode).toBe(429);
        expect(res.headers['retry-after']).toBeDefined();
        const body = res.json();
        expect(body.error).toBe('rate_limited');
        expect(body.scope).toBe('email');
    });

    it('email check is case-insensitive', async () => {
        for (let i = 0; i < 3; i++) {
            // Use mixed case on some — all map to the same bucket
            const email = i % 2 === 0 ? 'Case@Example.COM' : 'case@example.com';
            await checkout(app, email, `10.1.0.${i + 1}`);
        }
        const res = await checkout(app, 'CASE@EXAMPLE.COM', '10.1.0.99');
        expect(res.statusCode).toBe(429);
        expect(res.json().scope).toBe('email');
    });

    it('a different email is not affected by another email being rate-limited', async () => {
        for (let i = 0; i < 3; i++) {
            await checkout(app, 'repeat@example.com', `10.2.0.${i + 1}`);
        }
        // 4th for repeat@ is blocked
        expect((await checkout(app, 'repeat@example.com', '10.2.0.99')).statusCode).toBe(429);
        // Different email on different IP is fine
        const res = await checkout(app, 'fresh@example.com', '10.3.0.1');
        expect(res.statusCode).toBe(200);
    });

    it('IP check fires before email check', async () => {
        // Exhaust the IP limit
        for (let i = 0; i < 10; i++) {
            await checkout(app, `user${i}@example.com`, '9.9.9.9');
        }
        // The 11th request uses a brand-new email — IP limit should fire first
        const res = await checkout(app, 'brandnew@example.com', '9.9.9.9');
        expect(res.statusCode).toBe(429);
        expect(res.json().scope).toBe('ip');
    });

    it('IP check runs before Stripe is invoked when blocked', async () => {
        for (let i = 0; i < 10; i++) {
            await checkout(app, `user${i}@example.com`);
        }
        stripeMockState.createSession.mockClear();
        await checkout(app, 'extra@example.com');
        expect(stripeMockState.createSession).not.toHaveBeenCalled();
    });
});
