import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../gateway/router.js';
import type { PharosConfig } from '../config/schema.js';
import type { QueryClassifier } from '../classifier/index.js';
import type { ModelRouter } from '../router/index.js';
import type { ProviderRegistry } from '../providers/index.js';
import { createLogger } from '../utils/logger.js';

/**
 * Phase 2.5 Tier 2 — tool_use parity for /v1/chat/completions.
 *
 * Mirrors messages-routes.test.ts tool_use suite but exercises the
 * OpenAI-shape route and asserts OpenAI-shape wire format:
 *  - request:  { tools: [{type:'function', function:{name,description,parameters}}], tool_choice }
 *  - response: { choices:[{message:{role,content,tool_calls:[...]}, finish_reason}] }
 *  - stream:   data: {choices:[{delta:{tool_calls:[{index,id,function:{name,arguments}}]}}]}
 */

function makeStubs(opts: {
    nonStreamingToolCalls?: Array<{ id: string; name: string; arguments: string }>;
    streamingChunks?: Array<{ content?: string; toolCalls?: any[]; finishReason?: string; usage?: any }>;
}) {
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
            type: 'tool_use' as const,
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
            classification: { score: 5, type: 'tool_use', latencyMs: 10 },
        })),
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

describe('POST /v1/chat/completions — tool use (Phase 2.5 Tier 2)', () => {
    let app: FastifyInstance;

    afterEach(async () => {
        if (app) await app.close();
    });

    it('passes OpenAI tools[] through to provider.chat() and returns tool_calls in choices', async () => {
        const stubs = makeStubs({
            nonStreamingToolCalls: [
                { id: 'call_abc', name: 'lookup_business', arguments: '{"name":"ABC"}' },
            ],
        });
        app = Fastify({ logger: false });
        registerRoutes(
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

        const res = await app.inject({
            method: 'POST',
            url: '/v1/chat/completions',
            headers: { authorization: 'Bearer test-operator-key' },
            payload: {
                model: 'pharos-auto',
                tools: [{
                    type: 'function',
                    function: {
                        name: 'lookup_business',
                        description: 'Look up a business by name',
                        parameters: { type: 'object', properties: { name: { type: 'string' } } },
                    },
                }],
                tool_choice: 'auto',
                messages: [{ role: 'user', content: 'Look up ABC' }],
            },
        });

        // Provider received OpenAI-shape tools + toolChoice
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
        expect(chatArgs.toolChoice).toBe('auto');

        // Response is OpenAI-shape with tool_calls in the assistant message
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.choices[0].finish_reason).toBe('tool_calls');
        expect(body.choices[0].message.role).toBe('assistant');
        expect(body.choices[0].message.tool_calls).toEqual([{
            id: 'call_abc',
            type: 'function',
            function: { name: 'lookup_business', arguments: '{"name":"ABC"}' },
        }]);
    });

    it('streams tool_calls in OpenAI delta format', async () => {
        const stubs = makeStubs({
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
        registerRoutes(
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

        const res = await app.inject({
            method: 'POST',
            url: '/v1/chat/completions',
            headers: { authorization: 'Bearer test-operator-key' },
            payload: {
                model: 'pharos-auto',
                stream: true,
                tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
                messages: [{ role: 'user', content: 'weather?' }],
            },
        });

        expect(res.statusCode).toBe(200);
        const body = res.body;
        // OpenAI streaming uses bare `data:` lines (no `event:` names).
        expect(body).toContain('"tool_calls":[{"index":0,"id":"call_xyz"');
        expect(body).toContain('"name":"get_weather"');
        expect(body).toContain('"arguments":"{\\"loc"');
        expect(body).toContain('"arguments":"ation\\":\\"NY\\"}"');
        expect(body).toContain('"finish_reason":"tool_calls"');
        expect(body).toContain('data: [DONE]');
    });

    it('omits tool_calls field when no tools were called', async () => {
        const stubs = makeStubs({});
        app = Fastify({ logger: false });
        registerRoutes(
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

        const res = await app.inject({
            method: 'POST',
            url: '/v1/chat/completions',
            headers: { authorization: 'Bearer test-operator-key' },
            payload: {
                model: 'pharos-auto',
                messages: [{ role: 'user', content: 'hi' }],
            },
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.choices[0].message.content).toBe('no-tools-here');
        expect(body.choices[0].message).not.toHaveProperty('tool_calls');
        expect(body.choices[0].finish_reason).toBe('stop');
    });
});
