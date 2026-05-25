import { describe, it, expect } from 'vitest';
import { SyncConfigSchema, TierPriceBoundariesSchema, ResolverConfigSchema } from '../config/schema.js';

describe('sync config schema', () => {
    it('parses valid sync block', () => {
        const parsed = SyncConfigSchema.parse({
            enabled: true,
            intervalHours: 24,
            cacheFile: './data/catalog-cache.json',
            sources: {
                huggingface: { enabled: true, endpoint: 'https://router.huggingface.co/v1/models' },
                vercel: { enabled: true, endpoint: 'https://ai-gateway.vercel.sh/v1/models' },
                direct: { enabled: true },
            },
        });
        expect(parsed.intervalHours).toBe(24);
    });

    it('rejects non-positive intervalHours', () => {
        expect(() =>
            SyncConfigSchema.parse({
                enabled: true,
                intervalHours: 0,
                cacheFile: './x.json',
                sources: { huggingface: { enabled: false, endpoint: 'https://x' }, vercel: { enabled: false, endpoint: 'https://x' }, direct: { enabled: false } },
            }),
        ).toThrow();
    });
});

describe('tier price boundaries schema', () => {
    it('parses valid boundaries', () => {
        const parsed = TierPriceBoundariesSchema.parse({
            free:       { tier: [1, 3], maxInputPerMillion: 0.10, maxOutputPerMillion: 0.40 },
            economical: { tier: [4, 6], maxInputPerMillion: 1.00, maxOutputPerMillion: 4.00 },
            premium:    { tier: [7, 8], maxInputPerMillion: 5.00, maxOutputPerMillion: 20.00 },
            frontier:   { tier: [9, 10], maxInputPerMillion: 999, maxOutputPerMillion: 999 },
        });
        expect(parsed.free.maxInputPerMillion).toBe(0.10);
    });

    it('rejects tier tuple with min > max', () => {
        expect(() =>
            TierPriceBoundariesSchema.parse({
                free:       { tier: [5, 3], maxInputPerMillion: 0.10, maxOutputPerMillion: 0.40 },
                economical: { tier: [4, 6], maxInputPerMillion: 1.00, maxOutputPerMillion: 4.00 },
                premium:    { tier: [7, 8], maxInputPerMillion: 5.00, maxOutputPerMillion: 20.00 },
                frontier:   { tier: [9, 10], maxInputPerMillion: 999, maxOutputPerMillion: 999 },
            }),
        ).toThrow();
    });
});

describe('resolver config schema', () => {
    it('parses preference list', () => {
        const parsed = ResolverConfigSchema.parse({ preference: ['direct', 'huggingface', 'vercel'] });
        expect(parsed.preference).toEqual(['direct', 'huggingface', 'vercel']);
    });
});
