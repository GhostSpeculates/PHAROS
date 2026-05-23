import { describe, it, expect, vi } from 'vitest';
import { fetchDirectProviderModels } from '../../sync/sources/direct.js';

const openaiResponse = { data: [{ id: 'gpt-4o', object: 'model' }, { id: 'o3', object: 'model' }] };
const groqResponse = { data: [{ id: 'llama-3.3-70b-versatile', object: 'model' }] };

describe('direct providers source parser', () => {
    it('fetches /v1/models from configured direct providers', async () => {
        const fetchFn = vi.fn().mockImplementation(async (url: string) => {
            if (url.includes('groq')) return { ok: true, json: async () => groqResponse } as Response;
            if (url.includes('openai')) return { ok: true, json: async () => openaiResponse } as Response;
            return { ok: false, status: 404 } as Response;
        });

        const entries = await fetchDirectProviderModels({
            providers: [
                { name: 'openai', endpoint: 'https://api.openai.com/v1/models', apiKey: 'sk-test', staticPricing: { 'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 } } },
                { name: 'groq',   endpoint: 'https://api.groq.com/openai/v1/models', apiKey: 'gsk-test', staticPricing: { 'llama-3.3-70b-versatile': { inputPerMillion: 0.59, outputPerMillion: 0.79 } } },
            ],
            fetchFn,
            timeoutMs: 5000,
        });

        expect(entries.find(e => e.id === 'gpt-4o')).toBeDefined();
        expect(entries.find(e => e.id === 'llama-3.3-70b-versatile')).toBeDefined();
    });

    it('skips providers without api key', async () => {
        const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => openaiResponse } as Response);
        const entries = await fetchDirectProviderModels({
            providers: [{ name: 'openai', endpoint: 'https://api.openai.com/v1/models', apiKey: '', staticPricing: {} }],
            fetchFn,
            timeoutMs: 5000,
        });
        expect(entries).toEqual([]);
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('continues when one provider fails', async () => {
        const fetchFn = vi.fn().mockImplementation(async (url: string) => {
            if (url.includes('groq')) return { ok: true, json: async () => groqResponse } as Response;
            if (url.includes('openai')) throw new Error('boom');
            return { ok: false, status: 404 } as Response;
        });
        const entries = await fetchDirectProviderModels({
            providers: [
                { name: 'openai', endpoint: 'https://api.openai.com/v1/models', apiKey: 'sk', staticPricing: {} },
                { name: 'groq',   endpoint: 'https://api.groq.com/openai/v1/models', apiKey: 'gsk', staticPricing: { 'llama-3.3-70b-versatile': { inputPerMillion: 0.59, outputPerMillion: 0.79 } } },
            ],
            fetchFn,
            timeoutMs: 5000,
        });
        expect(entries.find(e => e.id === 'llama-3.3-70b-versatile')).toBeDefined();
    });
});
