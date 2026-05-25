import type { DynamicEntry } from '../../registry/dynamic.js';
import { toCanonicalId } from '../../registry/canonical.js';

export interface DirectProviderConfig {
    name: string;
    endpoint: string;
    apiKey: string;
    /** Pricing must be supplied by Pharos (most direct /models endpoints don't include prices). */
    staticPricing: Record<string, { inputPerMillion: number; outputPerMillion: number }>;
}

export interface DirectFetchOptions {
    providers: DirectProviderConfig[];
    fetchFn?: typeof fetch;
    timeoutMs?: number;
}

interface OpenAICompatModel { id: string; object?: string }
interface OpenAICompatResponse { data: OpenAICompatModel[] }

export async function fetchDirectProviderModels(opts: DirectFetchOptions): Promise<DynamicEntry[]> {
    const fetchFn = opts.fetchFn ?? fetch;
    const timeoutMs = opts.timeoutMs ?? 5_000;

    const results = await Promise.all(opts.providers.map(p => fetchOne(p, fetchFn, timeoutMs)));
    return results.flat();
}

async function fetchOne(
    p: DirectProviderConfig,
    fetchFn: typeof fetch,
    timeoutMs: number,
): Promise<DynamicEntry[]> {
    if (!p.apiKey) return [];

    const controller = new AbortController();
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timerId = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    });

    let res: Response;
    try {
        res = await Promise.race([
            fetchFn(p.endpoint, {
                headers: { Authorization: `Bearer ${p.apiKey}` },
                signal: controller.signal,
            }),
            timeout,
        ]);
    } catch {
        controller.abort();
        if (timerId) clearTimeout(timerId);
        return [];
    } finally {
        if (timerId) clearTimeout(timerId);
    }

    if (!res.ok) return [];

    let body: OpenAICompatResponse;
    try { body = (await res.json()) as OpenAICompatResponse; } catch { return []; }
    if (!Array.isArray(body.data)) return [];

    const now = Date.now();
    const out: DynamicEntry[] = [];
    for (const m of body.data) {
        const pricing = p.staticPricing[m.id];
        if (!pricing) continue; // skip models we don't have a price for
        out.push({
            canonicalId: toCanonicalId(m.id, p.name),
            id: m.id,
            provider: p.name,
            source: 'direct',
            displayName: m.id,
            contextWindow: 0,
            pricing,
            syncedAt: now,
        });
    }
    return out;
}
