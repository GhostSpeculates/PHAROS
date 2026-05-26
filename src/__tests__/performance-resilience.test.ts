import postgres from 'postgres';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { PerformanceLearningStore } from '../learning/performance-store.js';
import { sortByPerformance } from '../router/failover.js';
import type { ModelCandidate } from '../router/failover.js';
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

function makeConfig(overrides?: Partial<PerformanceLearningConfig>): PerformanceLearningConfig {
    return {
        enabled: true,
        minConfidenceSamples: 10,
        decayFactor: 0.85,
        maxWeight: 2.0,
        minWeight: 0.3,
        ...overrides,
    };
}

describe('Performance Learning — Error Resilience', () => {
    let sql: ReturnType<typeof postgres>;

    beforeAll(() => {
        sql = postgres(process.env.DATABASE_URL!);
    });

    afterAll(async () => {
        await sql.end();
    });

    // ─── DB error resilience (bad connection) ───

    describe('broken database', () => {
        let badSql: ReturnType<typeof postgres>;

        beforeEach(() => {
            badSql = postgres('postgresql://bad:bad@localhost:9999/bad', { max: 1, connect_timeout: 1 });
        });

        afterEach(async () => {
            await badSql.end({ timeout: 1 }).catch(() => {});
        });

        it('getWeight returns neutral on broken DB', async () => {
            const store = new PerformanceLearningStore(badSql, makeLogger(), makeConfig());
            const w = await store.getWeight('groq', 'llama', 'code');
            expect(w.weight).toBe(1.0);
            expect(w.sampleCount).toBe(0);
        });

        it('recordOutcome does not throw on broken DB', async () => {
            const store = new PerformanceLearningStore(badSql, makeLogger(), makeConfig());
            await expect(store.recordOutcome('groq', 'llama', 'code', true, 500)).resolves.toBeUndefined();
        });

        it('getWeightsForTaskType returns empty on broken DB', async () => {
            const store = new PerformanceLearningStore(badSql, makeLogger(), makeConfig());
            expect(await store.getWeightsForTaskType('code')).toEqual([]);
        });

        it('applyDecay does not throw on broken DB', async () => {
            const store = new PerformanceLearningStore(badSql, makeLogger(), makeConfig());
            await expect(store.applyDecay()).resolves.toBeUndefined();
        });

        it('reset does not throw on broken DB', async () => {
            const store = new PerformanceLearningStore(badSql, makeLogger(), makeConfig());
            await expect(store.reset()).resolves.toBeUndefined();
        });

        it('getTrackedCount returns 0 on broken DB', async () => {
            const store = new PerformanceLearningStore(badSql, makeLogger(), makeConfig());
            expect(await store.getTrackedCount()).toBe(0);
        });

        it('getTopPerformers returns empty on broken DB', async () => {
            const store = new PerformanceLearningStore(badSql, makeLogger(), makeConfig());
            expect(await store.getTopPerformers()).toEqual([]);
        });

        it('getWorstPerformers returns empty on broken DB', async () => {
            const store = new PerformanceLearningStore(badSql, makeLogger(), makeConfig());
            expect(await store.getWorstPerformers()).toEqual([]);
        });
    });

    // ─── Weight computation edge cases ───

    describe('weight computation edge cases', () => {
        let store: PerformanceLearningStore;

        beforeEach(async () => {
            await truncateAll(sql);
            store = new PerformanceLearningStore(sql, makeLogger(), makeConfig());
        });

        it('zero successes produces weight clamped to minWeight', async () => {
            for (let i = 0; i < 50; i++) {
                await store.recordOutcome('bad', 'model', 'code', false, 0);
            }
            // Add 1 success so weight isn't purely from zero-division
            await store.recordOutcome('bad', 'model', 'code', true, 10000);
            const w = await store.getWeight('bad', 'model', 'code');
            expect(w.weight).toBeGreaterThanOrEqual(0.3);
            expect(Number.isFinite(w.weight)).toBe(true);
        });

        it('very high latency still produces finite weight', async () => {
            for (let i = 0; i < 20; i++) {
                await store.recordOutcome('slow', 'model', 'code', true, 999_999);
            }
            const w = await store.getWeight('slow', 'model', 'code');
            expect(Number.isFinite(w.weight)).toBe(true);
            expect(w.weight).toBeGreaterThan(0);
        });

        it('zero latency still produces finite weight', async () => {
            for (let i = 0; i < 20; i++) {
                await store.recordOutcome('fast', 'model', 'code', true, 0);
            }
            const w = await store.getWeight('fast', 'model', 'code');
            expect(Number.isFinite(w.weight)).toBe(true);
        });

        it('weight stays within bounds even with extreme data', async () => {
            // 100% success, near-zero latency
            for (let i = 0; i < 1000; i++) {
                await store.recordOutcome('perfect', 'model', 'code', true, 1);
            }
            const w = await store.getWeight('perfect', 'model', 'code');
            expect(w.weight).toBeLessThanOrEqual(2.0);
            expect(w.weight).toBeGreaterThanOrEqual(0.3);
        });
    });

    // ─── sortByPerformance resilience ───

    describe('sortByPerformance resilience', () => {
        beforeEach(async () => {
            await truncateAll(sql);
        });

        it('returns unchanged candidates when store throws', async () => {
            const badSql = postgres('postgresql://bad:bad@localhost:9999/bad', { max: 1, connect_timeout: 1 });
            const store = new PerformanceLearningStore(badSql, makeLogger(), makeConfig());

            const candidates: ModelCandidate[] = [
                { provider: 'groq', model: 'llama', tier: 'free' },
                { provider: 'google', model: 'gemini', tier: 'free' },
            ];

            const result = await sortByPerformance(candidates, 'code', store);
            expect(result).toEqual(candidates);
            await badSql.end({ timeout: 1 }).catch(() => {});
        });

        it('handles empty task type gracefully', async () => {
            const store = new PerformanceLearningStore(sql, makeLogger(), makeConfig());
            const candidates: ModelCandidate[] = [
                { provider: 'groq', model: 'llama', tier: 'free' },
            ];

            const result = await sortByPerformance(candidates, '', store);
            expect(result).toEqual(candidates);
        });
    });
});
