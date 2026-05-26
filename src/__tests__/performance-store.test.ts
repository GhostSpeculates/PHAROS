import postgres from 'postgres';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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

describe('PerformanceLearningStore', () => {
    let sql: ReturnType<typeof postgres>;
    let store: PerformanceLearningStore;
    let logger: Logger;

    beforeAll(() => {
        sql = postgres(process.env.DATABASE_URL!);
    });

    afterAll(async () => {
        await sql.end();
    });

    beforeEach(async () => {
        await truncateAll(sql);
        logger = makeLogger();
        store = new PerformanceLearningStore(sql, logger, makeConfig());
    });

    // ─── recordOutcome ───

    it('records a successful outcome', async () => {
        await store.recordOutcome('groq', 'llama-3.3', 'code', true, 500);
        const w = await store.getWeight('groq', 'llama-3.3', 'code');
        expect(w.sampleCount).toBe(1);
        expect(w.successRate).toBe(1);
    });

    it('records a failed outcome', async () => {
        await store.recordOutcome('groq', 'llama-3.3', 'code', false, 0);
        const w = await store.getWeight('groq', 'llama-3.3', 'code');
        expect(w.sampleCount).toBe(1);
        expect(w.successRate).toBe(0);
    });

    it('accumulates multiple outcomes', async () => {
        await store.recordOutcome('groq', 'llama-3.3', 'code', true, 500);
        await store.recordOutcome('groq', 'llama-3.3', 'code', true, 600);
        await store.recordOutcome('groq', 'llama-3.3', 'code', false, 0);
        const w = await store.getWeight('groq', 'llama-3.3', 'code');
        expect(w.sampleCount).toBe(3);
        expect(w.successRate).toBeCloseTo(2 / 3, 2);
    });

    it('tracks different task types separately', async () => {
        await store.recordOutcome('groq', 'llama-3.3', 'code', true, 500);
        await store.recordOutcome('groq', 'llama-3.3', 'math', false, 0);
        expect((await store.getWeight('groq', 'llama-3.3', 'code')).successRate).toBe(1);
        expect((await store.getWeight('groq', 'llama-3.3', 'math')).successRate).toBe(0);
    });

    it('tracks different providers separately', async () => {
        await store.recordOutcome('groq', 'model-a', 'code', true, 500);
        await store.recordOutcome('openai', 'model-b', 'code', false, 0);
        expect((await store.getWeight('groq', 'model-a', 'code')).successRate).toBe(1);
        expect((await store.getWeight('openai', 'model-b', 'code')).successRate).toBe(0);
    });

    it('does not count latency for failed outcomes', async () => {
        await store.recordOutcome('groq', 'llama-3.3', 'code', false, 5000);
        const w = await store.getWeight('groq', 'llama-3.3', 'code');
        // With zero successes, avgLatencyMs falls back to the median baseline (2000ms)
        expect(w.avgLatencyMs).toBe(2000);
        // Verify the stored latency is 0 (failures don't add latency)
        const rows = await sql`SELECT total_latency_ms FROM model_performance`;
        expect(Number(rows[0].total_latency_ms)).toBe(0);
    });

    it('clamps negative latency to 0', async () => {
        await store.recordOutcome('groq', 'llama-3.3', 'code', true, -100);
        const rows = await sql`SELECT total_latency_ms FROM model_performance`;
        expect(Number(rows[0].total_latency_ms)).toBe(0);
    });

    // ─── getWeight ───

    it('returns neutral weight (1.0) for unknown model', async () => {
        const w = await store.getWeight('unknown', 'unknown-model', 'code');
        expect(w.weight).toBe(1.0);
        expect(w.sampleCount).toBe(0);
    });

    it('weights stay near 1.0 with low sample counts (confidence)', async () => {
        // With only 1 sample (confidence = 0.1), weight should be near 1.0
        await store.recordOutcome('groq', 'llama-3.3', 'code', true, 2000);
        const w = await store.getWeight('groq', 'llama-3.3', 'code');
        expect(w.weight).toBeGreaterThan(0.9);
        expect(w.weight).toBeLessThan(1.1);
    });

    it('weights diverge with high sample counts', async () => {
        // Record many successes with fast latency
        for (let i = 0; i < 20; i++) {
            await store.recordOutcome('groq', 'llama-3.3', 'code', true, 500);
        }
        const w = await store.getWeight('groq', 'llama-3.3', 'code');
        expect(w.weight).toBeGreaterThan(1.0);
    });

    it('low success rate produces weight below 1.0', async () => {
        // Many failures
        for (let i = 0; i < 15; i++) {
            await store.recordOutcome('groq', 'llama-3.3', 'code', false, 0);
        }
        await store.recordOutcome('groq', 'llama-3.3', 'code', true, 2000);
        const w = await store.getWeight('groq', 'llama-3.3', 'code');
        expect(w.weight).toBeLessThan(1.0);
    });

    it('clamps weight to maxWeight', async () => {
        const store2 = new PerformanceLearningStore(sql, logger, makeConfig({ maxWeight: 1.5 }));
        // Many fast successes
        for (let i = 0; i < 50; i++) {
            await store2.recordOutcome('fast', 'model', 'code', true, 100);
        }
        const w = await store2.getWeight('fast', 'model', 'code');
        expect(w.weight).toBeLessThanOrEqual(1.5);
    });

    it('clamps weight to minWeight', async () => {
        const store2 = new PerformanceLearningStore(sql, logger, makeConfig({ minWeight: 0.5 }));
        // Many failures
        for (let i = 0; i < 50; i++) {
            await store2.recordOutcome('bad', 'model', 'code', false, 0);
        }
        await store2.recordOutcome('bad', 'model', 'code', true, 10000);
        const w = await store2.getWeight('bad', 'model', 'code');
        expect(w.weight).toBeGreaterThanOrEqual(0.5);
    });

    it('fast latency gives higher weight than slow latency', async () => {
        // Fast model
        for (let i = 0; i < 20; i++) {
            await store.recordOutcome('fast', 'model-a', 'code', true, 200);
        }
        // Slow model
        for (let i = 0; i < 20; i++) {
            await store.recordOutcome('slow', 'model-b', 'code', true, 5000);
        }
        const wFast = await store.getWeight('fast', 'model-a', 'code');
        const wSlow = await store.getWeight('slow', 'model-b', 'code');
        expect(wFast.weight).toBeGreaterThan(wSlow.weight);
    });

    // ─── getWeightsForTaskType ───

    it('returns all weights for a task type', async () => {
        await store.recordOutcome('groq', 'llama', 'code', true, 500);
        await store.recordOutcome('openai', 'gpt-4o', 'code', true, 1000);
        await store.recordOutcome('groq', 'llama', 'math', true, 500); // different task type
        const weights = await store.getWeightsForTaskType('code');
        expect(weights).toHaveLength(2);
        expect(weights.map(w => w.provider).sort()).toEqual(['groq', 'openai']);
    });

    it('returns empty array for unknown task type', async () => {
        const weights = await store.getWeightsForTaskType('unknown');
        expect(weights).toHaveLength(0);
    });

    // ─── applyDecay ───

    it('decays counts by the configured factor', async () => {
        for (let i = 0; i < 100; i++) {
            await store.recordOutcome('groq', 'llama', 'code', true, 1000);
        }
        for (let i = 0; i < 20; i++) {
            await store.recordOutcome('groq', 'llama', 'code', false, 0);
        }

        await store.applyDecay();

        const rows = await sql`
            SELECT success_count, error_count FROM model_performance
            WHERE provider = 'groq' AND model = 'llama' AND task_type = 'code'
        `;
        expect(Number(rows[0].success_count)).toBe(Math.floor(100 * 0.85));
        expect(Number(rows[0].error_count)).toBe(Math.floor(20 * 0.85));
    });

    it('accepts custom decay factor', async () => {
        for (let i = 0; i < 100; i++) {
            await store.recordOutcome('groq', 'llama', 'code', true, 1000);
        }
        await store.applyDecay(0.5);

        const rows = await sql`
            SELECT success_count FROM model_performance
            WHERE provider = 'groq' AND model = 'llama' AND task_type = 'code'
        `;
        expect(Number(rows[0].success_count)).toBe(50);
    });

    it('removes rows that decay to zero', async () => {
        await store.recordOutcome('groq', 'llama', 'code', true, 500);
        // After decay at 0.85, floor(1 * 0.85) = 0 → row should be deleted
        await store.applyDecay();
        const rows = await sql`SELECT COUNT(*) AS c FROM model_performance`;
        expect(Number(rows[0].c)).toBe(0);
    });

    // ─── reset ───

    it('clears all learning data', async () => {
        await store.recordOutcome('groq', 'llama', 'code', true, 500);
        await store.recordOutcome('openai', 'gpt-4o', 'math', true, 1000);
        await store.reset();
        expect(await store.getTrackedCount()).toBe(0);
    });

    // ─── getTrackedCount ───

    it('returns count of tracked combinations', async () => {
        expect(await store.getTrackedCount()).toBe(0);
        await store.recordOutcome('groq', 'llama', 'code', true, 500);
        await store.recordOutcome('openai', 'gpt-4o', 'math', true, 1000);
        expect(await store.getTrackedCount()).toBe(2);
    });

    // ─── getTopPerformers / getWorstPerformers ───

    it('returns top performers sorted by success rate', async () => {
        // Perfect model
        for (let i = 0; i < 10; i++) {
            await store.recordOutcome('groq', 'perfect', 'code', true, 500);
        }
        // Mediocre model
        for (let i = 0; i < 5; i++) {
            await store.recordOutcome('openai', 'mediocre', 'code', true, 500);
            await store.recordOutcome('openai', 'mediocre', 'code', false, 0);
        }

        const top = await store.getTopPerformers(2);
        expect(top).toHaveLength(2);
        expect(top[0].provider).toBe('groq');
        expect(top[0].successRate).toBe(1.0);
    });

    it('returns worst performers sorted by success rate', async () => {
        for (let i = 0; i < 10; i++) {
            await store.recordOutcome('groq', 'perfect', 'code', true, 500);
        }
        for (let i = 0; i < 10; i++) {
            await store.recordOutcome('bad', 'terrible', 'code', false, 0);
        }
        await store.recordOutcome('bad', 'terrible', 'code', true, 5000);

        const worst = await store.getWorstPerformers(2);
        expect(worst).toHaveLength(2);
        expect(worst[0].provider).toBe('bad');
    });

    // ─── Error resilience ───

    it('getWeight returns neutral on DB error', async () => {
        // Create store with a broken sql client (wrong url)
        const badSql = postgres('postgresql://bad:bad@localhost:9999/bad', { max: 1, connect_timeout: 1 });
        const store2 = new PerformanceLearningStore(badSql, logger, makeConfig());
        const w = await store2.getWeight('groq', 'llama', 'code');
        expect(w.weight).toBe(1.0);
        await badSql.end({ timeout: 1 }).catch(() => {});
    });

    it('recordOutcome does not throw on DB error', async () => {
        const badSql = postgres('postgresql://bad:bad@localhost:9999/bad', { max: 1, connect_timeout: 1 });
        const store2 = new PerformanceLearningStore(badSql, logger, makeConfig());
        await expect(store2.recordOutcome('groq', 'llama', 'code', true, 500)).resolves.toBeUndefined();
        await badSql.end({ timeout: 1 }).catch(() => {});
    });

    it('getWeightsForTaskType returns empty on error', async () => {
        const badSql = postgres('postgresql://bad:bad@localhost:9999/bad', { max: 1, connect_timeout: 1 });
        const store2 = new PerformanceLearningStore(badSql, logger, makeConfig());
        expect(await store2.getWeightsForTaskType('code')).toEqual([]);
        await badSql.end({ timeout: 1 }).catch(() => {});
    });
});
