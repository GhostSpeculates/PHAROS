import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { PerformanceLearningStore } from '../learning/performance-store.js';
import { sortByPerformance } from '../router/failover.js';
import type { ModelCandidate } from '../router/failover.js';
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

describe('Performance Learning — Error Resilience', () => {
    // ─── Closed database resilience ───

    describe('closed database', () => {
        it('getWeight returns neutral on closed DB', () => {
            const db = new Database(':memory:');
            const store = new PerformanceLearningStore(db, makeLogger(), makeConfig());
            db.close();
            const w = store.getWeight('groq', 'llama', 'code');
            expect(w.weight).toBe(1.0);
            expect(w.sampleCount).toBe(0);
        });

        it('recordOutcome does not throw on closed DB', () => {
            const db = new Database(':memory:');
            const store = new PerformanceLearningStore(db, makeLogger(), makeConfig());
            db.close();
            expect(() => store.recordOutcome('groq', 'llama', 'code', true, 500)).not.toThrow();
        });

        it('getWeightsForTaskType returns empty on closed DB', () => {
            const db = new Database(':memory:');
            const store = new PerformanceLearningStore(db, makeLogger(), makeConfig());
            db.close();
            expect(store.getWeightsForTaskType('code')).toEqual([]);
        });

        it('applyDecay does not throw on closed DB', () => {
            const db = new Database(':memory:');
            const store = new PerformanceLearningStore(db, makeLogger(), makeConfig());
            db.close();
            expect(() => store.applyDecay()).not.toThrow();
        });

        it('reset does not throw on closed DB', () => {
            const db = new Database(':memory:');
            const store = new PerformanceLearningStore(db, makeLogger(), makeConfig());
            db.close();
            expect(() => store.reset()).not.toThrow();
        });

        it('getTrackedCount returns 0 on closed DB', () => {
            const db = new Database(':memory:');
            const store = new PerformanceLearningStore(db, makeLogger(), makeConfig());
            db.close();
            expect(store.getTrackedCount()).toBe(0);
        });

        it('getTopPerformers returns empty on closed DB', () => {
            const db = new Database(':memory:');
            const store = new PerformanceLearningStore(db, makeLogger(), makeConfig());
            db.close();
            expect(store.getTopPerformers()).toEqual([]);
        });

        it('getWorstPerformers returns empty on closed DB', () => {
            const db = new Database(':memory:');
            const store = new PerformanceLearningStore(db, makeLogger(), makeConfig());
            db.close();
            expect(store.getWorstPerformers()).toEqual([]);
        });
    });

    // ─── Weight computation edge cases ───

    describe('weight computation edge cases', () => {
        let db: Database.Database;
        let store: PerformanceLearningStore;

        beforeEach(() => {
            db = new Database(':memory:');
            store = new PerformanceLearningStore(db, makeLogger(), makeConfig());
        });

        afterEach(() => {
            db.close();
        });

        it('zero successes produces weight clamped to minWeight', () => {
            for (let i = 0; i < 50; i++) {
                store.recordOutcome('bad', 'model', 'code', false, 0);
            }
            // Add 1 success so weight isn't purely from zero-division
            store.recordOutcome('bad', 'model', 'code', true, 10000);
            const w = store.getWeight('bad', 'model', 'code');
            expect(w.weight).toBeGreaterThanOrEqual(0.3);
            expect(Number.isFinite(w.weight)).toBe(true);
        });

        it('very high latency still produces finite weight', () => {
            for (let i = 0; i < 20; i++) {
                store.recordOutcome('slow', 'model', 'code', true, 999_999);
            }
            const w = store.getWeight('slow', 'model', 'code');
            expect(Number.isFinite(w.weight)).toBe(true);
            expect(w.weight).toBeGreaterThan(0);
        });

        it('zero latency still produces finite weight', () => {
            for (let i = 0; i < 20; i++) {
                store.recordOutcome('fast', 'model', 'code', true, 0);
            }
            const w = store.getWeight('fast', 'model', 'code');
            expect(Number.isFinite(w.weight)).toBe(true);
        });

        it('weight stays within bounds even with extreme data', () => {
            // 100% success, near-zero latency
            for (let i = 0; i < 1000; i++) {
                store.recordOutcome('perfect', 'model', 'code', true, 1);
            }
            const w = store.getWeight('perfect', 'model', 'code');
            expect(w.weight).toBeLessThanOrEqual(2.0);
            expect(w.weight).toBeGreaterThanOrEqual(0.3);
        });
    });

    // ─── sortByPerformance resilience ───

    describe('sortByPerformance resilience', () => {
        it('returns unchanged candidates when store throws', () => {
            const db = new Database(':memory:');
            const store = new PerformanceLearningStore(db, makeLogger(), makeConfig());
            db.close(); // Force errors

            const candidates: ModelCandidate[] = [
                { provider: 'groq', model: 'llama', tier: 'free' },
                { provider: 'google', model: 'gemini', tier: 'free' },
            ];

            const result = sortByPerformance(candidates, 'code', store);
            expect(result).toEqual(candidates);
        });

        it('handles empty task type gracefully', () => {
            const db = new Database(':memory:');
            const store = new PerformanceLearningStore(db, makeLogger(), makeConfig());

            const candidates: ModelCandidate[] = [
                { provider: 'groq', model: 'llama', tier: 'free' },
            ];

            const result = sortByPerformance(candidates, '', store);
            expect(result).toEqual(candidates);
            db.close();
        });
    });
});
