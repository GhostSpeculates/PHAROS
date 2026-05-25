import { describe, it, expect, beforeEach } from 'vitest';
import { getMergedRegistry, setDynamicRegistryForTesting } from '../../registry/index.js';
import { DynamicRegistry, type DynamicEntry } from '../../registry/dynamic.js';

const dynEntry: DynamicEntry = {
    canonicalId: 'deepseek-ai/DeepSeek-V3',
    id: 'deepseek-chat',
    provider: 'deepseek',
    source: 'direct',
    displayName: 'DeepSeek V3',
    contextWindow: 64_000,
    pricing: { inputPerMillion: 0.27, outputPerMillion: 1.10 },
    syncedAt: 1747900800000,
};

describe('merged registry', () => {
    beforeEach(() => {
        const reg = new DynamicRegistry();
        reg.upsert(dynEntry);
        setDynamicRegistryForTesting(reg);
    });

    it('returns static seed entries', () => {
        const all = getMergedRegistry();
        const ids = all.map(e => e.canonicalId);
        expect(ids).toContain('openai/gpt-4o');
        expect(ids).toContain('anthropic/claude-sonnet-4');
    });

    it('returns dynamic entries', () => {
        const all = getMergedRegistry();
        expect(all.find(e => e.canonicalId === 'deepseek-ai/DeepSeek-V3')).toBeDefined();
    });

    it('dedupes by (canonicalId, provider) — dynamic wins over static', () => {
        // Add a dynamic entry shadowing a static one
        const reg = new DynamicRegistry();
        reg.upsert({ ...dynEntry, canonicalId: 'openai/gpt-4o', id: 'gpt-4o', provider: 'openai', pricing: { inputPerMillion: 1.99, outputPerMillion: 7.99 } });
        setDynamicRegistryForTesting(reg);
        const all = getMergedRegistry();
        const gpt = all.filter(e => e.canonicalId === 'openai/gpt-4o' && e.provider === 'openai');
        expect(gpt).toHaveLength(1);
        expect(gpt[0].pricing.inputPerMillion).toBe(1.99); // dynamic price wins
    });
});
