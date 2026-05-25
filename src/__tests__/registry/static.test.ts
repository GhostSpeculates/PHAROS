import { describe, it, expect } from 'vitest';
import { STATIC_SEED, type StaticSeedEntry } from '../../registry/static.js';

describe('static seed', () => {
    it('contains one entry per direct-key provider', () => {
        const providers = new Set(STATIC_SEED.map(e => e.provider));
        expect(providers).toContain('anthropic');
        expect(providers).toContain('openai');
        expect(providers).toContain('google');
        expect(providers).toContain('groq');
        expect(providers).toContain('moonshot');
        expect(providers).toContain('xai');
    });

    it('every entry has non-zero pricing', () => {
        for (const entry of STATIC_SEED) {
            const total = entry.pricing.inputPerMillion + entry.pricing.outputPerMillion;
            expect(total).toBeGreaterThan(0);
        }
    });

    it('every entry has a canonical id', () => {
        for (const entry of STATIC_SEED) {
            expect(entry.canonicalId).toMatch(/\//);
        }
    });
});
