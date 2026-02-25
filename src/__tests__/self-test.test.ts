import { describe, it, expect, vi, beforeEach } from 'vitest';
import { providerSelfTest } from '../utils/self-test.js';

// ─── Helpers ────────────────────────────────────────────

function mockLogger() {
    return {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        trace: vi.fn(),
        child: vi.fn().mockReturnThis(),
    } as any;
}

function createProvider(name: string, opts: { available?: boolean; chatResolve?: any; chatReject?: Error } = {}) {
    const { available = true, chatResolve, chatReject } = opts;
    const chatFn = chatReject
        ? vi.fn().mockRejectedValue(chatReject)
        : vi.fn().mockResolvedValue(chatResolve ?? {
            content: 'hi',
            model: 'test',
            usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 },
            finishReason: 'stop',
        });
    return {
        name,
        available,
        isHealthy: vi.fn().mockReturnValue(available),
        chat: chatFn,
        undoLastError: vi.fn(),
        getLatencyStats: vi.fn().mockReturnValue({ avgMs: 0, p95Ms: 0, samples: 0, degraded: false }),
    };
}

function createRegistry(providers: Record<string, ReturnType<typeof createProvider>>) {
    const map = new Map(Object.entries(providers));
    return {
        get: (name: string) => map.get(name),
        listAvailable: () =>
            Array.from(map.entries())
                .filter(([, p]) => p.available)
                .map(([n]) => n),
        isAvailable: (name: string) => map.get(name)?.available ?? false,
        getStatus: vi.fn(),
    } as any;
}

function minimalConfig(tierModels?: Record<string, Array<{ provider: string; model: string }>>) {
    const models = tierModels ?? {
        free: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }],
        economical: [{ provider: 'openai', model: 'gpt-4o' }],
        premium: [{ provider: 'anthropic', model: 'claude-sonnet-4-20250514' }],
        frontier: [{ provider: 'anthropic', model: 'claude-opus-4-20250514' }],
    };
    return {
        tiers: {
            free: { scoreRange: [1, 3], models: models.free ?? [] },
            economical: { scoreRange: [4, 6], models: models.economical ?? [] },
            premium: { scoreRange: [7, 8], models: models.premium ?? [] },
            frontier: { scoreRange: [9, 10], models: models.frontier ?? [] },
        },
    } as any;
}

// ─── Tests ──────────────────────────────────────────────

describe('providerSelfTest', () => {
    let logger: ReturnType<typeof mockLogger>;

    beforeEach(() => {
        logger = mockLogger();
    });

    it('sends a chat request to each available provider', async () => {
        const groq = createProvider('groq');
        const openai = createProvider('openai');
        const registry = createRegistry({ groq, openai });

        const results = await providerSelfTest(minimalConfig(), registry, logger);

        expect(groq.chat).toHaveBeenCalledOnce();
        expect(openai.chat).toHaveBeenCalledOnce();
        expect(results.passed).toHaveLength(2);
        expect(results.failed).toHaveLength(0);
    });

    it('uses the correct model from tier config for each provider', async () => {
        const groq = createProvider('groq');
        const registry = createRegistry({ groq });

        await providerSelfTest(minimalConfig(), registry, logger);

        expect(groq.chat).toHaveBeenCalledWith(
            expect.objectContaining({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: 'hi' }],
                maxTokens: 5,
            }),
        );
    });

    it('picks the first (cheapest) model for providers in multiple tiers', async () => {
        const anthropic = createProvider('anthropic');
        const registry = createRegistry({ anthropic });

        // anthropic appears in both premium and frontier
        await providerSelfTest(minimalConfig(), registry, logger);

        // Should use the first occurrence (premium: claude-sonnet)
        expect(anthropic.chat).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'claude-sonnet-4-20250514' }),
        );
    });

    it('logs success with latency for passing providers', async () => {
        const groq = createProvider('groq');
        const registry = createRegistry({ groq });

        await providerSelfTest(minimalConfig(), registry, logger);

        expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/✓ groq: responded in \d+ms/));
    });

    it('logs warning for failed providers', async () => {
        const groq = createProvider('groq', { chatReject: new Error('connection refused') });
        const registry = createRegistry({ groq });

        const results = await providerSelfTest(minimalConfig(), registry, logger);

        expect(logger.warn).toHaveBeenCalledWith('  ✗ groq: connection refused');
        expect(results.failed).toEqual(['groq: connection refused']);
        expect(results.passed).toHaveLength(0);
    });

    it('calls undoLastError on failed providers', async () => {
        const groq = createProvider('groq', { chatReject: new Error('timeout') });
        const registry = createRegistry({ groq });

        await providerSelfTest(minimalConfig(), registry, logger);

        expect(groq.undoLastError).toHaveBeenCalledOnce();
    });

    it('does not call undoLastError on passing providers', async () => {
        const groq = createProvider('groq');
        const registry = createRegistry({ groq });

        await providerSelfTest(minimalConfig(), registry, logger);

        expect(groq.undoLastError).not.toHaveBeenCalled();
    });

    it('handles a mix of passing and failing providers', async () => {
        const groq = createProvider('groq');
        const openai = createProvider('openai', { chatReject: new Error('rate limited') });
        const anthropic = createProvider('anthropic');
        const registry = createRegistry({ groq, openai, anthropic });

        const results = await providerSelfTest(minimalConfig(), registry, logger);

        expect(results.passed).toHaveLength(2);
        expect(results.failed).toHaveLength(1);
        expect(results.failed[0]).toContain('openai');
        expect(openai.undoLastError).toHaveBeenCalledOnce();
        expect(groq.undoLastError).not.toHaveBeenCalled();
        expect(anthropic.undoLastError).not.toHaveBeenCalled();
    });

    it('skips providers not in any tier config', async () => {
        const groq = createProvider('groq');
        const mistral = createProvider('mistral'); // not in tier config
        const registry = createRegistry({ groq, mistral });

        const results = await providerSelfTest(minimalConfig(), registry, logger);

        expect(groq.chat).toHaveBeenCalledOnce();
        expect(mistral.chat).not.toHaveBeenCalled();
        expect(results.passed).toHaveLength(1);
    });

    it('returns empty arrays when no providers available', async () => {
        const registry = createRegistry({});

        const results = await providerSelfTest(minimalConfig(), registry, logger);

        expect(results.passed).toHaveLength(0);
        expect(results.failed).toHaveLength(0);
        expect(logger.warn).toHaveBeenCalledWith('Self-test: no providers available, skipping');
    });

    it('returns empty arrays when available providers have no tier models', async () => {
        const mistral = createProvider('mistral');
        const registry = createRegistry({ mistral });

        const results = await providerSelfTest(minimalConfig(), registry, logger);

        expect(results.passed).toHaveLength(0);
        expect(results.failed).toHaveLength(0);
        expect(logger.warn).toHaveBeenCalledWith(
            'Self-test: no providers with tier-configured models, skipping',
        );
    });

    it('logs the number of providers being tested', async () => {
        const groq = createProvider('groq');
        const openai = createProvider('openai');
        const registry = createRegistry({ groq, openai });

        await providerSelfTest(minimalConfig(), registry, logger);

        expect(logger.info).toHaveBeenCalledWith('Self-test: testing 2 providers...');
    });

    it('runs all provider tests in parallel', async () => {
        const callOrder: string[] = [];
        const groq = createProvider('groq');
        groq.chat = vi.fn().mockImplementation(async () => {
            callOrder.push('groq-start');
            await new Promise((r) => setTimeout(r, 50));
            callOrder.push('groq-end');
            return { content: 'hi', model: 'test', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: 'stop' };
        });
        const openai = createProvider('openai');
        openai.chat = vi.fn().mockImplementation(async () => {
            callOrder.push('openai-start');
            await new Promise((r) => setTimeout(r, 50));
            callOrder.push('openai-end');
            return { content: 'hi', model: 'test', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: 'stop' };
        });
        const registry = createRegistry({ groq, openai });

        await providerSelfTest(minimalConfig(), registry, logger);

        // Both should start before either ends (parallel execution)
        expect(callOrder.indexOf('groq-start')).toBeLessThan(callOrder.indexOf('groq-end'));
        expect(callOrder.indexOf('openai-start')).toBeLessThan(callOrder.indexOf('openai-end'));
        // Both start before any end
        expect(callOrder.indexOf('openai-start')).toBeLessThan(callOrder.indexOf('groq-end'));
    });

    it('includes passed provider names with latency in results', async () => {
        const groq = createProvider('groq');
        const registry = createRegistry({ groq });

        const results = await providerSelfTest(minimalConfig(), registry, logger);

        expect(results.passed).toHaveLength(1);
        expect(results.passed[0]).toMatch(/^groq \(\d+ms\)$/);
    });

    it('includes failed provider names with error in results', async () => {
        const groq = createProvider('groq', { chatReject: new Error('auth failed') });
        const registry = createRegistry({ groq });

        const results = await providerSelfTest(minimalConfig(), registry, logger);

        expect(results.failed).toEqual(['groq: auth failed']);
    });
});
