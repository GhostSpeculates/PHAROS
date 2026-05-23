import type { DynamicEntry } from '../../registry/dynamic.js';
import { toCanonicalId } from '../../registry/canonical.js';

export interface VercelFetchOptions {
    endpoint: string;
    apiKey: string;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
}

interface VercelModel {
    id: string;
    pricing?: { input: number; output: number };
    context_window?: number;
}

interface VercelResponse {
    data: VercelModel[];
}

export async function fetchVercelGatewayModels(opts: VercelFetchOptions): Promise<DynamicEntry[]> {
    const fetchFn = opts.fetchFn ?? fetch;
    const timeoutMs = opts.timeoutMs ?? 5_000;

    const controller = new AbortController();
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timerId = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    });

    let res: Response;
    try {
        res = await Promise.race([
            fetchFn(opts.endpoint, {
                headers: { Authorization: `Bearer ${opts.apiKey}` },
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

    let body: VercelResponse;
    try { body = (await res.json()) as VercelResponse; } catch { return []; }
    if (!Array.isArray(body.data)) return [];

    const now = Date.now();
    const out: DynamicEntry[] = [];

    for (const m of body.data) {
        if (!m.pricing) continue;
        out.push({
            canonicalId: toCanonicalId(m.id),
            id: m.id,
            provider: 'vercel-gateway',
            source: 'vercel',
            displayName: m.id,
            contextWindow: m.context_window ?? 0,
            pricing: { inputPerMillion: m.pricing.input, outputPerMillion: m.pricing.output },
            syncedAt: now,
        });
    }

    return out;
}
