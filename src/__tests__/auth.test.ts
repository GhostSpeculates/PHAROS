import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAuthMiddleware } from '../gateway/middleware/auth.js';
import type { PharosConfig } from '../config/schema.js';

/**
 * Create a mock Fastify request object.
 */
function mockRequest(headers: Record<string, string | undefined> = {}) {
    return { headers } as any;
}

/**
 * Create a mock Fastify reply object that tracks status and send calls.
 */
function mockReply() {
    const reply: any = {
        statusCode: 200,
        body: null,
        status(code: number) {
            reply.statusCode = code;
            return reply;
        },
        send(body: any) {
            reply.body = body;
            return reply;
        },
    };
    return reply;
}

/**
 * Build a minimal PharosConfig for auth tests.
 */
function makeConfig(apiKey: string): PharosConfig {
    return {
        server: { port: 3777, host: '0.0.0.0' },
        auth: { apiKey },
        classifier: {
            provider: 'google',
            model: 'gemini-2.0-flash',
            fallbackTier: 'economical',
            timeoutMs: 5000,
        },
        tiers: {
            free: { scoreRange: [1, 3], models: [{ provider: 'google', model: 'gemini-2.0-flash' }] },
            economical: { scoreRange: [4, 6], models: [{ provider: 'deepseek', model: 'deepseek-chat' }] },
            premium: { scoreRange: [7, 8], models: [{ provider: 'anthropic', model: 'claude-sonnet-4-20250514' }] },
            frontier: { scoreRange: [9, 10], models: [{ provider: 'anthropic', model: 'claude-opus-4-20250514' }] },
        },
        providers: {},
        tracking: {
            enabled: true,
            dbPath: './data/pharos.db',
            baselineModel: 'claude-sonnet-4-20250514',
            baselineCostPerMillionInput: 3.0,
            baselineCostPerMillionOutput: 15.0,
        },
        logging: { level: 'info', pretty: true },
    } as PharosConfig;
}

// ────────────────────────────────────────────────────────────────
// Auth Middleware Tests
// ────────────────────────────────────────────────────────────────
describe('createAuthMiddleware', () => {
    describe('when API key is configured', () => {
        const config = makeConfig('test-secret-key');
        const middleware = createAuthMiddleware(config);

        it('rejects requests without Authorization header (401)', async () => {
            const req = mockRequest({});
            const reply = mockReply();

            const result = await middleware(req, reply);

            expect(reply.statusCode).toBe(401);
            expect(reply.body).toBeDefined();
            expect(reply.body.error).toBeDefined();
            expect(reply.body.error.code).toBe('missing_api_key');
            expect(reply.body.error.type).toBe('authentication_error');
            expect(result).toBe(reply); // returns reply to short-circuit
        });

        it('passes requests with correct Bearer token', async () => {
            const req = mockRequest({ authorization: 'Bearer test-secret-key' });
            const reply = mockReply();

            const result = await middleware(req, reply);

            // Should return undefined (no early return), meaning the request passes through
            expect(result).toBeUndefined();
            expect(reply.statusCode).toBe(200); // status unchanged
            expect(reply.body).toBeNull(); // send never called
        });

        it('rejects requests with wrong Bearer token (401)', async () => {
            const req = mockRequest({ authorization: 'Bearer wrong-key' });
            const reply = mockReply();

            const result = await middleware(req, reply);

            expect(reply.statusCode).toBe(401);
            expect(reply.body).toBeDefined();
            expect(reply.body.error.code).toBe('invalid_api_key');
            expect(reply.body.error.type).toBe('authentication_error');
            expect(result).toBe(reply);
        });

        it('rejects requests with empty Bearer token (401)', async () => {
            const req = mockRequest({ authorization: 'Bearer ' });
            const reply = mockReply();

            const result = await middleware(req, reply);

            expect(reply.statusCode).toBe(401);
            expect(reply.body.error.code).toBe('invalid_api_key');
        });

        it('rejects requests with non-Bearer auth scheme', async () => {
            const req = mockRequest({ authorization: 'Basic dXNlcjpwYXNz' });
            const reply = mockReply();

            const result = await middleware(req, reply);

            expect(reply.statusCode).toBe(401);
            expect(reply.body.error.code).toBe('invalid_api_key');
        });
    });

    describe('when no API key is configured (open mode)', () => {
        const config = makeConfig('');
        const middleware = createAuthMiddleware(config);

        it('skips auth and lets requests through without any header', async () => {
            const req = mockRequest({});
            const reply = mockReply();

            const result = await middleware(req, reply);

            expect(result).toBeUndefined();
            expect(reply.statusCode).toBe(200);
            expect(reply.body).toBeNull();
        });

        it('skips auth even when an Authorization header is present', async () => {
            const req = mockRequest({ authorization: 'Bearer some-key' });
            const reply = mockReply();

            const result = await middleware(req, reply);

            expect(result).toBeUndefined();
            expect(reply.statusCode).toBe(200);
            expect(reply.body).toBeNull();
        });
    });

    describe('different API key values', () => {
        it('works with long complex API keys', async () => {
            const longKey = 'sk-pharos-abcdef1234567890abcdef1234567890abcdef1234567890';
            const config = makeConfig(longKey);
            const middleware = createAuthMiddleware(config);

            const req = mockRequest({ authorization: `Bearer ${longKey}` });
            const reply = mockReply();

            const result = await middleware(req, reply);
            expect(result).toBeUndefined();
        });

        it('is case-sensitive for API keys', async () => {
            const config = makeConfig('MySecretKey');
            const middleware = createAuthMiddleware(config);

            const req = mockRequest({ authorization: 'Bearer mysecretkey' });
            const reply = mockReply();

            const result = await middleware(req, reply);
            expect(reply.statusCode).toBe(401);
        });
    });
});
