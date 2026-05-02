import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerMessagesRoutes } from '../gateway/messages-routes.js';
import type { PharosConfig } from '../config/schema.js';
import type { QueryClassifier } from '../classifier/index.js';
import type { ModelRouter } from '../router/index.js';
import type { ProviderRegistry } from '../providers/index.js';
import { createLogger } from '../utils/logger.js';

// Minimal stubs — tests focus on the route's translation behavior, not the full router.
function makeStubs() {
    const logger = createLogger('error', false);

    const config = {
        auth: { apiKey: 'test-operator-key' },
        server: {
            agentRateLimitPerMinute: 1000,
            debugLogging: false,
            bodyLimitMb: 10,
            rateLimitPerMinute: 1000,
            host: '127.0.0.1',
            port: 0,
            selfTest: false,
        },
        spending: { dailyLimit: null, monthlyLimit: null },
        tracking: {
            enabled: false,
            dbPath: ':memory:',
            retentionDays: 30,
            baselineCostPerMillionInput: 3,
            baselineCostPerMillionOutput: 15,
        },
        tiers: {
            economical: { scoreRange: [4, 6], models: [{ provider: 'stub', model: 'stub-model' }] },
        },
        router: { oversizedThresholdTokens: 100000 },
    } as unknown as PharosConfig;

    const classifier = {
        classify: vi.fn(async () => ({
            score: 5,
            type: 'conversation' as const,
            classifierProvider: 'stub',
            latencyMs: 10,
            isFallback: false,
        })),
        getMetrics: vi.fn(() => ({})),
    } as unknown as QueryClassifier;

    const router = {
        resolveDirectModel: vi.fn(() => null),
        resolveTaskTypeOverride: vi.fn(() => null),
        route: vi.fn(() => ({
            tier: 'economical',
            provider: 'stub',
            model: 'stub-model',
            failoverAttempts: 0,
            isDirectRoute: false,
            classification: { score: 5, type: 'conversation', latencyMs: 10 },
        })),
        routeDirect: vi.fn(),
        getCandidates: vi.fn(() => [{ provider: 'stub', model: 'stub-model', tier: 'economical' }]),
    } as unknown as ModelRouter;

    const stubProvider = {
        chat: vi.fn(async () => ({
            content: 'Hi, friend.',
            model: 'stub-model',
            usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
            finishReason: 'stop',
        })),
        chatStream: vi.fn(async function* () {
            yield { content: 'Hi' };
            yield { content: ', friend.' };
            yield {
                content: '',
                finishReason: 'stop',
                usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
            };
        }),
        recordLatency: vi.fn(),
        undoLastError: vi.fn(),
    };
    const registry = {
        get: vi.fn(() => stubProvider),
        isAvailable: vi.fn(() => true),
        getStatus: vi.fn(() => ({})),
    } as unknown as ProviderRegistry;

    return { logger, config, classifier, router, registry };
}

describe('POST /v1/messages', () => {
    let app: FastifyInstance;

    beforeEach(async () => {
        app = Fastify({ logger: false });
        const stubs = makeStubs();
        registerMessagesRoutes(
            app,
            stubs.config,
            stubs.classifier,
            stubs.router,
            stubs.registry,
            null,
            stubs.logger,
            undefined,
            null,
            undefined,
            null,
        );
        await app.ready();
    });

    afterEach(async () => {
        await app.close();
    });

    it('returns Anthropic-shape response for a text request', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/messages',
            headers: { authorization: 'Bearer test-operator-key' },
            payload: {
                model: 'pharos-auto:scout',
                max_tokens: 200,
                messages: [{ role: 'user', content: 'Say hi in 5 words' }],
            },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.type).toBe('message');
        expect(body.role).toBe('assistant');
        expect(body.model).toBe('pharos-auto:scout');
        expect(body.content[0]).toEqual({ type: 'text', text: 'Hi, friend.' });
        expect(body.stop_reason).toBe('end_turn');
        expect(body.usage).toEqual({ input_tokens: 10, output_tokens: 4 });
    });

    it('rejects requests without auth', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/messages',
            payload: {
                model: 'pharos-auto',
                max_tokens: 100,
                messages: [{ role: 'user', content: 'hi' }],
            },
        });
        expect(res.statusCode).toBe(401);
    });

    it('rejects malformed Anthropic body', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/messages',
            headers: { authorization: 'Bearer test-operator-key' },
            payload: { model: 'pharos-auto' /* missing max_tokens, messages */ },
        });
        expect(res.statusCode).toBe(400);
    });
});
