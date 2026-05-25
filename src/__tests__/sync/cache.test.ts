import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCache, readCache } from '../../sync/cache.js';
import type { DynamicEntry } from '../../registry/dynamic.js';

const sample: DynamicEntry[] = [
    {
        canonicalId: 'openai/gpt-4o',
        id: 'gpt-4o',
        provider: 'openai',
        source: 'direct',
        displayName: 'GPT-4o',
        contextWindow: 128_000,
        pricing: { inputPerMillion: 2.5, outputPerMillion: 10 },
        syncedAt: 1747900800000,
    },
];

describe('sync cache file', () => {
    let path: string;
    beforeEach(async () => {
        path = join(tmpdir(), `pharos-cache-${Date.now()}-${Math.random()}.json`);
    });
    afterEach(async () => {
        try { await fs.unlink(path); } catch { /* ignore */ }
    });

    it('writes and reads back entries', async () => {
        await writeCache(path, sample);
        const out = await readCache(path);
        expect(out).toEqual(sample);
    });

    it('returns null when file missing', async () => {
        const out = await readCache('/nonexistent/path/x.json');
        expect(out).toBeNull();
    });

    it('returns null on corrupt JSON', async () => {
        await fs.writeFile(path, '{ not json', 'utf8');
        const out = await readCache(path);
        expect(out).toBeNull();
    });

    it('write is atomic (tmp+rename)', async () => {
        await writeCache(path, sample);
        const dir = path.substring(0, path.lastIndexOf('/'));
        const files = await fs.readdir(dir);
        const leftovers = files.filter(f => f.includes('pharos-cache') && f.endsWith('.tmp'));
        expect(leftovers).toHaveLength(0);
    });
});
