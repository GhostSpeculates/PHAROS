import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSync } from '../../sync/index.js';
import type { DynamicEntry } from '../../registry/dynamic.js';

const sample = (canonicalId: string, provider: string, source: DynamicEntry['source']): DynamicEntry => ({
    canonicalId, id: canonicalId.split('/')[1], provider, source,
    displayName: canonicalId, contextWindow: 0,
    pricing: { inputPerMillion: 1, outputPerMillion: 2 }, syncedAt: Date.now(),
});

describe('sync orchestrator', () => {
    let cachePath: string;
    beforeEach(() => { cachePath = join(tmpdir(), `pharos-orch-${Date.now()}-${Math.random()}.json`); });
    afterEach(async () => { try { await fs.unlink(cachePath); } catch { /* ignore */ } });

    it('merges results from all enabled sources', async () => {
        const result = await runSync({
            cachePath,
            sources: {
                huggingface: async () => [sample('a/b', 'hf-x', 'huggingface')],
                vercel: async () => [sample('c/d', 'vercel_gateway', 'vercel')],
                direct: async () => [sample('e/f', 'openai', 'direct')],
            },
        });
        expect(result.entries).toHaveLength(3);
        expect(result.perSource.huggingface).toBe(1);
        expect(result.perSource.vercel).toBe(1);
        expect(result.perSource.direct).toBe(1);
    });

    it('writes merged entries to cache file', async () => {
        await runSync({
            cachePath,
            sources: {
                huggingface: async () => [sample('a/b', 'hf-x', 'huggingface')],
                vercel: async () => [],
                direct: async () => [],
            },
        });
        const raw = await fs.readFile(cachePath, 'utf8');
        expect(raw).toContain('a/b');
    });

    it('falls back to cache when all sources return empty', async () => {
        // Seed cache with one entry
        const seed = [sample('z/y', 'hf-z', 'huggingface')];
        await fs.writeFile(cachePath, JSON.stringify({ version: 1, writtenAt: Date.now(), entries: seed }), 'utf8');

        const result = await runSync({
            cachePath,
            sources: {
                huggingface: async () => [],
                vercel: async () => [],
                direct: async () => [],
            },
        });
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].canonicalId).toBe('z/y');
        expect(result.usedCacheFallback).toBe(true);
    });

    it('returns empty when all sources empty and no cache', async () => {
        const result = await runSync({
            cachePath,
            sources: {
                huggingface: async () => [],
                vercel: async () => [],
                direct: async () => [],
            },
        });
        expect(result.entries).toEqual([]);
        expect(result.usedCacheFallback).toBe(false);
    });

    it('continues if one source throws', async () => {
        const result = await runSync({
            cachePath,
            sources: {
                huggingface: async () => { throw new Error('boom'); },
                vercel: async () => [sample('c/d', 'vercel_gateway', 'vercel')],
                direct: async () => [],
            },
        });
        expect(result.entries).toHaveLength(1);
        expect(result.errors.huggingface).toBeDefined();
    });
});
