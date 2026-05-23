import { getMergedRegistry } from './index.js';
import type { SyncSource } from './dynamic.js';

export interface ResolvedPath {
    provider: string;
    id: string;
    source: SyncSource | 'static';
    pricing: { inputPerMillion: number; outputPerMillion: number };
}

export function resolvePaths(
    canonicalId: string,
    preference: ('direct' | 'huggingface' | 'vercel')[],
): ResolvedPath[] {
    const all = getMergedRegistry().filter(e => e.canonicalId === canonicalId);
    if (all.length === 0) return [];

    const rank: Record<string, number> = {};
    preference.forEach((p, i) => { rank[p] = i; });
    // static always last unless explicitly listed
    if (!('static' in rank)) rank.static = preference.length;

    const sorted = all.slice().sort((a, b) => {
        const ra = rank[a.source] ?? Number.MAX_SAFE_INTEGER;
        const rb = rank[b.source] ?? Number.MAX_SAFE_INTEGER;
        if (ra !== rb) return ra - rb;
        // tiebreak by cheaper input
        return a.pricing.inputPerMillion - b.pricing.inputPerMillion;
    });

    return sorted.map(e => ({
        provider: e.provider,
        id: e.id,
        source: e.source,
        pricing: e.pricing,
    }));
}
