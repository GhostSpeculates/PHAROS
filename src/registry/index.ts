/**
 * Registry helpers — query model metadata for routing decisions.
 *
 * Backed by:
 *   - static seed (always present)
 *   - dynamic registry (populated by sync; may be empty before first sync)
 */

import { MODEL_REGISTRY, type SpeedTier, type ModelRegistryEntry } from './models.js';
import { STATIC_SEED } from './static.js';
import { DynamicRegistry } from './dynamic.js';

let dynamicRegistry = new DynamicRegistry();

/** For tests only — overwrite the live dynamic registry. */
export function setDynamicRegistryForTesting(reg: DynamicRegistry): void {
    dynamicRegistry = reg;
}

/** Production swap of the dynamic registry (after a successful sync). */
export function setDynamicRegistry(reg: DynamicRegistry): void {
    dynamicRegistry = reg;
}

export interface MergedEntry {
    canonicalId: string;
    id: string;
    provider: string;
    displayName: string;
    contextWindow: number;
    pricing: { inputPerMillion: number; outputPerMillion: number };
    source: 'static' | 'direct' | 'huggingface' | 'vercel';
}

export function getMergedRegistry(): MergedEntry[] {
    const out = new Map<string, MergedEntry>();

    // Static first
    for (const s of STATIC_SEED) {
        const key = `${s.canonicalId}::${s.provider}`;
        out.set(key, {
            canonicalId: s.canonicalId,
            id: s.id,
            provider: s.provider,
            displayName: s.displayName,
            contextWindow: s.contextWindow,
            pricing: s.pricing,
            source: 'static',
        });
    }

    // Dynamic shadows static for same (canonicalId, provider)
    for (const d of dynamicRegistry.listAll()) {
        const key = `${d.canonicalId}::${d.provider}`;
        out.set(key, {
            canonicalId: d.canonicalId,
            id: d.id,
            provider: d.provider,
            displayName: d.displayName,
            contextWindow: d.contextWindow,
            pricing: d.pricing,
            source: d.source,
        });
    }

    return Array.from(out.values());
}

// ─── Existing helpers preserved (now read from merged registry) ───

const SPEED_ORDER: Record<SpeedTier, number> = { fast: 0, medium: 1, slow: 2 };

export function getModelSpeed(provider: string, model: string): SpeedTier | undefined {
    const entry = MODEL_REGISTRY.find(m => m.provider === provider && m.id === model);
    return entry?.speed;
}

export function getModelCost(provider: string, model: string): number | undefined {
    // Try merged registry first (real prices)
    const merged = getMergedRegistry().find(m => m.provider === provider && m.id === model);
    if (merged) return merged.pricing.inputPerMillion + merged.pricing.outputPerMillion;
    // Fallback to legacy static MODEL_REGISTRY
    const entry = MODEL_REGISTRY.find(m => m.provider === provider && m.id === model);
    if (!entry) return undefined;
    return entry.pricing.inputPerMillion + entry.pricing.outputPerMillion;
}

export function getSpeedRank(provider: string, model: string): number {
    const speed = getModelSpeed(provider, model);
    return speed ? SPEED_ORDER[speed] : 1;
}

export function getRegistryEntry(provider: string, model: string): ModelRegistryEntry | undefined {
    return MODEL_REGISTRY.find(m => m.provider === provider && m.id === model);
}
