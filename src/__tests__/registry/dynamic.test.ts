import { describe, it, expect, beforeEach } from 'vitest';
import { DynamicRegistry, type DynamicEntry } from '../../registry/dynamic.js';

const sample: DynamicEntry = {
    canonicalId: 'meta-llama/Llama-3.3-70B-Instruct',
    id: 'llama-3.3-70b-versatile',
    provider: 'groq',
    source: 'direct',
    displayName: 'Llama 3.3 70B',
    contextWindow: 128_000,
    pricing: { inputPerMillion: 0.59, outputPerMillion: 0.79 },
    syncedAt: 1747900800000,
};

describe('DynamicRegistry', () => {
    let reg: DynamicRegistry;
    beforeEach(() => { reg = new DynamicRegistry(); });

    it('stores and retrieves entries by canonical id', () => {
        reg.upsert(sample);
        const found = reg.getByCanonical('meta-llama/Llama-3.3-70B-Instruct');
        expect(found).toHaveLength(1);
        expect(found[0].provider).toBe('groq');
    });

    it('keeps multiple provider entries for the same canonical id', () => {
        reg.upsert(sample);
        reg.upsert({ ...sample, provider: 'together', source: 'huggingface' });
        const found = reg.getByCanonical('meta-llama/Llama-3.3-70B-Instruct');
        expect(found).toHaveLength(2);
    });

    it('replaces same (canonical,provider,source) on upsert', () => {
        reg.upsert(sample);
        reg.upsert({ ...sample, pricing: { inputPerMillion: 0.50, outputPerMillion: 0.70 } });
        const found = reg.getByCanonical('meta-llama/Llama-3.3-70B-Instruct');
        expect(found).toHaveLength(1);
        expect(found[0].pricing.inputPerMillion).toBe(0.50);
    });

    it('replaceAll wipes prior state', () => {
        reg.upsert(sample);
        reg.replaceAll([{ ...sample, canonicalId: 'openai/gpt-4o' }]);
        expect(reg.getByCanonical('meta-llama/Llama-3.3-70B-Instruct')).toEqual([]);
        expect(reg.getByCanonical('openai/gpt-4o')).toHaveLength(1);
    });

    it('listAll returns flat array', () => {
        reg.upsert(sample);
        reg.upsert({ ...sample, provider: 'together', source: 'huggingface' });
        expect(reg.listAll()).toHaveLength(2);
    });
});
