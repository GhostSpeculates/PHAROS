import type { DynamicEntry } from '../../registry/dynamic.js';
import { toCanonicalId } from '../../registry/canonical.js';

export interface HFFetchOptions {
    endpoint: string;
    apiKey: string;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
}

interface HFProviderEntry {
    provider: string;
    status: string;
    pricing?: { input: number; output: number };
    context_length?: number;
}

interface HFModel {
    id: string;
    providers?: HFProviderEntry[];
}

interface HFResponse {
    data: HFModel[];
}

export async function fetchHuggingFaceModels(opts: HFFetchOptions): Promise<DynamicEntry[]> {
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

    let body: HFResponse;
    try { body = (await res.json()) as HFResponse; } catch { return []; }
    if (!Array.isArray(body.data)) return [];

    const now = Date.now();
    const out: DynamicEntry[] = [];

    for (const m of body.data) {
        const canonical = toCanonicalId(m.id);
        const providers = m.providers ?? [];
        for (const p of providers) {
            if (p.status !== 'live') continue;
            if (!p.pricing) continue;
            // HF Inference Providers routes via a single provider entry.
            // Sub-provider goes into the id using HF's documented `model:provider` syntax.
            out.push({
                canonicalId: canonical,
                id: `${m.id}:${p.provider}`,
                provider: 'huggingface',
                source: 'huggingface',
                displayName: `${m.id} (via ${p.provider})`,
                contextWindow: p.context_length ?? 0,
                pricing: { inputPerMillion: p.pricing.input, outputPerMillion: p.pricing.output },
                syncedAt: now,
            });
        }
    }

    return out;
}
