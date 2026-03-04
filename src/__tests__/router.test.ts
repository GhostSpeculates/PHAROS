import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelRouter } from '../router/index.js';
import type { PharosConfig, TierName } from '../config/schema.js';
import type { ProviderRegistry } from '../providers/index.js';
import type { ClassificationResult } from '../classifier/types.js';
import type { Logger } from '../utils/logger.js';

// ─── Helpers ─────────────────────────────────────────────

function makeConfig(): PharosConfig {
    return {
        server: { port: 3777, host: '0.0.0.0' },
        auth: { apiKey: '' },
        classifier: {
            providers: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }],
            fallbackTier: 'economical',
            timeoutMs: 3000,
            maxConcurrent: 5,
            cacheMaxSize: 100,
            cacheTtlMs: 30000,
        },
        tiers: {
            free: {
                scoreRange: [1, 3],
                models: [{ provider: 'google', model: 'gemini-2.5-flash' }],
            },
            economical: {
                scoreRange: [4, 6],
                models: [
                    { provider: 'deepseek', model: 'deepseek-chat' },
                    { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
                ],
            },
            premium: {
                scoreRange: [7, 8],
                models: [
                    { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
                    { provider: 'openai', model: 'gpt-4o' },
                    { provider: 'deepseek', model: 'deepseek-chat' },
                ],
            },
            frontier: {
                scoreRange: [9, 10],
                models: [{ provider: 'anthropic', model: 'claude-opus-4-20250514' }],
            },
        },
        taskAffinity: {
            code: ['deepseek', 'together'],
            reasoning: ['anthropic', 'openai'],
        },
        providers: {},
        alerts: {},
        router: { oversizedThresholdTokens: 100000 },
        spending: { dailyLimit: null, monthlyLimit: null },
        tracking: {
            enabled: true,
            dbPath: './data/pharos.db',
            baselineModel: 'claude-sonnet-4-20250514',
            baselineCostPerMillionInput: 3.0,
            baselineCostPerMillionOutput: 15.0,
        },
        logging: { level: 'info', pretty: true },
    } as unknown as PharosConfig;
}

function makeRegistry(available: Record<string, boolean>): ProviderRegistry {
    return {
        isAvailable: (name: string) => available[name] ?? false,
        get: vi.fn(),
        getStatus: vi.fn(),
        listAvailable: vi.fn(),
    } as unknown as ProviderRegistry;
}

function makeClassification(score: number, type: string = 'analysis'): ClassificationResult {
    return {
        score,
        type: type as any,
        latencyMs: 100,
        isFallback: false,
        classifierProvider: 'groq',
    };
}

const logger: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
} as unknown as Logger;

// ─── Tests ───────────────────────────────────────────────

describe('ModelRouter', () => {
    let config: PharosConfig;

    beforeEach(() => {
        config = makeConfig();
        vi.clearAllMocks();
    });

    describe('route()', () => {
        it('routes score 1 to free tier', () => {
            const registry = makeRegistry({ google: true, deepseek: true, anthropic: true });
            const router = new ModelRouter(config, registry, logger);
            const result = router.route(makeClassification(1));

            expect(result.tier).toBe('free');
            expect(result.provider).toBe('google');
            expect(result.isDirectRoute).toBe(false);
        });

        it('routes score 5 to economical tier', () => {
            const registry = makeRegistry({ google: true, deepseek: true, anthropic: true });
            const router = new ModelRouter(config, registry, logger);
            const result = router.route(makeClassification(5));

            expect(result.tier).toBe('economical');
            expect(result.provider).toBe('deepseek');
        });

        it('routes score 7 to premium tier', () => {
            const registry = makeRegistry({ anthropic: true, openai: true });
            const router = new ModelRouter(config, registry, logger);
            const result = router.route(makeClassification(7));

            expect(result.tier).toBe('premium');
            expect(result.provider).toBe('anthropic');
        });

        it('routes score 10 to frontier tier', () => {
            const registry = makeRegistry({ anthropic: true });
            const router = new ModelRouter(config, registry, logger);
            const result = router.route(makeClassification(10));

            expect(result.tier).toBe('frontier');
            expect(result.provider).toBe('anthropic');
            expect(result.model).toBe('claude-opus-4-20250514');
        });

        it('uses failover when primary provider is down', () => {
            // Anthropic + deepseek down in premium → should failover to openai
            const registry = makeRegistry({ anthropic: false, openai: true, deepseek: false });
            const router = new ModelRouter(config, registry, logger);
            const result = router.route(makeClassification(7));

            expect(result.provider).toBe('openai');
            expect(result.model).toBe('gpt-4o');
            // Failover occurred — openai is not the first model in premium tier config
            expect(result.tier).toBe('premium');
        });
    });

    describe('routeDirect()', () => {
        it('routes to the specified provider and model', () => {
            const registry = makeRegistry({ anthropic: true });
            const router = new ModelRouter(config, registry, logger);
            const result = router.routeDirect('anthropic', 'claude-opus-4-20250514', makeClassification(9));

            expect(result.provider).toBe('anthropic');
            expect(result.model).toBe('claude-opus-4-20250514');
            expect(result.tier).toBe('frontier');
            expect(result.isDirectRoute).toBe(true);
            expect(result.failoverAttempts).toBe(0);
        });

        it('throws when provider is not available', () => {
            const registry = makeRegistry({ anthropic: false });
            const router = new ModelRouter(config, registry, logger);

            expect(() =>
                router.routeDirect('anthropic', 'claude-sonnet-4-20250514', makeClassification(5)),
            ).toThrow(/not available/);
        });

        it('defaults to premium tier for unknown model', () => {
            const registry = makeRegistry({ openai: true });
            const router = new ModelRouter(config, registry, logger);
            const result = router.routeDirect('openai', 'unknown-model', makeClassification(5));

            expect(result.tier).toBe('premium');
        });

        it('logs warning when model not found in any tier', () => {
            const registry = makeRegistry({ openai: true });
            const router = new ModelRouter(config, registry, logger);
            router.routeDirect('openai', 'unknown-model', makeClassification(5));

            expect(logger.warn).toHaveBeenCalledWith(
                expect.objectContaining({ provider: 'openai', model: 'unknown-model' }),
                expect.stringContaining('not found in any tier'),
            );
        });
    });

    describe('resolveDirectModel()', () => {
        it('returns null for "pharos-auto"', () => {
            const registry = makeRegistry({});
            const router = new ModelRouter(config, registry, logger);
            expect(router.resolveDirectModel('pharos-auto')).toBeNull();
        });

        it('returns null for "auto"', () => {
            const registry = makeRegistry({});
            const router = new ModelRouter(config, registry, logger);
            expect(router.resolveDirectModel('auto')).toBeNull();
        });

        it('returns null for empty string', () => {
            const registry = makeRegistry({});
            const router = new ModelRouter(config, registry, logger);
            expect(router.resolveDirectModel('')).toBeNull();
        });

        it('resolves a known model to provider + model', () => {
            const registry = makeRegistry({});
            const router = new ModelRouter(config, registry, logger);
            const result = router.resolveDirectModel('gpt-4o');

            expect(result).toEqual({ provider: 'openai', model: 'gpt-4o' });
        });

        it('returns null for unknown model', () => {
            const registry = makeRegistry({});
            const router = new ModelRouter(config, registry, logger);
            expect(router.resolveDirectModel('nonexistent-model')).toBeNull();
        });
    });

    describe('getCandidates()', () => {
        it('returns candidates in failover order for given classification', () => {
            const registry = makeRegistry({ google: true, deepseek: true, anthropic: true, openai: true });
            const router = new ModelRouter(config, registry, logger);
            const candidates = router.getCandidates(makeClassification(5));

            expect(candidates.length).toBeGreaterThan(0);
            // First candidate should be from economical tier
            expect(candidates[0].tier).toBe('economical');
        });

        it('sorts candidates by code affinity within tier', () => {
            const registry = makeRegistry({ anthropic: true, openai: true, deepseek: true });
            const router = new ModelRouter(config, registry, logger);
            const candidates = router.getCandidates(makeClassification(7, 'code'));

            // Premium tier has anthropic, openai, deepseek
            // Code affinity: deepseek first
            const premiumCandidates = candidates.filter(c => c.tier === 'premium');
            expect(premiumCandidates[0].provider).toBe('deepseek');
        });

        it('sorts candidates by reasoning affinity within tier', () => {
            const registry = makeRegistry({ anthropic: true, openai: true, deepseek: true });
            const router = new ModelRouter(config, registry, logger);
            const candidates = router.getCandidates(makeClassification(7, 'reasoning'));

            // Reasoning affinity: anthropic first, then openai
            const premiumCandidates = candidates.filter(c => c.tier === 'premium');
            expect(premiumCandidates[0].provider).toBe('anthropic');
            expect(premiumCandidates[1].provider).toBe('openai');
        });

        it('uses default order when no affinity for task type', () => {
            const registry = makeRegistry({ anthropic: true, openai: true, deepseek: true });
            const router = new ModelRouter(config, registry, logger);
            const candidates = router.getCandidates(makeClassification(7, 'greeting'));

            // No affinity for greeting — keeps config order
            const premiumCandidates = candidates.filter(c => c.tier === 'premium');
            expect(premiumCandidates[0].provider).toBe('anthropic');
        });
    });

    describe('resolveTaskTypeOverride()', () => {
        it('returns "code" for "pharos-code"', () => {
            const registry = makeRegistry({});
            const router = new ModelRouter(config, registry, logger);
            expect(router.resolveTaskTypeOverride('pharos-code')).toBe('code');
        });

        it('returns "math" for "pharos-math"', () => {
            const registry = makeRegistry({});
            const router = new ModelRouter(config, registry, logger);
            expect(router.resolveTaskTypeOverride('pharos-math')).toBe('math');
        });

        it('returns "creative" for "pharos-creative"', () => {
            const registry = makeRegistry({});
            const router = new ModelRouter(config, registry, logger);
            expect(router.resolveTaskTypeOverride('pharos-creative')).toBe('creative');
        });

        it('returns "reasoning" for "pharos-reasoning"', () => {
            const registry = makeRegistry({});
            const router = new ModelRouter(config, registry, logger);
            expect(router.resolveTaskTypeOverride('pharos-reasoning')).toBe('reasoning');
        });

        it('returns "conversation" for "pharos-conversation"', () => {
            const registry = makeRegistry({});
            const router = new ModelRouter(config, registry, logger);
            expect(router.resolveTaskTypeOverride('pharos-conversation')).toBe('conversation');
        });

        it('returns "analysis" for "pharos-analysis"', () => {
            const registry = makeRegistry({});
            const router = new ModelRouter(config, registry, logger);
            expect(router.resolveTaskTypeOverride('pharos-analysis')).toBe('analysis');
        });

        it('handles agent suffix (pharos-code:agent-name)', () => {
            const registry = makeRegistry({});
            const router = new ModelRouter(config, registry, logger);
            expect(router.resolveTaskTypeOverride('pharos-code:my-agent')).toBe('code');
        });

        it('returns null for "pharos-auto"', () => {
            const registry = makeRegistry({});
            const router = new ModelRouter(config, registry, logger);
            expect(router.resolveTaskTypeOverride('pharos-auto')).toBeNull();
        });

        it('returns null for empty string', () => {
            const registry = makeRegistry({});
            const router = new ModelRouter(config, registry, logger);
            expect(router.resolveTaskTypeOverride('')).toBeNull();
        });

        it('returns null for regular model name', () => {
            const registry = makeRegistry({});
            const router = new ModelRouter(config, registry, logger);
            expect(router.resolveTaskTypeOverride('gpt-4o')).toBeNull();
        });

        it('returns null for unknown pharos- prefix', () => {
            const registry = makeRegistry({});
            const router = new ModelRouter(config, registry, logger);
            expect(router.resolveTaskTypeOverride('pharos-unknown')).toBeNull();
        });
    });

    describe('resolveDirectModel() with virtual models', () => {
        it('returns null for pharos-code (virtual model)', () => {
            const registry = makeRegistry({});
            const router = new ModelRouter(config, registry, logger);
            expect(router.resolveDirectModel('pharos-code')).toBeNull();
        });

        it('returns null for pharos-math (virtual model)', () => {
            const registry = makeRegistry({});
            const router = new ModelRouter(config, registry, logger);
            expect(router.resolveDirectModel('pharos-math')).toBeNull();
        });

        it('returns null for pharos-code:agent-name (virtual + agent)', () => {
            const registry = makeRegistry({});
            const router = new ModelRouter(config, registry, logger);
            expect(router.resolveDirectModel('pharos-code:my-agent')).toBeNull();
        });
    });

    describe('route() with affinity', () => {
        it('routes code task to deepseek in premium tier', () => {
            const registry = makeRegistry({ anthropic: true, openai: true, deepseek: true });
            const router = new ModelRouter(config, registry, logger);
            const result = router.route(makeClassification(7, 'code'));

            // Code affinity prefers deepseek
            expect(result.provider).toBe('deepseek');
            expect(result.tier).toBe('premium');
        });

        it('routes reasoning task to anthropic in premium tier', () => {
            const registry = makeRegistry({ anthropic: true, openai: true, deepseek: true });
            const router = new ModelRouter(config, registry, logger);
            const result = router.route(makeClassification(7, 'reasoning'));

            // Reasoning affinity prefers anthropic
            expect(result.provider).toBe('anthropic');
            expect(result.tier).toBe('premium');
        });

        it('falls back when preferred provider is down', () => {
            const registry = makeRegistry({ anthropic: false, openai: true, deepseek: false });
            const router = new ModelRouter(config, registry, logger);
            const result = router.route(makeClassification(7, 'code'));

            // deepseek (preferred) is down, so falls through
            expect(result.provider).toBe('openai');
        });
    });
});
