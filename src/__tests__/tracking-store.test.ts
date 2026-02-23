import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TrackingStore } from '../tracking/store.js';
import type { RequestRecord } from '../tracking/types.js';
import type { Logger } from '../utils/logger.js';

// ─── Helpers ─────────────────────────────────────────────

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

function makeRecord(overrides?: Partial<RequestRecord>): RequestRecord {
    return {
        id: `req-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        tier: 'economical',
        provider: 'groq',
        model: 'llama-3.3-70b-versatile',
        classificationScore: 5,
        classificationType: 'analysis',
        classificationLatencyMs: 120,
        classifierProvider: 'groq',
        tokensIn: 100,
        tokensOut: 200,
        estimatedCost: 0.0001,
        baselineCost: 0.001,
        savings: 0.0009,
        totalLatencyMs: 500,
        stream: false,
        isDirectRoute: false,
        userMessagePreview: 'test message',
        ...overrides,
    };
}

// ─── Tests ───────────────────────────────────────────────

describe('TrackingStore', () => {
    let store: TrackingStore;
    let logger: Logger;

    beforeEach(() => {
        logger = makeLogger();
        // Use in-memory SQLite for tests
        store = new TrackingStore(':memory:', logger);
    });

    afterEach(() => {
        store.close();
    });

    describe('record insertion', () => {
        it('inserts a record successfully', () => {
            const record = makeRecord({ id: 'req-001' });
            store.record(record);

            const recent = store.getRecent(1);
            expect(recent).toHaveLength(1);
            expect(recent[0].provider).toBe('groq');
        });

        it('inserts multiple records', () => {
            store.record(makeRecord({ id: 'req-001' }));
            store.record(makeRecord({ id: 'req-002' }));
            store.record(makeRecord({ id: 'req-003' }));

            const recent = store.getRecent(10);
            expect(recent).toHaveLength(3);
        });

        it('handles null userMessagePreview', () => {
            store.record(makeRecord({ id: 'req-001', userMessagePreview: undefined as any }));
            const recent = store.getRecent(1);
            expect(recent[0].preview).toBeNull();
        });
    });

    describe('getSummary', () => {
        it('returns zero totals when empty', () => {
            const summary = store.getSummary();
            expect(summary.totalRequests).toBe(0);
            expect(summary.totalCost).toBe(0);
            expect(summary.totalSavings).toBe(0);
            expect(summary.savingsPercent).toBe(0);
        });

        it('sums costs and savings correctly', () => {
            store.record(makeRecord({ id: 'req-001', estimatedCost: 0.01, baselineCost: 0.05, savings: 0.04 }));
            store.record(makeRecord({ id: 'req-002', estimatedCost: 0.02, baselineCost: 0.10, savings: 0.08 }));

            const summary = store.getSummary();
            expect(summary.totalRequests).toBe(2);
            expect(summary.totalCost).toBeCloseTo(0.03);
            expect(summary.totalSavings).toBeCloseTo(0.12);
        });

        it('groups by tier', () => {
            store.record(makeRecord({ id: 'req-001', tier: 'free' }));
            store.record(makeRecord({ id: 'req-002', tier: 'free' }));
            store.record(makeRecord({ id: 'req-003', tier: 'premium' }));

            const summary = store.getSummary();
            expect(summary.byTier['free']?.count).toBe(2);
            expect(summary.byTier['premium']?.count).toBe(1);
        });

        it('groups by provider', () => {
            store.record(makeRecord({ id: 'req-001', provider: 'groq' }));
            store.record(makeRecord({ id: 'req-002', provider: 'anthropic' }));
            store.record(makeRecord({ id: 'req-003', provider: 'groq' }));

            const summary = store.getSummary();
            expect(summary.byProvider['groq']?.count).toBe(2);
            expect(summary.byProvider['anthropic']?.count).toBe(1);
        });

        it('calculates savings percent correctly', () => {
            store.record(makeRecord({ id: 'req-001', estimatedCost: 0.01, baselineCost: 0.10, savings: 0.09 }));

            const summary = store.getSummary();
            expect(summary.savingsPercent).toBeCloseTo(90);
        });
    });

    describe('getRecent', () => {
        it('returns records in reverse chronological order', () => {
            const t1 = '2026-02-23T10:00:00.000Z';
            const t2 = '2026-02-23T11:00:00.000Z';
            const t3 = '2026-02-23T12:00:00.000Z';

            store.record(makeRecord({ id: 'req-001', timestamp: t1 }));
            store.record(makeRecord({ id: 'req-002', timestamp: t2 }));
            store.record(makeRecord({ id: 'req-003', timestamp: t3 }));

            const recent = store.getRecent(3);
            expect(recent[0].timestamp).toBe(t3);
            expect(recent[1].timestamp).toBe(t2);
            expect(recent[2].timestamp).toBe(t1);
        });

        it('respects the limit parameter', () => {
            for (let i = 0; i < 10; i++) {
                store.record(makeRecord({ id: `req-${i}` }));
            }

            const recent = store.getRecent(3);
            expect(recent).toHaveLength(3);
        });

        it('maps fields correctly', () => {
            store.record(makeRecord({
                id: 'req-001',
                classificationScore: 7,
                classificationType: 'code',
                tier: 'premium',
                provider: 'anthropic',
                model: 'claude-sonnet-4-20250514',
                stream: true,
                classifierProvider: 'groq',
            }));

            const [recent] = store.getRecent(1);
            expect(recent.score).toBe(7);
            expect(recent.type).toBe('code');
            expect(recent.tier).toBe('premium');
            expect(recent.stream).toBe(true);
            expect(recent.classifierProvider).toBe('groq');
        });
    });

    describe('close()', () => {
        it('is idempotent — calling close twice does not throw', () => {
            store.close();
            expect(() => store.close()).not.toThrow();
        });

        it('logs warning when record is dropped after close', () => {
            store.close();
            store.record(makeRecord({ id: 'req-dropped' }));

            expect(logger.warn).toHaveBeenCalledWith(
                expect.objectContaining({ recordId: 'req-dropped' }),
                expect.stringContaining('dropped'),
            );
        });
    });
});
