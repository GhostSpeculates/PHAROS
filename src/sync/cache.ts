/**
 * Atomic catalog cache — persists last-known-good entries to disk.
 *
 * writeCache uses tmp+rename so a crashed write never corrupts the cache.
 * readCache returns null for missing or corrupt files; caller falls through
 * to static seed.
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { DynamicEntry } from '../registry/dynamic.js';

const CACHE_VERSION = 1;

interface CacheShape {
    version: number;
    writtenAt: number;
    entries: DynamicEntry[];
}

export async function writeCache(path: string, entries: DynamicEntry[]): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true });
    const payload: CacheShape = { version: CACHE_VERSION, writtenAt: Date.now(), entries };
    const tmp = `${path}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(payload), 'utf8');
    await fs.rename(tmp, path);
}

export async function readCache(path: string): Promise<DynamicEntry[] | null> {
    let raw: string;
    try {
        raw = await fs.readFile(path, 'utf8');
    } catch {
        return null;
    }
    try {
        const parsed = JSON.parse(raw) as CacheShape;
        if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) return null;
        return parsed.entries;
    } catch {
        return null;
    }
}
