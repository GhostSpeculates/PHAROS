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

describe('POST /v1/messages — tool use (Phase 2.5)', () => {
    /**
     * Phase 2.5 verifies tool calls flow end-to-end through both modes:
     * 1. Anthropic-shape `tools` arrive on request body
     * 2. Translator produces OpenAI-shape `tools` in chatRequest
     * 3. messages-routes wires tools through to provider.chat() / chatStream()
     * 4. Provider returns tool_calls (non-streaming) or surfaces them per-chunk (streaming)
     * 5. Translator emits Anthropic-shape `tool_use` blocks / events
     */

    function makeStubsWithToolCalls(opts: {
        nonStreamingToolCalls?: Array<{ id: string; name: string; arguments: string }>;
        streamingChunks?: Array<{ content?: string; toolCalls?: any[]; finishReason?: string; usage?: any }>;
    }) {
        const logger = createLogger('error', false);
        const config = {
            auth: { apiKey: 'test-operator-key' },
            server: { agentRateLimitPerMinute: 1000, debugLogging: false, bodyLimitMb: 10, rateLimitPerMinute: 1000, host: '127.0.0.1', port: 0, selfTest: false },
            spending: { dailyLimit: null, monthlyLimit: null },
            tracking: { enabled: false, dbPath: ':memory:', retentionDays: 30, baselineCostPerMillionInput: 3, baselineCostPerMillionOutput: 15 },
            tiers: { economical: { scoreRange: [4, 6], models: [{ provider: 'stub', model: 'stub-model' }] } },
            router: { oversizedThresholdTokens: 100000 },
        } as unknown as PharosConfig;

        const classifier = {
            classify: vi.fn(async () => ({ score: 5, type: 'tool_use' as const, classifierProvider: 'stub', latencyMs: 10, isFallback: false })),
            getMetrics: vi.fn(() => ({})),
        } as unknown as QueryClassifier;

        const router = {
            resolveDirectModel: vi.fn(() => null),
            resolveTaskTypeOverride: vi.fn(() => null),
            route: vi.fn(() => ({ tier: 'economical', provider: 'stub', model: 'stub-model', failoverAttempts: 0, isDirectRoute: false, classification: { score: 5, type: 'tool_use', latencyMs: 10 } })),
            routeDirect: vi.fn(),
            getCandidates: vi.fn(() => [{ provider: 'stub', model: 'stub-model', tier: 'economical' }]),
        } as unknown as ModelRouter;

        const stubProvider = {
            chat: vi.fn(async (_req: any) => ({
                content: opts.nonStreamingToolCalls ? '' : 'no-tools-here',
                model: 'stub-model',
                usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 },
                finishReason: opts.nonStreamingToolCalls ? 'tool_calls' : 'stop',
                ...(opts.nonStreamingToolCalls && {
                    toolCalls: opts.nonStreamingToolCalls.map((tc) => ({
                        id: tc.id,
                        type: 'function' as const,
                        function: { name: tc.name, arguments: tc.arguments },
                    })),
                }),
            })),
            chatStream: vi.fn(async function* () {
                if (!opts.streamingChunks) return;
                for (const chunk of opts.streamingChunks) {
                    yield chunk;
                }
            }),
            recordLatency: vi.fn(),
            undoLastError: vi.fn(),
        };

        const registry = {
            get: vi.fn(() => stubProvider),
            isAvailable: vi.fn(() => true),
            getStatus: vi.fn(() => ({})),
        } as unknown as ProviderRegistry;

        return { logger, config, classifier, router, registry, stubProvider };
    }

    let app: FastifyInstance;

    afterEach(async () => {
        if (app) await app.close();
    });

    it('passes Anthropic tools[] through to provider.chat() as OpenAI tools[]', async () => {
        const stubs = makeStubsWithToolCalls({
            nonStreamingToolCalls: [
                { id: 'toolu_abc', name: 'lookup_business', arguments: '{"name":"ABC"}' },
            ],
        });
        app = Fastify({ logger: false });
        registerMessagesRoutes(app, stubs.config, stubs.classifier, stubs.router, stubs.registry, null, stubs.logger, undefined, null, undefined, null);
        await app.ready();

        const res = await app.inject({
            method: 'POST',
            url: '/v1/messages',
            headers: { authorization: 'Bearer test-operator-key' },
            payload: {
                model: 'pharos-auto:scout',
                max_tokens: 200,
                tools: [{
                    name: 'lookup_business',
                    description: 'Look up a business by name',
                    input_schema: { type: 'object', properties: { name: { type: 'string' } } },
                }],
                messages: [{ role: 'user', content: 'Look up ABC' }],
            },
        });

        // Verify provider was called with OpenAI-shape tools
        expect(stubs.stubProvider.chat).toHaveBeenCalledTimes(1);
        const chatArgs = stubs.stubProvider.chat.mock.calls[0][0];
        expect(chatArgs.tools).toEqual([{
            type: 'function',
            function: {
                name: 'lookup_business',
                description: 'Look up a business by name',
                parameters: { type: 'object', properties: { name: { type: 'string' } } },
            },
        }]);

        // Verify response is Anthropic-shape with tool_use content block
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.stop_reason).toBe('tool_use');
        expect(body.content).toContainEqual({
            type: 'tool_use',
            id: 'toolu_abc',
            name: 'lookup_business',
            input: { name: 'ABC' },
        });
    });

    it('streams tool_calls as Anthropic content_block events', async () => {
        const stubs = makeStubsWithToolCalls({
            streamingChunks: [
                {
                    toolCalls: [
                        { index: 0, id: 'call_xyz', type: 'function', function: { name: 'get_weather', arguments: '' } },
                    ],
                },
                {
                    toolCalls: [{ index: 0, function: { arguments: '{"loc' } }],
                },
                {
                    toolCalls: [{ index: 0, function: { arguments: 'ation":"NY"}' } }],
                },
                {
                    content: '',
                    finishReason: 'tool_calls',
                    usage: { promptTokens: 50, completionTokens: 8, totalTokens: 58 },
                },
            ],
        });
        app = Fastify({ logger: false });
        registerMessagesRoutes(app, stubs.config, stubs.classifier, stubs.router, stubs.registry, null, stubs.logger, undefined, null, undefined, null);
        await app.ready();

        const res = await app.inject({
            method: 'POST',
            url: '/v1/messages',
            headers: { authorization: 'Bearer test-operator-key' },
            payload: {
                model: 'pharos-auto:scout',
                max_tokens: 200,
                stream: true,
                tools: [{ name: 'get_weather', input_schema: { type: 'object' } }],
                messages: [{ role: 'user', content: 'weather?' }],
            },
        });

        expect(res.statusCode).toBe(200);
        const body = res.body;
        // Should contain the strict Anthropic event sequence with tool_use blocks
        expect(body).toContain('event: message_start');
        expect(body).toContain('event: content_block_start');
        expect(body).toContain('"type":"tool_use"');
        expect(body).toContain('"name":"get_weather"');
        expect(body).toContain('event: content_block_delta');
        expect(body).toContain('"type":"input_json_delta"');
        expect(body).toContain('"partial_json":"{\\"loc"');
        expect(body).toContain('"partial_json":"ation\\":\\"NY\\"}"');
        expect(body).toContain('event: content_block_stop');
        expect(body).toContain('event: message_delta');
        expect(body).toContain('"stop_reason":"tool_use"');
        expect(body).toContain('event: message_stop');
    });
});
