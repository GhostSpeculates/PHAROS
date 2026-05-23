import { describe, it, expect, vi } from 'vitest';
import { fetchHuggingFaceModels } from '../../sync/sources/huggingface.js';

const mockResponse = {
    object: 'list',
    data: [
        {
            id: 'meta-llama/Llama-3.3-70B-Instruct',
            object: 'model',
            owned_by: 'huggingface',
            providers: [
                { provider: 'together', status: 'live', pricing: { input: 0.88, output: 0.88 }, context_length: 128_000 },
                { provider: 'fireworks', status: 'live', pricing: { input: 0.90, output: 0.90 }, context_length: 128_000 },
            ],
        },
        {
            id: 'deepseek-ai/DeepSeek-V3',
            object: 'model',
            owned_by: 'huggingface',
            providers: [
                { provider: 'novita', status: 'live', pricing: { input: 0.27, output: 1.10 }, context_length: 64_000 },
            ],
        },
    ],
};

describe('huggingface source parser', () => {
    it('returns one DynamicEntry per (model, provider)', async () => {
        const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => mockResponse } as Response);
        const entries = await fetchHuggingFaceModels({
            endpoint: 'https://router.huggingface.co/v1/models',
            apiKey: 'hf_test',
            fetchFn,
            timeoutMs: 5000,
        });
        expect(entries).toHaveLength(3);
        const llamaTogether = entries.find(e => e.canonicalId === 'meta-llama/Llama-3.3-70B-Instruct' && e.provider === 'huggingface-together');
        expect(llamaTogether).toBeDefined();
        expect(llamaTogether!.pricing.inputPerMillion).toBe(0.88);
        expect(llamaTogether!.source).toBe('huggingface');
    });

    it('returns empty array when fetch fails', async () => {
        const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response);
        const entries = await fetchHuggingFaceModels({
            endpoint: 'https://router.huggingface.co/v1/models',
            apiKey: 'hf_test',
            fetchFn,
            timeoutMs: 5000,
        });
        expect(entries).toEqual([]);
    });

    it('returns empty array when timeout exceeded', async () => {
        const fetchFn = vi.fn().mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ ok: true, json: async () => mockResponse } as Response), 100)));
        const entries = await fetchHuggingFaceModels({
            endpoint: 'https://router.huggingface.co/v1/models',
            apiKey: 'hf_test',
            fetchFn,
            timeoutMs: 10,
        });
        expect(entries).toEqual([]);
    });
});
