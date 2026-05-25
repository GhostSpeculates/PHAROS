/**
 * Runtime cache of synced models.
 *
 * Keyed by (canonicalId, provider, source, id). The `id` is included
 * because Hugging Face Inference Providers exposes the same canonical
 * model via multiple sub-providers under a single provider name —
 * sub-provider is encoded in the id (e.g. `meta-llama/Llama-3.3-70B-Instruct:together`)
 * so entries would collide without it.
 */

export type SyncSource = 'direct' | 'huggingface' | 'vercel';

export interface DynamicEntry {
    canonicalId: string;
    id: string;            // provider-specific id used to call the provider
    provider: string;      // provider name as configured (e.g. "groq", "huggingface")
    source: SyncSource;
    displayName: string;
    contextWindow: number;
    pricing: { inputPerMillion: number; outputPerMillion: number };
    syncedAt: number;      // epoch ms
}

function keyOf(e: { canonicalId: string; provider: string; source: SyncSource; id: string }): string {
    return `${e.canonicalId}::${e.provider}::${e.source}::${e.id}`;
}

export class DynamicRegistry {
    private byKey = new Map<string, DynamicEntry>();

    upsert(entry: DynamicEntry): void {
        this.byKey.set(keyOf(entry), entry);
    }

    replaceAll(entries: DynamicEntry[]): void {
        this.byKey.clear();
        for (const e of entries) this.upsert(e);
    }

    getByCanonical(canonicalId: string): DynamicEntry[] {
        const out: DynamicEntry[] = [];
        for (const e of this.byKey.values()) {
            if (e.canonicalId === canonicalId) out.push(e);
        }
        return out;
    }

    listAll(): DynamicEntry[] {
        return Array.from(this.byKey.values());
    }

    size(): number {
        return this.byKey.size;
    }
}
