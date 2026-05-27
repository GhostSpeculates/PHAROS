import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrackingStore } from '../tracking/store.js';
import type { RequestRecord } from '../tracking/types.js';
import type { Logger } from '../utils/logger.js';
import { truncateAll } from './_helpers/test-db.js';

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
    let sql: ReturnType<typeof postgres>;
    let store: TrackingStore;
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
        store = new TrackingStore({ sql, logger });
    });

    afterEach(() => {
        store.close(); // no-op — connection owned by sql singleton
    });

    describe('record insertion', () => {
        it('inserts a record successfully', async () => {
            const record = makeRecord({ id: 'req-001' });
            await store.record(record);

            const recent = await store.getRecent(1);
            expect(recent).toHaveLength(1);
            expect(recent[0].provider).toBe('groq');
        });

        it('inserts multiple records', async () => {
            await store.record(makeRecord({ id: 'req-001' }));
            await store.record(makeRecord({ id: 'req-002' }));
            await store.record(makeRecord({ id: 'req-003' }));

            const recent = await store.getRecent(10);
            expect(recent).toHaveLength(3);
        });

        it('handles null userMessagePreview', async () => {
            await store.record(makeRecord({ id: 'req-001', userMessagePreview: undefined as any }));
            const recent = await store.getRecent(1);
            expect(recent[0].preview).toBeNull();
        });
    });

    describe('getSummary', () => {
        it('returns zero totals when empty', async () => {
            const summary = await store.getSummary();
            expect(summary.totalRequests).toBe(0);
            expect(summary.totalCost).toBe(0);
            expect(summary.totalSavings).toBe(0);
            expect(summary.savingsPercent).toBe(0);
        });

        it('sums costs and savings correctly', async () => {
            await store.record(makeRecord({ id: 'req-001', estimatedCost: 0.01, baselineCost: 0.05, savings: 0.04 }));
            await store.record(makeRecord({ id: 'req-002', estimatedCost: 0.02, baselineCost: 0.10, savings: 0.08 }));

            const summary = await store.getSummary();
            expect(summary.totalRequests).toBe(2);
            expect(summary.totalCost).toBeCloseTo(0.03);
            expect(summary.totalSavings).toBeCloseTo(0.12);
        });

        it('groups by tier', async () => {
            await store.record(makeRecord({ id: 'req-001', tier: 'free' }));
            await store.record(makeRecord({ id: 'req-002', tier: 'free' }));
            await store.record(makeRecord({ id: 'req-003', tier: 'premium' }));

            const summary = await store.getSummary();
            expect(summary.byTier['free']?.count).toBe(2);
            expect(summary.byTier['premium']?.count).toBe(1);
        });

        it('groups by provider', async () => {
            await store.record(makeRecord({ id: 'req-001', provider: 'groq' }));
            await store.record(makeRecord({ id: 'req-002', provider: 'anthropic' }));
            await store.record(makeRecord({ id: 'req-003', provider: 'groq' }));

            const summary = await store.getSummary();
            expect(summary.byProvider['groq']?.count).toBe(2);
            expect(summary.byProvider['anthropic']?.count).toBe(1);
        });

        it('calculates savings percent correctly', async () => {
            await store.record(makeRecord({ id: 'req-001', estimatedCost: 0.01, baselineCost: 0.10, savings: 0.09 }));

            const summary = await store.getSummary();
            expect(summary.savingsPercent).toBeCloseTo(90);
        });
    });

    describe('getRecent', () => {
        it('returns records in reverse chronological order', async () => {
            const t1 = '2026-02-23T10:00:00.000Z';
            const t2 = '2026-02-23T11:00:00.000Z';
            const t3 = '2026-02-23T12:00:00.000Z';

            await store.record(makeRecord({ id: 'req-001', timestamp: t1 }));
            await store.record(makeRecord({ id: 'req-002', timestamp: t2 }));
            await store.record(makeRecord({ id: 'req-003', timestamp: t3 }));

            const recent = await store.getRecent(3);
            expect(recent[0].timestamp).toBe(t3);
            expect(recent[1].timestamp).toBe(t2);
            expect(recent[2].timestamp).toBe(t1);
        });

        it('respects the limit parameter', async () => {
            for (let i = 0; i < 10; i++) {
                await store.record(makeRecord({ id: `req-${i}` }));
            }

            const recent = await store.getRecent(3);
            expect(recent).toHaveLength(3);
        });

        it('maps fields correctly', async () => {
            await store.record(makeRecord({
                id: 'req-001',
                classificationScore: 7,
                classificationType: 'code',
                tier: 'premium',
                provider: 'anthropic',
                model: 'claude-sonnet-4-20250514',
                stream: true,
                classifierProvider: 'groq',
            }));

            const [recent] = await store.getRecent(1);
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
    });

    describe('error tracking', () => {
        it('defaults status to success when not provided', async () => {
            await store.record(makeRecord({ id: 'req-ok-001' }));

            const recent = await store.getRecent(1);
            expect(recent).toHaveLength(1);
            expect(recent[0].status).toBe('success');
            expect(recent[0].errorMessage).toBeNull();
        });

        it('records a failed request with status error and error message', async () => {
            await store.record(makeRecord({
                id: 'req-err-001',
                status: 'error',
                errorMessage: 'All providers failed after 3 retry attempts',
            }));

            const recent = await store.getRecent(1);
            expect(recent).toHaveLength(1);
            expect(recent[0].status).toBe('error');
            expect(recent[0].errorMessage).toBe('All providers failed after 3 retry attempts');
        });

        it('records a success with explicit status', async () => {
            await store.record(makeRecord({
                id: 'req-ok-002',
                status: 'success',
            }));

            const recent = await store.getRecent(1);
            expect(recent[0].status).toBe('success');
            expect(recent[0].errorMessage).toBeNull();
        });

        it('getSummary includes totalErrors and errorRate', async () => {
            await store.record(makeRecord({ id: 'req-001' }));
            await store.record(makeRecord({ id: 'req-002' }));
            await store.record(makeRecord({ id: 'req-003', status: 'error', errorMessage: 'timeout' }));

            const summary = await store.getSummary();
            expect(summary.totalErrors).toBe(1);
            expect(summary.totalRequests).toBe(3);
            expect(summary.errorRate).toBeCloseTo(33.33, 1);
        });

        it('getSummary returns zero errors when all requests succeed', async () => {
            await store.record(makeRecord({ id: 'req-001' }));
            await store.record(makeRecord({ id: 'req-002' }));

            const summary = await store.getSummary();
            expect(summary.totalErrors).toBe(0);
            expect(summary.errorRate).toBe(0);
        });

        it('getSummary returns zero error rate when no requests exist', async () => {
            const summary = await store.getSummary();
            expect(summary.totalErrors).toBe(0);
            expect(summary.errorRate).toBe(0);
        });

        it('calculates error rate accurately (2 errors out of 10 = 20%)', async () => {
            for (let i = 0; i < 8; i++) {
                await store.record(makeRecord({ id: `req-ok-${i}` }));
            }
            await store.record(makeRecord({ id: 'req-err-1', status: 'error', errorMessage: 'error 1' }));
            await store.record(makeRecord({ id: 'req-err-2', status: 'error', errorMessage: 'error 2' }));

            const summary = await store.getSummary();
            expect(summary.totalRequests).toBe(10);
            expect(summary.totalErrors).toBe(2);
            expect(summary.errorRate).toBeCloseTo(20);
        });

        it('getRecent includes status and errorMessage fields', async () => {
            await store.record(makeRecord({ id: 'req-ok-001' }));
            await store.record(makeRecord({
                id: 'req-err-001',
                status: 'error',
                errorMessage: 'Provider unavailable',
            }));

            const recent = await store.getRecent(10);
            expect(recent).toHaveLength(2);

            for (const r of recent) {
                expect(r).toHaveProperty('status');
                expect(r).toHaveProperty('errorMessage');
            }

            const errorRecord = recent.find(r => r.status === 'error');
            expect(errorRecord).toBeDefined();
            expect(errorRecord!.errorMessage).toBe('Provider unavailable');

            const successRecord = recent.find(r => r.status === 'success');
            expect(successRecord).toBeDefined();
            expect(successRecord!.errorMessage).toBeNull();
        });

        it('handles null errorMessage for error status', async () => {
            await store.record(makeRecord({
                id: 'req-err-no-msg',
                status: 'error',
            }));

            const recent = await store.getRecent(1);
            expect(recent[0].status).toBe('error');
            expect(recent[0].errorMessage).toBeNull();
        });
    });

    describe('spending queries', () => {
        it('getDailySpend returns 0 when no records exist', async () => {
            expect(await store.getDailySpend()).toBe(0);
        });

        it('getDailySpend sums costs for today only', async () => {
            const today = new Date().toISOString().slice(0, 10);
            const yesterday = new Date(Date.now() - 86400000).toISOString();

            await store.record(makeRecord({
                id: 'req-today-1',
                timestamp: `${today}T12:00:00.000Z`,
                estimatedCost: 0.05,
            }));
            await store.record(makeRecord({
                id: 'req-today-2',
                timestamp: `${today}T13:00:00.000Z`,
                estimatedCost: 0.10,
            }));
            await store.record(makeRecord({
                id: 'req-yesterday',
                timestamp: yesterday,
                estimatedCost: 1.00,
            }));

            expect(await store.getDailySpend()).toBeCloseTo(0.15);
        });

        it('getMonthlySpend returns 0 when no records exist', async () => {
            expect(await store.getMonthlySpend()).toBe(0);
        });

        it('getMonthlySpend sums costs for the current month', async () => {
            const monthStart = new Date().toISOString().slice(0, 7) + '-01';
            const lastMonth = new Date(Date.now() - 35 * 86400000).toISOString();

            await store.record(makeRecord({
                id: 'req-this-month-1',
                timestamp: `${monthStart}T12:00:00.000Z`,
                estimatedCost: 0.50,
            }));
            await store.record(makeRecord({
                id: 'req-this-month-2',
                timestamp: new Date().toISOString(),
                estimatedCost: 0.25,
            }));
            await store.record(makeRecord({
                id: 'req-last-month',
                timestamp: lastMonth,
                estimatedCost: 5.00,
            }));

            expect(await store.getMonthlySpend()).toBeCloseTo(0.75);
        });
    });

    describe('debug logging fields', () => {
        it('stores debugInput when provided', async () => {
            await store.record(makeRecord({
                id: 'req-debug-1',
                debugInput: 'What is the capital of France?',
            }));

            const recent = await store.getRecent(1);
            expect(recent).toHaveLength(1);
        });

        it('stores debugOutput when provided', async () => {
            await store.record(makeRecord({
                id: 'req-debug-2',
                debugInput: 'What is 2+2?',
                debugOutput: 'The answer is 4.',
            }));

            const recent = await store.getRecent(1);
            expect(recent).toHaveLength(1);
        });

        it('stores null debug fields when not provided', async () => {
            await store.record(makeRecord({ id: 'req-no-debug' }));
            const recent = await store.getRecent(1);
            expect(recent).toHaveLength(1);
        });
    });

    describe('agent tracking fields', () => {
        it('stores agentId when provided', async () => {
            await store.record(makeRecord({ id: 'req-agent-1', agentId: 'noir-prime' }));
            const recent = await store.getRecent(1);
            expect(recent).toHaveLength(1);
        });

        it('stores conversationId when provided', async () => {
            await store.record(makeRecord({ id: 'req-conv-1', conversationId: 'conv-abc123' }));
            const recent = await store.getRecent(1);
            expect(recent).toHaveLength(1);
        });

        it('stores retryCount when provided', async () => {
            await store.record(makeRecord({ id: 'req-retry-1', retryCount: 3 }));
            const recent = await store.getRecent(1);
            expect(recent).toHaveLength(1);
        });

        it('stores providerLatencyMs when provided', async () => {
            await store.record(makeRecord({ id: 'req-latency-1', providerLatencyMs: 450 }));
            const recent = await store.getRecent(1);
            expect(recent).toHaveLength(1);
        });

        it('defaults retryCount to 0 when not provided', async () => {
            await store.record(makeRecord({ id: 'req-no-retry' }));
            const recent = await store.getRecent(1);
            expect(recent).toHaveLength(1);
        });

        it('handles null agent fields gracefully', async () => {
            await store.record(makeRecord({
                id: 'req-null-agent',
                agentId: undefined,
                conversationId: undefined,
                providerLatencyMs: undefined,
            }));
            const recent = await store.getRecent(1);
            expect(recent).toHaveLength(1);
        });
    });

    describe('getAgentSummary', () => {
        it('returns empty array when no agent records exist', async () => {
            await store.record(makeRecord({ id: 'req-no-agent' }));
            const summary = await store.getAgentSummary();
            expect(summary).toEqual([]);
        });

        it('groups by agentId with count and cost', async () => {
            await store.record(makeRecord({ id: 'req-a1', agentId: 'noir-prime', estimatedCost: 0.01 }));
            await store.record(makeRecord({ id: 'req-a2', agentId: 'noir-prime', estimatedCost: 0.02 }));
            await store.record(makeRecord({ id: 'req-b1', agentId: 'worker', estimatedCost: 0.001 }));

            const summary = await store.getAgentSummary();
            expect(summary).toHaveLength(2);

            const noir = summary.find(s => s.agentId === 'noir-prime');
            expect(noir).toBeDefined();
            expect(noir!.count).toBe(2);
            expect(noir!.cost).toBeCloseTo(0.03);

            const worker = summary.find(s => s.agentId === 'worker');
            expect(worker).toBeDefined();
            expect(worker!.count).toBe(1);
        });

        it('orders by cost descending', async () => {
            await store.record(makeRecord({ id: 'req-cheap', agentId: 'worker', estimatedCost: 0.001 }));
            await store.record(makeRecord({ id: 'req-expensive', agentId: 'noir-prime', estimatedCost: 0.10 }));

            const summary = await store.getAgentSummary();
            expect(summary[0].agentId).toBe('noir-prime');
            expect(summary[1].agentId).toBe('worker');
        });

        it('excludes records without agentId', async () => {
            await store.record(makeRecord({ id: 'req-no-agent-1' }));
            await store.record(makeRecord({ id: 'req-with-agent', agentId: 'test-agent', estimatedCost: 0.05 }));

            const summary = await store.getAgentSummary();
            expect(summary).toHaveLength(1);
            expect(summary[0].agentId).toBe('test-agent');
        });
    });

    describe('findByRequestId', () => {
        it('returns null for unknown id', async () => {
            const result = await store.findByRequestId('nonexistent-id');
            expect(result).toBeNull();
        });

        it('returns the full record for a known id', async () => {
            const rec = makeRecord({
                id: 'req-find-001',
                tier: 'premium',
                provider: 'anthropic',
                classifierProvider: 'groq',
                status: 'success',
            });
            await store.record(rec);

            const found = await store.findByRequestId('req-find-001');
            expect(found).not.toBeNull();
            expect(found!.id).toBe('req-find-001');
            expect(found!.tier).toBe('premium');
            expect(found!.provider).toBe('anthropic');
            expect(found!.classifierProvider).toBe('groq');
        });
    });
});
