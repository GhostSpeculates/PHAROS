import { describe, it, expect } from 'vitest';
import { resolveTier, getTierFailoverOrder } from '../router/tier-resolver.js';
import type { PharosConfig } from '../config/schema.js';

/**
 * Build a minimal PharosConfig with the default tier score ranges.
 */
function makeConfig(overrides?: Partial<PharosConfig['tiers']>): PharosConfig {
    const defaultTiers: PharosConfig['tiers'] = {
        free: { scoreRange: [1, 3], models: [{ provider: 'google', model: 'gemini-2.0-flash' }] },
        economical: { scoreRange: [4, 6], models: [{ provider: 'deepseek', model: 'deepseek-chat' }] },
        premium: { scoreRange: [7, 8], models: [{ provider: 'anthropic', model: 'claude-sonnet-4-20250514' }] },
        frontier: { scoreRange: [9, 10], models: [{ provider: 'anthropic', model: 'claude-opus-4-20250514' }] },
    };

    return {
        server: { port: 3777, host: '0.0.0.0' },
        auth: { apiKey: '' },
        classifier: {
            providers: [{ provider: 'google', model: 'gemini-2.0-flash' }],
            fallbackTier: 'economical',
            timeoutMs: 5000,
        },
        tiers: { ...defaultTiers, ...overrides },
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
// resolveTier — default tier config
// ────────────────────────────────────────────────────────────────
describe('resolveTier', () => {
    const config = makeConfig();

    describe('default score-to-tier mapping', () => {
        it('maps score 1 to free', () => {
            expect(resolveTier(1, config)).toBe('free');
        });

        it('maps score 3 to free (upper boundary)', () => {
            expect(resolveTier(3, config)).toBe('free');
        });

        it('maps score 4 to economical (lower boundary)', () => {
            expect(resolveTier(4, config)).toBe('economical');
        });

        it('maps score 6 to economical (upper boundary)', () => {
            expect(resolveTier(6, config)).toBe('economical');
        });

        it('maps score 7 to premium (lower boundary)', () => {
            expect(resolveTier(7, config)).toBe('premium');
        });

        it('maps score 8 to premium (upper boundary)', () => {
            expect(resolveTier(8, config)).toBe('premium');
        });

        it('maps score 9 to frontier (lower boundary)', () => {
            expect(resolveTier(9, config)).toBe('frontier');
        });

        it('maps score 10 to frontier (upper boundary)', () => {
            expect(resolveTier(10, config)).toBe('frontier');
        });
    });

    describe('edge cases — out of range scores', () => {
        it('clamps score 0 up to 1 and resolves to free', () => {
            expect(resolveTier(0, config)).toBe('free');
        });

        it('clamps score -5 up to 1 and resolves to free', () => {
            expect(resolveTier(-5, config)).toBe('free');
        });

        it('clamps score 11 down to 10 and resolves to frontier', () => {
            expect(resolveTier(11, config)).toBe('frontier');
        });

        it('clamps score 100 down to 10 and resolves to frontier', () => {
            expect(resolveTier(100, config)).toBe('frontier');
        });

        it('rounds fractional scores (5.4 rounds to 5 -> economical)', () => {
            expect(resolveTier(5.4, config)).toBe('economical');
        });

        it('rounds fractional scores (6.6 rounds to 7 -> premium)', () => {
            expect(resolveTier(6.6, config)).toBe('premium');
        });
    });

    describe('custom tier configs', () => {
        it('resolves correctly with a wider free tier (1-5)', () => {
            const custom = makeConfig({
                free: { scoreRange: [1, 5], models: [{ provider: 'google', model: 'gemini-2.0-flash' }] },
                economical: { scoreRange: [6, 7], models: [{ provider: 'deepseek', model: 'deepseek-chat' }] },
                premium: { scoreRange: [8, 9], models: [{ provider: 'anthropic', model: 'claude-sonnet-4-20250514' }] },
                frontier: { scoreRange: [10, 10], models: [{ provider: 'anthropic', model: 'claude-opus-4-20250514' }] },
            });

            expect(resolveTier(1, custom)).toBe('free');
            expect(resolveTier(5, custom)).toBe('free');
            expect(resolveTier(6, custom)).toBe('economical');
            expect(resolveTier(7, custom)).toBe('economical');
            expect(resolveTier(8, custom)).toBe('premium');
            expect(resolveTier(9, custom)).toBe('premium');
            expect(resolveTier(10, custom)).toBe('frontier');
        });

        it('resolves with a single-score tier (frontier = 10 only)', () => {
            const custom = makeConfig({
                free: { scoreRange: [1, 4], models: [{ provider: 'google', model: 'gemini-2.0-flash' }] },
                economical: { scoreRange: [5, 7], models: [{ provider: 'deepseek', model: 'deepseek-chat' }] },
                premium: { scoreRange: [8, 9], models: [{ provider: 'anthropic', model: 'claude-sonnet-4-20250514' }] },
                frontier: { scoreRange: [10, 10], models: [{ provider: 'anthropic', model: 'claude-opus-4-20250514' }] },
            });

            expect(resolveTier(10, custom)).toBe('frontier');
            expect(resolveTier(9, custom)).toBe('premium');
        });
    });
});

// ────────────────────────────────────────────────────────────────
// getTierFailoverOrder
// ────────────────────────────────────────────────────────────────
describe('getTierFailoverOrder', () => {
    it('starting from free: free -> economical -> premium -> frontier', () => {
        expect(getTierFailoverOrder('free')).toEqual([
            'free',
            'economical',
            'premium',
            'frontier',
        ]);
    });

    it('starting from economical: economical -> premium -> frontier -> free', () => {
        expect(getTierFailoverOrder('economical')).toEqual([
            'economical',
            'premium',
            'frontier',
            'free',
        ]);
    });

    it('starting from premium: premium -> frontier -> economical -> free', () => {
        expect(getTierFailoverOrder('premium')).toEqual([
            'premium',
            'frontier',
            'economical',
            'free',
        ]);
    });

    it('starting from frontier: frontier -> premium -> economical -> free', () => {
        expect(getTierFailoverOrder('frontier')).toEqual([
            'frontier',
            'premium',
            'economical',
            'free',
        ]);
    });

    it('always returns exactly 4 tiers', () => {
        const tiers = ['free', 'economical', 'premium', 'frontier'] as const;
        for (const tier of tiers) {
            const order = getTierFailoverOrder(tier);
            expect(order).toHaveLength(4);
        }
    });

    it('always starts with the requested tier', () => {
        const tiers = ['free', 'economical', 'premium', 'frontier'] as const;
        for (const tier of tiers) {
            const order = getTierFailoverOrder(tier);
            expect(order[0]).toBe(tier);
        }
    });

    it('contains all four tiers (no duplicates, no missing)', () => {
        const allTiers = new Set(['free', 'economical', 'premium', 'frontier']);
        const tiers = ['free', 'economical', 'premium', 'frontier'] as const;
        for (const tier of tiers) {
            const order = getTierFailoverOrder(tier);
            expect(new Set(order)).toEqual(allTiers);
        }
    });
});
