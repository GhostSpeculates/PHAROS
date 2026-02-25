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
                models: [{ provider: 'google', model: 'gemini-2.0-flash' }],
            },
            economical: {
                scoreRange: [4, 6],
                models: [{ provider: 'deepseek', model: 'deepseek-chat' }],
            },
            premium: {
                scoreRange: [7, 8],
                models: [
                    { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
                    { provider: 'openai', model: 'gpt-4o' },
                ],
            },
            frontier: {
                scoreRange: [9, 10],
                models: [{ provider: 'anthropic', model: 'claude-opus-4-20250514' }],
            },
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
            // Anthropic down in premium → should failover to openai
            const registry = makeRegistry({ anthropic: false, openai: true });
            const router = new ModelRouter(config, registry, logger);
            const result = router.route(makeClassification(7));

            expect(result.provider).toBe('openai');
            expect(result.model).toBe('gpt-4o');
            expect(result.failoverAttempts).toBeGreaterThan(0);
        });
    });

    describe('routeDirect()', () => {
        it('routes to the specified provider and model', () => {
            const registry = makeRegistry({ anthropic: true });
            const router = new ModelRouter(config, registry, logger);
            const result = router.routeDirect('anthropic', 'claude-sonnet-4-20250514', makeClassification(5));

            expect(result.provider).toBe('anthropic');
            expect(result.model).toBe('claude-sonnet-4-20250514');
            expect(result.tier).toBe('premium');
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
    });
});
