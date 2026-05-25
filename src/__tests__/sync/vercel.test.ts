import { describe, it, expect, vi } from 'vitest';
import { fetchVercelGatewayModels } from '../../sync/sources/vercel.js';

const mockResponse = {
    object: 'list',
    data: [
        {
            id: 'anthropic/claude-sonnet-4',
            object: 'model',
            pricing: { input: 3.0, output: 15.0 },
            context_window: 200_000,
        },
        {
            id: 'openai/gpt-4o',
            object: 'model',
            pricing: { input: 2.5, output: 10.0 },
            context_window: 128_000,
        },
    ],
};

describe('vercel gateway source parser', () => {
    it('returns DynamicEntry list from /models', async () => {
        const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => mockResponse } as Response);
        const entries = await fetchVercelGatewayModels({
            endpoint: 'https://ai-gateway.vercel.sh/v1/models',
            apiKey: 'vck_test',
            fetchFn,
            timeoutMs: 5000,
        });
        expect(entries).toHaveLength(2);
        expect(entries[0].source).toBe('vercel');
        expect(entries[0].provider).toBe('vercel_gateway');
        const sonnet = entries.find(e => e.canonicalId === 'anthropic/claude-sonnet-4');
        expect(sonnet!.pricing.inputPerMillion).toBe(3.0);
    });

    it('returns empty array on non-ok response', async () => {
        const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 401 } as Response);
        const entries = await fetchVercelGatewayModels({
            endpoint: 'https://ai-gateway.vercel.sh/v1/models',
            apiKey: 'bad',
            fetchFn,
            timeoutMs: 5000,
        });
        expect(entries).toEqual([]);
    });
});
