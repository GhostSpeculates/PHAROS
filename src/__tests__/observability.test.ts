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

function makeConfig(): PerformanceLearningConfig {
    return {
        enabled: true,
        minConfidenceSamples: 10,
        decayFactor: 0.85,
        maxWeight: 2.0,
        minWeight: 0.3,
    };
}

describe('Observability — Feedback Loop', () => {
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

    it('recordOutcome tracks success correctly', async () => {
        await store.recordOutcome('groq', 'llama', 'code', true, 500);
        const w = await store.getWeight('groq', 'llama', 'code');

        expect(w.sampleCount).toBe(1);
        expect(w.successRate).toBe(1.0);
        expect(w.avgLatencyMs).toBe(500);
    });

    it('recordOutcome tracks failure correctly', async () => {
        await store.recordOutcome('groq', 'llama', 'code', false, 0);
        const w = await store.getWeight('groq', 'llama', 'code');

        expect(w.sampleCount).toBe(1);
        expect(w.successRate).toBe(0);
    });

    it('feedback loop: success then failure produces correct stats', async () => {
        await store.recordOutcome('groq', 'llama', 'code', true, 1000);
        await store.recordOutcome('groq', 'llama', 'code', true, 500);
        await store.recordOutcome('groq', 'llama', 'code', false, 0);

        const w = await store.getWeight('groq', 'llama', 'code');
        expect(w.sampleCount).toBe(3);
        expect(w.successRate).toBeCloseTo(2 / 3, 2);
        expect(w.avgLatencyMs).toBe(750); // (1000 + 500) / 2
    });

    it('multiple providers accumulate independently', async () => {
        await store.recordOutcome('groq', 'llama', 'code', true, 500);
        await store.recordOutcome('openai', 'gpt-4o', 'code', false, 0);
        await store.recordOutcome('anthropic', 'claude', 'code', true, 1000);

        expect((await store.getWeight('groq', 'llama', 'code')).successRate).toBe(1.0);
        expect((await store.getWeight('openai', 'gpt-4o', 'code')).successRate).toBe(0);
        expect((await store.getWeight('anthropic', 'claude', 'code')).successRate).toBe(1.0);
        expect(await store.getTrackedCount()).toBe(3);
    });

    it('task type isolation: same provider, different task types', async () => {
        await store.recordOutcome('groq', 'llama', 'code', true, 500);
        await store.recordOutcome('groq', 'llama', 'math', false, 0);

        expect((await store.getWeight('groq', 'llama', 'code')).successRate).toBe(1.0);
        expect((await store.getWeight('groq', 'llama', 'math')).successRate).toBe(0);
    });

    it('getWeightsForTaskType returns correct summary for stats endpoint', async () => {
        // Simulate several providers handling code tasks
        for (let i = 0; i < 10; i++) {
            await store.recordOutcome('groq', 'llama', 'code', true, 500);
        }
        for (let i = 0; i < 5; i++) {
            await store.recordOutcome('openai', 'gpt-4o', 'code', true, 1000);
            await store.recordOutcome('openai', 'gpt-4o', 'code', false, 0);
        }

        const weights = await store.getWeightsForTaskType('code');
        expect(weights).toHaveLength(2);

        const groqW = weights.find(w => w.provider === 'groq');
        const openaiW = weights.find(w => w.provider === 'openai');

        expect(groqW?.successRate).toBe(1.0);
        expect(openaiW?.successRate).toBeCloseTo(0.5, 2);
        expect(groqW?.weight).toBeGreaterThan(openaiW!.weight);
    });

    it('top and worst performers reflect real outcomes', async () => {
        // Perfect performer
        for (let i = 0; i < 20; i++) {
            await store.recordOutcome('anthropic', 'claude', 'reasoning', true, 800);
        }
        // Bad performer
        for (let i = 0; i < 18; i++) {
            await store.recordOutcome('groq', 'llama', 'reasoning', false, 0);
        }
        await store.recordOutcome('groq', 'llama', 'reasoning', true, 5000);
        await store.recordOutcome('groq', 'llama', 'reasoning', true, 5000);

        const top = await store.getTopPerformers(1);
        expect(top[0].provider).toBe('anthropic');
        expect(top[0].successRate).toBe(1.0);

        const worst = await store.getWorstPerformers(1);
        expect(worst[0].provider).toBe('groq');
        expect(worst[0].successRate).toBe(0.1);
    });

    it('decay reduces influence of historical data', async () => {
        // Old data: model was bad
        for (let i = 0; i < 100; i++) {
            await store.recordOutcome('groq', 'llama', 'code', false, 0);
        }

        // Apply decay (simulating a restart)
        await store.applyDecay(0.5); // 100 errors → 50

        // New data: model improved
        for (let i = 0; i < 50; i++) {
            await store.recordOutcome('groq', 'llama', 'code', true, 500);
        }

        const w = await store.getWeight('groq', 'llama', 'code');
        // 50 successes + 50 errors = 50% success rate
        expect(w.successRate).toBe(0.5);
    });

    it('null learning store does not cause errors in recording path', async () => {
        // Simulates the gateway code path where learningStore is null
        const nullStore = null as PerformanceLearningStore | null;
        // optional chaining on null returns undefined synchronously — no throw, no rejection
        const result = nullStore?.recordOutcome('groq', 'llama', 'code', true, 500);
        expect(result).toBeUndefined();
    });

    it('startup validation: decay on fresh database is a no-op', async () => {
        // Should not throw on empty table
        await expect(store.applyDecay()).resolves.toBeUndefined();
        expect(await store.getTrackedCount()).toBe(0);
    });

    it('reset clears all data for admin escape hatch', async () => {
        for (let i = 0; i < 10; i++) {
            await store.recordOutcome('groq', 'llama', 'code', true, 500);
        }
        expect(await store.getTrackedCount()).toBe(1);

        await store.reset();
        expect(await store.getTrackedCount()).toBe(0);
        expect((await store.getWeight('groq', 'llama', 'code')).weight).toBe(1.0);
    });
});
