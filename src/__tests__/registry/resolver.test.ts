import { describe, it, expect, beforeEach } from 'vitest';
import { resolvePaths } from '../../registry/resolver.js';
import { DynamicRegistry, type DynamicEntry } from '../../registry/dynamic.js';
import { setDynamicRegistryForTesting } from '../../registry/index.js';

const llamaGroq: DynamicEntry = {
    canonicalId: 'meta-llama/Llama-3.3-70B-Instruct', id: 'llama-3.3-70b-versatile',
    provider: 'groq', source: 'direct', displayName: 'Llama 70B',
    contextWindow: 128_000, pricing: { inputPerMillion: 0.59, outputPerMillion: 0.79 },
    syncedAt: 1,
};
const llamaHF: DynamicEntry = {
    canonicalId: 'meta-llama/Llama-3.3-70B-Instruct', id: 'meta-llama/Llama-3.3-70B-Instruct',
    provider: 'huggingface-together', source: 'huggingface', displayName: 'Llama 70B',
    contextWindow: 128_000, pricing: { inputPerMillion: 0.88, outputPerMillion: 0.88 },
    syncedAt: 1,
};
const llamaVercel: DynamicEntry = {
    canonicalId: 'meta-llama/Llama-3.3-70B-Instruct', id: 'meta-llama/Llama-3.3-70B-Instruct',
    provider: 'vercel-gateway', source: 'vercel', displayName: 'Llama 70B',
    contextWindow: 128_000, pricing: { inputPerMillion: 1.00, outputPerMillion: 1.00 },
    syncedAt: 1,
};

describe('resolver', () => {
    beforeEach(() => {
        const reg = new DynamicRegistry();
        reg.upsert(llamaGroq); reg.upsert(llamaHF); reg.upsert(llamaVercel);
        setDynamicRegistryForTesting(reg);
    });

    it('returns paths in preference order direct > huggingface > vercel', () => {
        const paths = resolvePaths('meta-llama/Llama-3.3-70B-Instruct', ['direct', 'huggingface', 'vercel']);
        expect(paths.map(p => p.source)).toEqual(['direct', 'huggingface', 'vercel']);
    });

    it('returns empty when canonicalId unknown', () => {
        expect(resolvePaths('nonexistent/model', ['direct', 'huggingface', 'vercel'])).toEqual([]);
    });

    it('respects custom preference order', () => {
        const paths = resolvePaths('meta-llama/Llama-3.3-70B-Instruct', ['vercel', 'direct', 'huggingface']);
        expect(paths.map(p => p.source)).toEqual(['vercel', 'direct', 'huggingface']);
    });
});
