import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSync } from '../../sync/index.js';
import { setDynamicRegistry, getMergedRegistry } from '../../registry/index.js';
import { DynamicRegistry } from '../../registry/dynamic.js';
import { populateTiers } from '../../sync/tier-populator.js';
import type { TierPriceBoundaries } from '../../config/schema.js';

const boundaries: TierPriceBoundaries = {
    free:       { tier: [1, 3], maxInputPerMillion: 0.10, maxOutputPerMillion: 0.40 },
    economical: { tier: [4, 6], maxInputPerMillion: 1.00, maxOutputPerMillion: 4.00 },
    premium:    { tier: [7, 8], maxInputPerMillion: 5.00, maxOutputPerMillion: 20.00 },
    frontier:   { tier: [9, 10], maxInputPerMillion: 999, maxOutputPerMillion: 999 },
};

describe('e2e: new HF model appears, gets bucketed', () => {
    let cachePath: string;
    beforeEach(() => { cachePath = join(tmpdir(), `pharos-e2e-${Date.now()}.json`); });

    it('synthetic new HF model lands in correct tier', async () => {
        const syntheticModel = {
            canonicalId: 'new-org/Shiny-Cheap-Model',
            id: 'new-org/Shiny-Cheap-Model:novita',
            provider: 'huggingface',
            source: 'huggingface' as const,
            displayName: 'Shiny Cheap',
            contextWindow: 128_000,
            pricing: { inputPerMillion: 0.05, outputPerMillion: 0.10 },
            syncedAt: Date.now(),
        };

        const result = await runSync({
            cachePath,
            sources: {
                huggingface: async () => [syntheticModel],
                vercel: async () => [],
                direct: async () => [],
            },
        });

        const reg = new DynamicRegistry();
        reg.replaceAll(result.entries);
        setDynamicRegistry(reg);

        const merged = getMergedRegistry();
        expect(merged.find(m => m.canonicalId === 'new-org/Shiny-Cheap-Model')).toBeDefined();

        const tiers = populateTiers(merged, boundaries);
        const freeIds = tiers.free.models.map(m => m.model);
        expect(freeIds).toContain('new-org/Shiny-Cheap-Model:novita');

        await fs.unlink(cachePath).catch(() => {});
    });
});
