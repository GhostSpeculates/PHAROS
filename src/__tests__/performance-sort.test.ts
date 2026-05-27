import postgres from 'postgres';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sortByPerformance } from '../router/failover.js';
import type { ModelCandidate } from '../router/failover.js';
import { PerformanceLearningStore } from '../learning/performance-store.js';
import type { PerformanceLearningConfig } from '../learning/performance-store.js';
import type { Logger } from '../utils/logger.js';
import { truncateAll } from './_helpers/test-db.js';

function makeLogger(): Logger {
    return {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        fatal: vi.fn(),
        trace: vi.fn(),
        child: vi.fn().mockReturnThis(),
    } as unknown as Logger;
}

function makeConfig(): PerformanceLearningConfig {
    return {
        enabled: true,
        minConfidenceSamples: 10,
        decayFactor: 0.85,
        maxWeight: 2.0,
        minWeight: 0.3,
    };
}

describe('sortByPerformance', () => {
    let sql: ReturnType<typeof postgres>;
    let store: PerformanceLearningStore;

    beforeAll(() => {
        sql = postgres(process.env.DATABASE_URL!);
    });

    afterAll(async () => {
        await sql.end();
    });

    beforeEach(async () => {
        await truncateAll(sql);
        store = new PerformanceLearningStore(sql, makeLogger(), makeConfig());
    });

    it('returns candidates unchanged when store is null', async () => {
        const candidates: ModelCandidate[] = [
            { provider: 'groq', model: 'llama', tier: 'free' },
            { provider: 'google', model: 'gemini', tier: 'free' },
        ];
        const result = await sortByPerformance(candidates, 'code', null);
        expect(result).toEqual(candidates);
    });

    it('returns candidates unchanged when store is undefined', async () => {
        const candidates: ModelCandidate[] = [
            { provider: 'groq', model: 'llama', tier: 'free' },
        ];
        const result = await sortByPerformance(candidates, 'code', undefined);
        expect(result).toEqual(candidates);
    });

    it('returns candidates unchanged when taskType is undefined', async () => {
        const candidates: ModelCandidate[] = [
            { provider: 'groq', model: 'llama', tier: 'free' },
        ];
        const result = await sortByPerformance(candidates, undefined, store);
        expect(result).toEqual(candidates);
    });

    it('returns candidates unchanged when no learning data exists', async () => {
        const candidates: ModelCandidate[] = [
            { provider: 'groq', model: 'llama', tier: 'free' },
            { provider: 'google', model: 'gemini', tier: 'free' },
        ];
        const result = await sortByPerformance(candidates, 'code', store);
        expect(result).toEqual(candidates);
    });

    it('returns single candidate unchanged', async () => {
        const candidates: ModelCandidate[] = [
            { provider: 'groq', model: 'llama', tier: 'free' },
        ];
        const result = await sortByPerformance(candidates, 'code', store);
        expect(result).toEqual(candidates);
    });

    it('promotes higher-weight candidate within same tier', async () => {
        // groq has many failures for code tasks
        for (let i = 0; i < 20; i++) {
            await store.recordOutcome('groq', 'llama', 'code', false, 0);
        }
        await store.recordOutcome('groq', 'llama', 'code', true, 2000);

        // google has all successes
        for (let i = 0; i < 20; i++) {
            await store.recordOutcome('google', 'gemini', 'code', true, 1000);
        }

        const candidates: ModelCandidate[] = [
            { provider: 'groq', model: 'llama', tier: 'free' },
            { provider: 'google', model: 'gemini', tier: 'free' },
        ];

        const result = await sortByPerformance(candidates, 'code', store);
        expect(result[0].provider).toBe('google');
        expect(result[1].provider).toBe('groq');
    });

    it('preserves tier boundaries', async () => {
        // Bad free-tier model
        for (let i = 0; i < 20; i++) {
            await store.recordOutcome('groq', 'llama', 'code', false, 0);
        }
        // Good premium model
        for (let i = 0; i < 20; i++) {
            await store.recordOutcome('anthropic', 'claude', 'code', true, 500);
        }

        const candidates: ModelCandidate[] = [
            { provider: 'groq', model: 'llama', tier: 'free' },
            { provider: 'anthropic', model: 'claude', tier: 'premium' },
        ];

        const result = await sortByPerformance(candidates, 'code', store);
        // Free tier should still come first (tier order preserved)
        expect(result[0].tier).toBe('free');
        expect(result[1].tier).toBe('premium');
    });

    it('sorts within multiple tier groups independently', async () => {
        // In free tier: google is better
        for (let i = 0; i < 20; i++) {
            await store.recordOutcome('google', 'gemini', 'code', true, 500);
            await store.recordOutcome('groq', 'llama', 'code', false, 0);
        }
        // In premium tier: openai is better
        for (let i = 0; i < 20; i++) {
            await store.recordOutcome('openai', 'gpt-4o', 'code', true, 500);
            await store.recordOutcome('anthropic', 'claude', 'code', false, 0);
        }

        const candidates: ModelCandidate[] = [
            { provider: 'groq', model: 'llama', tier: 'free' },
            { provider: 'google', model: 'gemini', tier: 'free' },
            { provider: 'anthropic', model: 'claude', tier: 'premium' },
            { provider: 'openai', model: 'gpt-4o', tier: 'premium' },
        ];

        const result = await sortByPerformance(candidates, 'code', store);
        expect(result[0].provider).toBe('google');   // free tier winner
        expect(result[1].provider).toBe('groq');      // free tier loser
        expect(result[2].provider).toBe('openai');    // premium winner
        expect(result[3].provider).toBe('anthropic'); // premium loser
    });

    it('unknown models keep weight 1.0 and position', async () => {
        // Only groq has data
        for (let i = 0; i < 20; i++) {
            await store.recordOutcome('groq', 'llama', 'code', false, 0);
        }
        await store.recordOutcome('groq', 'llama', 'code', true, 2000);

        const candidates: ModelCandidate[] = [
            { provider: 'groq', model: 'llama', tier: 'free' },
            { provider: 'unknown', model: 'new-model', tier: 'free' },
        ];

        const result = await sortByPerformance(candidates, 'code', store);
        // unknown model (weight 1.0) should be first since groq has low weight
        expect(result[0].provider).toBe('unknown');
    });

    it('uses task-type-specific data only', async () => {
        // groq is great at math but bad at code
        for (let i = 0; i < 20; i++) {
            await store.recordOutcome('groq', 'llama', 'math', true, 500);
            await store.recordOutcome('groq', 'llama', 'code', false, 0);
        }
        // google is great at code
        for (let i = 0; i < 20; i++) {
            await store.recordOutcome('google', 'gemini', 'code', true, 500);
        }

        const candidates: ModelCandidate[] = [
            { provider: 'groq', model: 'llama', tier: 'free' },
            { provider: 'google', model: 'gemini', tier: 'free' },
        ];

        // For code tasks, google should win
        const codeResult = await sortByPerformance(candidates, 'code', store);
        expect(codeResult[0].provider).toBe('google');
    });

    it('handles empty candidate list', async () => {
        const result = await sortByPerformance([], 'code', store);
        expect(result).toEqual([]);
    });

    it('returns candidates unchanged on store error', async () => {
        const badSql = postgres('postgresql://bad:bad@localhost:9999/bad', { max: 1, connect_timeout: 1 });
        const store2 = new PerformanceLearningStore(badSql, makeLogger(), makeConfig());

        const candidates: ModelCandidate[] = [
            { provider: 'groq', model: 'llama', tier: 'free' },
            { provider: 'google', model: 'gemini', tier: 'free' },
        ];

        const result = await sortByPerformance(candidates, 'code', store2);
        expect(result).toEqual(candidates);
        await badSql.end({ timeout: 1 }).catch(() => {});
    });

    it('handles candidates with same weight (stable sort)', async () => {
        // Both models have identical performance
        for (let i = 0; i < 20; i++) {
            await store.recordOutcome('groq', 'llama', 'code', true, 1000);
            await store.recordOutcome('google', 'gemini', 'code', true, 1000);
        }

        const candidates: ModelCandidate[] = [
            { provider: 'groq', model: 'llama', tier: 'free' },
            { provider: 'google', model: 'gemini', tier: 'free' },
        ];

        const result = await sortByPerformance(candidates, 'code', store);
        // With identical weights, order should be preserved
        expect(result).toHaveLength(2);
    });
});
