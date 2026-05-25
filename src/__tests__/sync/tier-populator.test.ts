import { describe, it, expect } from 'vitest';
import { populateTiers } from '../../sync/tier-populator.js';
import type { MergedEntry } from '../../registry/index.js';
import type { TierPriceBoundaries } from '../../config/schema.js';

const boundaries: TierPriceBoundaries = {
    free:       { tier: [1, 3], maxInputPerMillion: 0.10, maxOutputPerMillion: 0.40 },
    economical: { tier: [4, 6], maxInputPerMillion: 1.00, maxOutputPerMillion: 4.00 },
    premium:    { tier: [7, 8], maxInputPerMillion: 5.00, maxOutputPerMillion: 20.00 },
    frontier:   { tier: [9, 10], maxInputPerMillion: 999,  maxOutputPerMillion: 999 },
};

const sample = (provider: string, id: string, ip: number, op: number): MergedEntry => ({
    canonicalId: `x/${id}`, id, provider,
    displayName: id, contextWindow: 0,
    pricing: { inputPerMillion: ip, outputPerMillion: op },
    source: 'direct',
});

describe('tier populator', () => {
    it('buckets models by input+output price boundaries', () => {
        const merged: MergedEntry[] = [
            sample('google', 'gemini-2.5-flash', 0.075, 0.30),  // free
            sample('groq',   'llama-3.3-70b-versatile', 0.59, 0.79),  // economical
            sample('anthropic', 'claude-sonnet-4-20250514', 3.0, 15.0),  // premium
            sample('anthropic', 'claude-opus-4-20250514', 15.0, 75.0),  // frontier
        ];
        const tiers = populateTiers(merged, boundaries);
        expect(tiers.free.models).toEqual([{ provider: 'google', model: 'gemini-2.5-flash' }]);
        expect(tiers.economical.models).toEqual([{ provider: 'groq', model: 'llama-3.3-70b-versatile' }]);
        expect(tiers.premium.models).toEqual([{ provider: 'anthropic', model: 'claude-sonnet-4-20250514' }]);
        expect(tiers.frontier.models).toEqual([{ provider: 'anthropic', model: 'claude-opus-4-20250514' }]);
    });

    it('sorts each tier ascending by input price', () => {
        const merged: MergedEntry[] = [
            sample('groq',   'llama-3.3-70b-versatile', 0.59, 0.79),
            sample('moonshot','kimi-latest', 0.50, 2.00),
            sample('deepseek','deepseek-chat', 0.27, 1.10),
        ];
        const tiers = populateTiers(merged, boundaries);
        expect(tiers.economical.models[0].provider).toBe('deepseek');
        expect(tiers.economical.models[2].provider).toBe('groq');
    });

    it('produces empty model list if no entry fits a tier', () => {
        const merged: MergedEntry[] = [sample('anthropic', 'claude-opus-4', 15, 75)];
        const tiers = populateTiers(merged, boundaries);
        expect(tiers.free.models).toEqual([]);
        expect(tiers.economical.models).toEqual([]);
        expect(tiers.premium.models).toEqual([]);
        expect(tiers.frontier.models).toHaveLength(1);
    });

    it('returns scoreRange matching boundaries', () => {
        const tiers = populateTiers([], boundaries);
        expect(tiers.free.scoreRange).toEqual([1, 3]);
        expect(tiers.frontier.scoreRange).toEqual([9, 10]);
    });
});
