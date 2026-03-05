import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { PerformanceLearningStore } from '../learning/performance-store.js';
import type { PerformanceLearningConfig } from '../learning/performance-store.js';
import type { Logger } from '../utils/logger.js';

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
    it('recordOutcome tracks success correctly', () => {
        const db = new Database(':memory:');
        const store = new PerformanceLearningStore(db, makeLogger(), makeConfig());

        store.recordOutcome('groq', 'llama', 'code', true, 500);
        const w = store.getWeight('groq', 'llama', 'code');

        expect(w.sampleCount).toBe(1);
        expect(w.successRate).toBe(1.0);
        expect(w.avgLatencyMs).toBe(500);
        db.close();
    });

    it('recordOutcome tracks failure correctly', () => {
        const db = new Database(':memory:');
        const store = new PerformanceLearningStore(db, makeLogger(), makeConfig());

        store.recordOutcome('groq', 'llama', 'code', false, 0);
        const w = store.getWeight('groq', 'llama', 'code');

        expect(w.sampleCount).toBe(1);
        expect(w.successRate).toBe(0);
        db.close();
    });

    it('feedback loop: success then failure produces correct stats', () => {
        const db = new Database(':memory:');
        const store = new PerformanceLearningStore(db, makeLogger(), makeConfig());

        store.recordOutcome('groq', 'llama', 'code', true, 1000);
        store.recordOutcome('groq', 'llama', 'code', true, 500);
        store.recordOutcome('groq', 'llama', 'code', false, 0);

        const w = store.getWeight('groq', 'llama', 'code');
        expect(w.sampleCount).toBe(3);
        expect(w.successRate).toBeCloseTo(2 / 3, 2);
        expect(w.avgLatencyMs).toBe(750); // (1000 + 500) / 2
        db.close();
    });

    it('multiple providers accumulate independently', () => {
        const db = new Database(':memory:');
        const store = new PerformanceLearningStore(db, makeLogger(), makeConfig());

        store.recordOutcome('groq', 'llama', 'code', true, 500);
        store.recordOutcome('openai', 'gpt-4o', 'code', false, 0);
        store.recordOutcome('anthropic', 'claude', 'code', true, 1000);

        expect(store.getWeight('groq', 'llama', 'code').successRate).toBe(1.0);
        expect(store.getWeight('openai', 'gpt-4o', 'code').successRate).toBe(0);
        expect(store.getWeight('anthropic', 'claude', 'code').successRate).toBe(1.0);
        expect(store.getTrackedCount()).toBe(3);
        db.close();
    });

    it('task type isolation: same provider, different task types', () => {
        const db = new Database(':memory:');
        const store = new PerformanceLearningStore(db, makeLogger(), makeConfig());

        store.recordOutcome('groq', 'llama', 'code', true, 500);
        store.recordOutcome('groq', 'llama', 'math', false, 0);

        expect(store.getWeight('groq', 'llama', 'code').successRate).toBe(1.0);
        expect(store.getWeight('groq', 'llama', 'math').successRate).toBe(0);
        db.close();
    });

    it('getWeightsForTaskType returns correct summary for stats endpoint', () => {
        const db = new Database(':memory:');
        const store = new PerformanceLearningStore(db, makeLogger(), makeConfig());

        // Simulate several providers handling code tasks
        for (let i = 0; i < 10; i++) {
            store.recordOutcome('groq', 'llama', 'code', true, 500);
        }
        for (let i = 0; i < 5; i++) {
            store.recordOutcome('openai', 'gpt-4o', 'code', true, 1000);
            store.recordOutcome('openai', 'gpt-4o', 'code', false, 0);
        }

        const weights = store.getWeightsForTaskType('code');
        expect(weights).toHaveLength(2);

        const groqW = weights.find(w => w.provider === 'groq');
        const openaiW = weights.find(w => w.provider === 'openai');

        expect(groqW?.successRate).toBe(1.0);
        expect(openaiW?.successRate).toBeCloseTo(0.5, 2);
        expect(groqW?.weight).toBeGreaterThan(openaiW!.weight);
        db.close();
    });

    it('top and worst performers reflect real outcomes', () => {
        const db = new Database(':memory:');
        const store = new PerformanceLearningStore(db, makeLogger(), makeConfig());

        // Perfect performer
        for (let i = 0; i < 20; i++) {
            store.recordOutcome('anthropic', 'claude', 'reasoning', true, 800);
        }
        // Bad performer
        for (let i = 0; i < 18; i++) {
            store.recordOutcome('groq', 'llama', 'reasoning', false, 0);
        }
        store.recordOutcome('groq', 'llama', 'reasoning', true, 5000);
        store.recordOutcome('groq', 'llama', 'reasoning', true, 5000);

        const top = store.getTopPerformers(1);
        expect(top[0].provider).toBe('anthropic');
        expect(top[0].successRate).toBe(1.0);

        const worst = store.getWorstPerformers(1);
        expect(worst[0].provider).toBe('groq');
        expect(worst[0].successRate).toBe(0.1);
        db.close();
    });

    it('decay reduces influence of historical data', () => {
        const db = new Database(':memory:');
        const store = new PerformanceLearningStore(db, makeLogger(), makeConfig());

        // Old data: model was bad
        for (let i = 0; i < 100; i++) {
            store.recordOutcome('groq', 'llama', 'code', false, 0);
        }

        // Apply decay (simulating a restart)
        store.applyDecay(0.5); // 100 errors → 50

        // New data: model improved
        for (let i = 0; i < 50; i++) {
            store.recordOutcome('groq', 'llama', 'code', true, 500);
        }

        const w = store.getWeight('groq', 'llama', 'code');
        // 50 successes + 50 errors = 50% success rate
        expect(w.successRate).toBe(0.5);
        db.close();
    });

    it('null learning store does not cause errors in recording path', () => {
        // Simulates the gateway code path where learningStore is null
        const store = null as PerformanceLearningStore | null;
        expect(() => store?.recordOutcome('groq', 'llama', 'code', true, 500)).not.toThrow();
    });

    it('startup validation: decay on fresh database is a no-op', () => {
        const db = new Database(':memory:');
        const store = new PerformanceLearningStore(db, makeLogger(), makeConfig());

        // Should not throw on empty database
        expect(() => store.applyDecay()).not.toThrow();
        expect(store.getTrackedCount()).toBe(0);
        db.close();
    });

    it('reset clears all data for admin escape hatch', () => {
        const db = new Database(':memory:');
        const store = new PerformanceLearningStore(db, makeLogger(), makeConfig());

        for (let i = 0; i < 10; i++) {
            store.recordOutcome('groq', 'llama', 'code', true, 500);
        }
        expect(store.getTrackedCount()).toBe(1);

        store.reset();
        expect(store.getTrackedCount()).toBe(0);
        expect(store.getWeight('groq', 'llama', 'code').weight).toBe(1.0);
        db.close();
    });
});
