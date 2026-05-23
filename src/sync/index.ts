import { readCache, writeCache } from './cache.js';
import type { DynamicEntry } from '../registry/dynamic.js';

export type SourceFn = () => Promise<DynamicEntry[]>;

export interface RunSyncOptions {
    cachePath: string;
    sources: {
        huggingface: SourceFn;
        vercel: SourceFn;
        direct: SourceFn;
    };
}

export interface SyncResult {
    entries: DynamicEntry[];
    perSource: { huggingface: number; vercel: number; direct: number };
    errors: { huggingface?: string; vercel?: string; direct?: string };
    usedCacheFallback: boolean;
}

async function safe(fn: SourceFn): Promise<{ entries: DynamicEntry[]; error?: string }> {
    try {
        const e = await fn();
        return { entries: e };
    } catch (err) {
        return { entries: [], error: err instanceof Error ? err.message : String(err) };
    }
}

export async function runSync(opts: RunSyncOptions): Promise<SyncResult> {
    const [hf, vercel, direct] = await Promise.all([
        safe(opts.sources.huggingface),
        safe(opts.sources.vercel),
        safe(opts.sources.direct),
    ]);

    const merged = [...hf.entries, ...vercel.entries, ...direct.entries];

    const errors: SyncResult['errors'] = {};
    if (hf.error) errors.huggingface = hf.error;
    if (vercel.error) errors.vercel = vercel.error;
    if (direct.error) errors.direct = direct.error;

    if (merged.length > 0) {
        await writeCache(opts.cachePath, merged);
        return {
            entries: merged,
            perSource: { huggingface: hf.entries.length, vercel: vercel.entries.length, direct: direct.entries.length },
            errors,
            usedCacheFallback: false,
        };
    }

    // All sources returned empty — try cache fallback
    const cached = await readCache(opts.cachePath);
    if (cached && cached.length > 0) {
        return {
            entries: cached,
            perSource: { huggingface: 0, vercel: 0, direct: 0 },
            errors,
            usedCacheFallback: true,
        };
    }

    return {
        entries: [],
        perSource: { huggingface: 0, vercel: 0, direct: 0 },
        errors,
        usedCacheFallback: false,
    };
}
