import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    let db: Database.Database;
    let store: PerformanceLearningStore;
    let logger: Logger;

    beforeEach(() => {
        db = new Database(':memory:');
        logger = makeLogger();
        store = new PerformanceLearningStore(db, logger, makeConfig());
    });

    afterEach(() => {
        db.close();
    });

    // ─── Table creation ───

    it('creates the model_performance table', () => {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='model_performance'").all();
        expect(tables).toHaveLength(1);
    });

    it('handles being constructed with an existing table', () => {
        // Second construction should not throw
        const store2 = new PerformanceLearningStore(db, logger, makeConfig());
        expect(store2).toBeDefined();
    });

    // ─── recordOutcome ───

    it('records a successful outcome', () => {
        store.recordOutcome('groq', 'llama-3.3', 'code', true, 500);
        const w = store.getWeight('groq', 'llama-3.3', 'code');
        expect(w.sampleCount).toBe(1);
        expect(w.successRate).toBe(1);
    });

    it('records a failed outcome', () => {
        store.recordOutcome('groq', 'llama-3.3', 'code', false, 0);
        const w = store.getWeight('groq', 'llama-3.3', 'code');
        expect(w.sampleCount).toBe(1);
        expect(w.successRate).toBe(0);
    });

    it('accumulates multiple outcomes', () => {
        store.recordOutcome('groq', 'llama-3.3', 'code', true, 500);
        store.recordOutcome('groq', 'llama-3.3', 'code', true, 600);
        store.recordOutcome('groq', 'llama-3.3', 'code', false, 0);
        const w = store.getWeight('groq', 'llama-3.3', 'code');
        expect(w.sampleCount).toBe(3);
        expect(w.successRate).toBeCloseTo(2 / 3, 2);
    });

    it('tracks different task types separately', () => {
        store.recordOutcome('groq', 'llama-3.3', 'code', true, 500);
        store.recordOutcome('groq', 'llama-3.3', 'math', false, 0);
        expect(store.getWeight('groq', 'llama-3.3', 'code').successRate).toBe(1);
        expect(store.getWeight('groq', 'llama-3.3', 'math').successRate).toBe(0);
    });

    it('tracks different providers separately', () => {
        store.recordOutcome('groq', 'model-a', 'code', true, 500);
        store.recordOutcome('openai', 'model-b', 'code', false, 0);
        expect(store.getWeight('groq', 'model-a', 'code').successRate).toBe(1);
        expect(store.getWeight('openai', 'model-b', 'code').successRate).toBe(0);
    });

    it('does not count latency for failed outcomes', () => {
        store.recordOutcome('groq', 'llama-3.3', 'code', false, 5000);
        const w = store.getWeight('groq', 'llama-3.3', 'code');
        // With zero successes, avgLatencyMs falls back to the median baseline (2000ms)
        expect(w.avgLatencyMs).toBe(2000);
        // Verify the stored latency is 0 (failures don't add latency)
        const row = db.prepare('SELECT total_latency_ms FROM model_performance').get() as { total_latency_ms: number };
        expect(row.total_latency_ms).toBe(0);
    });

    it('clamps negative latency to 0', () => {
        store.recordOutcome('groq', 'llama-3.3', 'code', true, -100);
        const row = db.prepare('SELECT total_latency_ms FROM model_performance').get() as { total_latency_ms: number };
        expect(row.total_latency_ms).toBe(0);
    });

    // ─── getWeight ───

    it('returns neutral weight (1.0) for unknown model', () => {
        const w = store.getWeight('unknown', 'unknown-model', 'code');
        expect(w.weight).toBe(1.0);
        expect(w.sampleCount).toBe(0);
    });

    it('weights stay near 1.0 with low sample counts (confidence)', () => {
        // With only 1 sample (confidence = 0.1), weight should be near 1.0
        store.recordOutcome('groq', 'llama-3.3', 'code', true, 2000);
        const w = store.getWeight('groq', 'llama-3.3', 'code');
        expect(w.weight).toBeGreaterThan(0.9);
        expect(w.weight).toBeLessThan(1.1);
    });

    it('weights diverge with high sample counts', () => {
        // Record many successes with fast latency
        for (let i = 0; i < 20; i++) {
            store.recordOutcome('groq', 'llama-3.3', 'code', true, 500);
        }
        const w = store.getWeight('groq', 'llama-3.3', 'code');
        expect(w.weight).toBeGreaterThan(1.0);
    });

    it('low success rate produces weight below 1.0', () => {
        // Many failures
        for (let i = 0; i < 15; i++) {
            store.recordOutcome('groq', 'llama-3.3', 'code', false, 0);
        }
        store.recordOutcome('groq', 'llama-3.3', 'code', true, 2000);
        const w = store.getWeight('groq', 'llama-3.3', 'code');
        expect(w.weight).toBeLessThan(1.0);
    });

    it('clamps weight to maxWeight', () => {
        const store2 = new PerformanceLearningStore(db, logger, makeConfig({ maxWeight: 1.5 }));
        // Many fast successes
        for (let i = 0; i < 50; i++) {
            store2.recordOutcome('fast', 'model', 'code', true, 100);
        }
        const w = store2.getWeight('fast', 'model', 'code');
        expect(w.weight).toBeLessThanOrEqual(1.5);
    });

    it('clamps weight to minWeight', () => {
        const store2 = new PerformanceLearningStore(db, logger, makeConfig({ minWeight: 0.5 }));
        // Many failures
        for (let i = 0; i < 50; i++) {
            store2.recordOutcome('bad', 'model', 'code', false, 0);
        }
        store2.recordOutcome('bad', 'model', 'code', true, 10000);
        const w = store2.getWeight('bad', 'model', 'code');
        expect(w.weight).toBeGreaterThanOrEqual(0.5);
    });

    it('fast latency gives higher weight than slow latency', () => {
        // Fast model
        for (let i = 0; i < 20; i++) {
            store.recordOutcome('fast', 'model-a', 'code', true, 200);
        }
        // Slow model
        for (let i = 0; i < 20; i++) {
            store.recordOutcome('slow', 'model-b', 'code', true, 5000);
        }
        const wFast = store.getWeight('fast', 'model-a', 'code');
        const wSlow = store.getWeight('slow', 'model-b', 'code');
        expect(wFast.weight).toBeGreaterThan(wSlow.weight);
    });

    // ─── getWeightsForTaskType ───

    it('returns all weights for a task type', () => {
        store.recordOutcome('groq', 'llama', 'code', true, 500);
        store.recordOutcome('openai', 'gpt-4o', 'code', true, 1000);
        store.recordOutcome('groq', 'llama', 'math', true, 500); // different task type
        const weights = store.getWeightsForTaskType('code');
        expect(weights).toHaveLength(2);
        expect(weights.map(w => w.provider).sort()).toEqual(['groq', 'openai']);
    });

    it('returns empty array for unknown task type', () => {
        const weights = store.getWeightsForTaskType('unknown');
        expect(weights).toHaveLength(0);
    });

    // ─── applyDecay ───

    it('decays counts by the configured factor', () => {
        for (let i = 0; i < 100; i++) {
            store.recordOutcome('groq', 'llama', 'code', true, 1000);
        }
        for (let i = 0; i < 20; i++) {
            store.recordOutcome('groq', 'llama', 'code', false, 0);
        }

        store.applyDecay();

        const row = db.prepare('SELECT success_count, error_count FROM model_performance WHERE provider = ? AND model = ? AND task_type = ?')
            .get('groq', 'llama', 'code') as { success_count: number; error_count: number };

        expect(row.success_count).toBe(Math.floor(100 * 0.85));
        expect(row.error_count).toBe(Math.floor(20 * 0.85));
    });

    it('accepts custom decay factor', () => {
        for (let i = 0; i < 100; i++) {
            store.recordOutcome('groq', 'llama', 'code', true, 1000);
        }
        store.applyDecay(0.5);

        const row = db.prepare('SELECT success_count FROM model_performance WHERE provider = ? AND model = ? AND task_type = ?')
            .get('groq', 'llama', 'code') as { success_count: number };

        expect(row.success_count).toBe(50);
    });

    it('removes rows that decay to zero', () => {
        store.recordOutcome('groq', 'llama', 'code', true, 500);
        // After decay at 0.85, floor(1 * 0.85) = 0 → row should be deleted
        store.applyDecay();
        const count = (db.prepare('SELECT COUNT(*) as c FROM model_performance').get() as { c: number }).c;
        expect(count).toBe(0);
    });

    // ─── reset ───

    it('clears all learning data', () => {
        store.recordOutcome('groq', 'llama', 'code', true, 500);
        store.recordOutcome('openai', 'gpt-4o', 'math', true, 1000);
        store.reset();
        expect(store.getTrackedCount()).toBe(0);
    });

    // ─── getTrackedCount ───

    it('returns count of tracked combinations', () => {
        expect(store.getTrackedCount()).toBe(0);
        store.recordOutcome('groq', 'llama', 'code', true, 500);
        store.recordOutcome('openai', 'gpt-4o', 'math', true, 1000);
        expect(store.getTrackedCount()).toBe(2);
    });

    // ─── getTopPerformers / getWorstPerformers ───

    it('returns top performers sorted by success rate', () => {
        // Perfect model
        for (let i = 0; i < 10; i++) {
            store.recordOutcome('groq', 'perfect', 'code', true, 500);
        }
        // Mediocre model
        for (let i = 0; i < 5; i++) {
            store.recordOutcome('openai', 'mediocre', 'code', true, 500);
            store.recordOutcome('openai', 'mediocre', 'code', false, 0);
        }

        const top = store.getTopPerformers(2);
        expect(top).toHaveLength(2);
        expect(top[0].provider).toBe('groq');
        expect(top[0].successRate).toBe(1.0);
    });

    it('returns worst performers sorted by success rate', () => {
        for (let i = 0; i < 10; i++) {
            store.recordOutcome('groq', 'perfect', 'code', true, 500);
        }
        for (let i = 0; i < 10; i++) {
            store.recordOutcome('bad', 'terrible', 'code', false, 0);
        }
        store.recordOutcome('bad', 'terrible', 'code', true, 5000);

        const worst = store.getWorstPerformers(2);
        expect(worst).toHaveLength(2);
        expect(worst[0].provider).toBe('bad');
    });

    // ─── Error resilience ───

    it('getWeight returns neutral on SQLite error', () => {
        db.close();
        const db2 = new Database(':memory:');
        const store2 = new PerformanceLearningStore(db2, logger, makeConfig());
        db2.close(); // Close to force errors
        const w = store2.getWeight('groq', 'llama', 'code');
        expect(w.weight).toBe(1.0);
    });

    it('recordOutcome does not throw on SQLite error', () => {
        db.close();
        const db2 = new Database(':memory:');
        const store2 = new PerformanceLearningStore(db2, logger, makeConfig());
        db2.close();
        expect(() => store2.recordOutcome('groq', 'llama', 'code', true, 500)).not.toThrow();
    });

    it('getWeightsForTaskType returns empty on error', () => {
        db.close();
        const db2 = new Database(':memory:');
        const store2 = new PerformanceLearningStore(db2, logger, makeConfig());
        db2.close();
        expect(store2.getWeightsForTaskType('code')).toEqual([]);
    });
});
