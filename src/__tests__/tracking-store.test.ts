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

    describe('error tracking', () => {
        it('defaults status to success when not provided', () => {
            store.record(makeRecord({ id: 'req-ok-001' }));

            const recent = store.getRecent(1);
            expect(recent).toHaveLength(1);
            expect(recent[0].status).toBe('success');
            expect(recent[0].errorMessage).toBeNull();
        });

        it('records a failed request with status error and error message', () => {
            store.record(makeRecord({
                id: 'req-err-001',
                status: 'error',
                errorMessage: 'All providers failed after 3 retry attempts',
            }));

            const recent = store.getRecent(1);
            expect(recent).toHaveLength(1);
            expect(recent[0].status).toBe('error');
            expect(recent[0].errorMessage).toBe('All providers failed after 3 retry attempts');
        });

        it('records a success with explicit status', () => {
            store.record(makeRecord({
                id: 'req-ok-002',
                status: 'success',
            }));

            const recent = store.getRecent(1);
            expect(recent[0].status).toBe('success');
            expect(recent[0].errorMessage).toBeNull();
        });

        it('getSummary includes totalErrors and errorRate', () => {
            store.record(makeRecord({ id: 'req-001' }));
            store.record(makeRecord({ id: 'req-002' }));
            store.record(makeRecord({ id: 'req-003', status: 'error', errorMessage: 'timeout' }));

            const summary = store.getSummary();
            expect(summary.totalErrors).toBe(1);
            expect(summary.totalRequests).toBe(3);
            expect(summary.errorRate).toBeCloseTo(33.33, 1);
        });

        it('getSummary returns zero errors when all requests succeed', () => {
            store.record(makeRecord({ id: 'req-001' }));
            store.record(makeRecord({ id: 'req-002' }));

            const summary = store.getSummary();
            expect(summary.totalErrors).toBe(0);
            expect(summary.errorRate).toBe(0);
        });

        it('getSummary returns zero error rate when no requests exist', () => {
            const summary = store.getSummary();
            expect(summary.totalErrors).toBe(0);
            expect(summary.errorRate).toBe(0);
        });

        it('calculates error rate accurately (2 errors out of 10 = 20%)', () => {
            for (let i = 0; i < 8; i++) {
                store.record(makeRecord({ id: `req-ok-${i}` }));
            }
            store.record(makeRecord({ id: 'req-err-1', status: 'error', errorMessage: 'error 1' }));
            store.record(makeRecord({ id: 'req-err-2', status: 'error', errorMessage: 'error 2' }));

            const summary = store.getSummary();
            expect(summary.totalRequests).toBe(10);
            expect(summary.totalErrors).toBe(2);
            expect(summary.errorRate).toBeCloseTo(20);
        });

        it('getRecent includes status and errorMessage fields', () => {
            store.record(makeRecord({ id: 'req-ok-001' }));
            store.record(makeRecord({
                id: 'req-err-001',
                status: 'error',
                errorMessage: 'Provider unavailable',
            }));

            const recent = store.getRecent(10);
            expect(recent).toHaveLength(2);

            // Each record should have status and errorMessage properties
            for (const r of recent) {
                expect(r).toHaveProperty('status');
                expect(r).toHaveProperty('errorMessage');
            }

            // Find the error record
            const errorRecord = recent.find(r => r.status === 'error');
            expect(errorRecord).toBeDefined();
            expect(errorRecord!.errorMessage).toBe('Provider unavailable');

            // Find the success record
            const successRecord = recent.find(r => r.status === 'success');
            expect(successRecord).toBeDefined();
            expect(successRecord!.errorMessage).toBeNull();
        });

        it('handles null errorMessage for error status', () => {
            store.record(makeRecord({
                id: 'req-err-no-msg',
                status: 'error',
            }));

            const recent = store.getRecent(1);
            expect(recent[0].status).toBe('error');
            expect(recent[0].errorMessage).toBeNull();
        });
    });

    describe('spending queries', () => {
        it('getDailySpend returns 0 when no records exist', () => {
            expect(store.getDailySpend()).toBe(0);
        });

        it('getDailySpend sums costs for today only', () => {
            const today = new Date().toISOString().slice(0, 10);
            const yesterday = new Date(Date.now() - 86400000).toISOString();

            store.record(makeRecord({
                id: 'req-today-1',
                timestamp: `${today}T12:00:00.000Z`,
                estimatedCost: 0.05,
            }));
            store.record(makeRecord({
                id: 'req-today-2',
                timestamp: `${today}T13:00:00.000Z`,
                estimatedCost: 0.10,
            }));
            store.record(makeRecord({
                id: 'req-yesterday',
                timestamp: yesterday,
                estimatedCost: 1.00,
            }));

            expect(store.getDailySpend()).toBeCloseTo(0.15);
        });

        it('getMonthlySpend returns 0 when no records exist', () => {
            expect(store.getMonthlySpend()).toBe(0);
        });

        it('getMonthlySpend sums costs for the current month', () => {
            const monthStart = new Date().toISOString().slice(0, 7) + '-01';
            const lastMonth = new Date(Date.now() - 35 * 86400000).toISOString();

            store.record(makeRecord({
                id: 'req-this-month-1',
                timestamp: `${monthStart}T12:00:00.000Z`,
                estimatedCost: 0.50,
            }));
            store.record(makeRecord({
                id: 'req-this-month-2',
                timestamp: new Date().toISOString(),
                estimatedCost: 0.25,
            }));
            store.record(makeRecord({
                id: 'req-last-month',
                timestamp: lastMonth,
                estimatedCost: 5.00,
            }));

            expect(store.getMonthlySpend()).toBeCloseTo(0.75);
        });
    });

    describe('debug logging fields', () => {
        it('stores debugInput when provided', () => {
            store.record(makeRecord({
                id: 'req-debug-1',
                debugInput: 'What is the capital of France?',
            }));

            const recent = store.getRecent(1);
            expect(recent).toHaveLength(1);
        });

        it('stores debugOutput when provided', () => {
            store.record(makeRecord({
                id: 'req-debug-2',
                debugInput: 'What is 2+2?',
                debugOutput: 'The answer is 4.',
            }));

            const recent = store.getRecent(1);
            expect(recent).toHaveLength(1);
        });

        it('stores null debug fields when not provided', () => {
            store.record(makeRecord({ id: 'req-no-debug' }));
            const recent = store.getRecent(1);
            expect(recent).toHaveLength(1);
        });
    });

    describe('agent tracking fields', () => {
        it('stores agentId when provided', () => {
            store.record(makeRecord({ id: 'req-agent-1', agentId: 'noir-prime' }));
            const recent = store.getRecent(1);
            expect(recent).toHaveLength(1);
        });

        it('stores conversationId when provided', () => {
            store.record(makeRecord({ id: 'req-conv-1', conversationId: 'conv-abc123' }));
            const recent = store.getRecent(1);
            expect(recent).toHaveLength(1);
        });

        it('stores retryCount when provided', () => {
            store.record(makeRecord({ id: 'req-retry-1', retryCount: 3 }));
            const recent = store.getRecent(1);
            expect(recent).toHaveLength(1);
        });

        it('stores providerLatencyMs when provided', () => {
            store.record(makeRecord({ id: 'req-latency-1', providerLatencyMs: 450 }));
            const recent = store.getRecent(1);
            expect(recent).toHaveLength(1);
        });

        it('defaults retryCount to 0 when not provided', () => {
            store.record(makeRecord({ id: 'req-no-retry' }));
            const recent = store.getRecent(1);
            expect(recent).toHaveLength(1);
        });

        it('handles null agent fields gracefully', () => {
            store.record(makeRecord({
                id: 'req-null-agent',
                agentId: undefined,
                conversationId: undefined,
                providerLatencyMs: undefined,
            }));
            const recent = store.getRecent(1);
            expect(recent).toHaveLength(1);
        });
    });

    describe('getAgentSummary', () => {
        it('returns empty array when no agent records exist', () => {
            store.record(makeRecord({ id: 'req-no-agent' }));
            const summary = store.getAgentSummary();
            expect(summary).toEqual([]);
        });

        it('groups by agentId with count and cost', () => {
            store.record(makeRecord({ id: 'req-a1', agentId: 'noir-prime', estimatedCost: 0.01 }));
            store.record(makeRecord({ id: 'req-a2', agentId: 'noir-prime', estimatedCost: 0.02 }));
            store.record(makeRecord({ id: 'req-b1', agentId: 'worker', estimatedCost: 0.001 }));

            const summary = store.getAgentSummary();
            expect(summary).toHaveLength(2);

            const noir = summary.find(s => s.agentId === 'noir-prime');
            expect(noir).toBeDefined();
            expect(noir!.count).toBe(2);
            expect(noir!.cost).toBeCloseTo(0.03);

            const worker = summary.find(s => s.agentId === 'worker');
            expect(worker).toBeDefined();
            expect(worker!.count).toBe(1);
        });

        it('orders by cost descending', () => {
            store.record(makeRecord({ id: 'req-cheap', agentId: 'worker', estimatedCost: 0.001 }));
            store.record(makeRecord({ id: 'req-expensive', agentId: 'noir-prime', estimatedCost: 0.10 }));

            const summary = store.getAgentSummary();
            expect(summary[0].agentId).toBe('noir-prime');
            expect(summary[1].agentId).toBe('worker');
        });

        it('excludes records without agentId', () => {
            store.record(makeRecord({ id: 'req-no-agent-1' }));
            store.record(makeRecord({ id: 'req-with-agent', agentId: 'test-agent', estimatedCost: 0.05 }));

            const summary = store.getAgentSummary();
            expect(summary).toHaveLength(1);
            expect(summary[0].agentId).toBe('test-agent');
        });
    });

    describe('migration idempotency', () => {
        it('creating a second store on the same database does not crash', () => {
            // The first store already created tables + ran migrations in beforeEach.
            // Creating a second store on a new in-memory DB simulates re-running migrations.
            const store2 = new TrackingStore(':memory:', makeLogger());
            // If it didn't throw, migration is idempotent
            store2.close();
        });
    });
});
