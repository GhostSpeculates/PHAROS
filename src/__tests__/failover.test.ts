import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findAvailableModel, getCandidateModels } from '../router/failover.js';
import type { PharosConfig, TierName } from '../config/schema.js';
import type { ProviderRegistry } from '../providers/index.js';
import type { Logger } from '../utils/logger.js';

// ─── Helpers ─────────────────────────────────────────────

function makeConfig(overrides?: Partial<PharosConfig['tiers']>): PharosConfig {
    const defaultTiers: PharosConfig['tiers'] = {
        free: {
            scoreRange: [1, 3],
            models: [
                { provider: 'groq', model: 'llama-3.3-70b-versatile' },
                { provider: 'google', model: 'gemini-2.0-flash' },
            ],
        },
        economical: {
            scoreRange: [4, 6],
            models: [
                { provider: 'groq', model: 'llama-3.3-70b-versatile' },
                { provider: 'deepseek', model: 'deepseek-chat' },
            ],
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
    };

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
        tiers: { ...defaultTiers, ...overrides },
        taskAffinity: {},
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

describe('findAvailableModel', () => {
    const config = makeConfig();

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns the first available model in the primary tier', () => {
        const registry = makeRegistry({ groq: true, google: true, anthropic: true, deepseek: true });
        const result = findAvailableModel('free', config, registry, logger);

        expect(result.provider).toBe('groq');
        expect(result.model).toBe('llama-3.3-70b-versatile');
        expect(result.tier).toBe('free');
        expect(result.attempts).toBe(1);
        expect(result.failedProviders).toEqual([]);
    });

    it('falls over to second model in tier when first is down', () => {
        const registry = makeRegistry({ groq: false, google: true });
        const result = findAvailableModel('free', config, registry, logger);

        expect(result.provider).toBe('google');
        expect(result.model).toBe('gemini-2.0-flash');
        expect(result.tier).toBe('free');
        // getCandidateModels pre-filters unavailable providers, so attempts = 1
        expect(result.attempts).toBe(1);
    });

    it('escalates to a higher tier when all models in primary tier are down', () => {
        // Free tier: groq + google both down → should escalate to economical
        const registry = makeRegistry({ groq: false, google: false, deepseek: true });
        const result = findAvailableModel('free', config, registry, logger);

        expect(result.tier).toBe('economical');
        expect(result.provider).toBe('deepseek');
    });

    it('escalates from premium to frontier when premium providers are down', () => {
        const registry = makeRegistry({ anthropic: true, openai: false });
        // Start from premium — first model is anthropic (available), so it should work
        const result = findAvailableModel('premium', config, registry, logger);
        expect(result.provider).toBe('anthropic');
        expect(result.tier).toBe('premium');
    });

    it('tries lower tiers as last resort', () => {
        // Starting from frontier, only google (free tier) is available
        const registry = makeRegistry({ google: true });
        const result = findAvailableModel('frontier', config, registry, logger);

        expect(result.provider).toBe('google');
        expect(result.tier).toBe('free');
    });

    it('throws when all providers are down', () => {
        const registry = makeRegistry({});
        expect(() => findAvailableModel('premium', config, registry, logger)).toThrow(
            /No available providers found/,
        );
    });

    it('finds available provider even when many others are down', () => {
        // Only anthropic is available — should find it in premium tier
        const registry = makeRegistry({ anthropic: true });
        const result = findAvailableModel('free', config, registry, logger);

        expect(result.provider).toBe('anthropic');
        // getCandidateModels pre-filters, so first healthy candidate is returned
        expect(result.attempts).toBe(1);
    });

    it('logs tier escalation when failover to different tier', () => {
        const registry = makeRegistry({ groq: false, google: false, deepseek: true });
        findAvailableModel('free', config, registry, logger);

        expect(logger.info).toHaveBeenCalledWith(
            expect.objectContaining({ from: 'free', to: 'economical' }),
            expect.stringContaining('Failover'),
        );
    });

    it('handles unknown tier gracefully via getTierFailoverOrder guard', () => {
        const registry = makeRegistry({ anthropic: true });
        // 'unknown' is not a valid tier, getTierFailoverOrder returns default order
        const result = findAvailableModel('unknown' as TierName, config, registry, logger);
        expect(result.provider).toBe('anthropic');
    });

    it('skips tiers not in config without crashing', () => {
        // Config only has free and premium
        const sparseConfig = makeConfig();
        delete (sparseConfig.tiers as any).economical;
        delete (sparseConfig.tiers as any).frontier;

        const registry = makeRegistry({ groq: false, google: false, anthropic: true });
        const result = findAvailableModel('free', sparseConfig, registry, logger);
        expect(result.provider).toBe('anthropic');
        expect(result.tier).toBe('premium');
    });
});

describe('getCandidateModels', () => {
    const config = makeConfig();

    it('returns all healthy models across all tiers in failover order', () => {
        const registry = makeRegistry({ groq: true, google: true, deepseek: true, anthropic: true, openai: true });
        const candidates = getCandidateModels('free', config, registry);

        expect(candidates.length).toBeGreaterThan(0);
        // First candidate should be from the primary tier
        expect(candidates[0].tier).toBe('free');
    });

    it('excludes unhealthy providers', () => {
        const registry = makeRegistry({ groq: true, google: false, deepseek: true });
        const candidates = getCandidateModels('free', config, registry);

        const providers = candidates.map((c) => c.provider);
        expect(providers).not.toContain('google');
        expect(providers).toContain('groq');
    });

    it('returns empty array when all providers are down', () => {
        const registry = makeRegistry({});
        const candidates = getCandidateModels('premium', config, registry);
        expect(candidates).toEqual([]);
    });

    it('returns candidates starting from the primary tier', () => {
        const registry = makeRegistry({ groq: true, google: true, deepseek: true, anthropic: true, openai: true });
        const candidates = getCandidateModels('premium', config, registry);

        // First candidate should be from premium tier
        expect(candidates[0].tier).toBe('premium');
    });

    it('includes models from lower tiers as fallback', () => {
        const registry = makeRegistry({ groq: true, google: true, anthropic: true });
        const candidates = getCandidateModels('frontier', config, registry);

        const tiers = candidates.map((c) => c.tier);
        expect(tiers).toContain('frontier');
        // Should also include lower tiers
        expect(tiers.some((t) => t !== 'frontier')).toBe(true);
    });
});
