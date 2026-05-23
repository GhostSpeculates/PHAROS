/**
 * Model Registry — metadata catalog for known models.
 *
 * As of Slice A (universal catalog), this file is intentionally minimal.
 * The 56-entry hand-coded array has been replaced by:
 *   - src/registry/static.ts  (emergency seed, ~6 entries)
 *   - src/registry/dynamic.ts (runtime sync cache)
 *   - src/registry/index.ts   (merged view via getMergedRegistry())
 *
 * MODEL_REGISTRY remains exported as a derived view of static seed
 * so legacy consumers (registry helpers) continue working unchanged.
 */

import { STATIC_SEED } from './static.js';

export type ModelCapability =
    | 'code' | 'math' | 'reasoning' | 'creative' | 'conversation'
    | 'multilingual' | 'embedding' | 'tts' | 'stt' | 'image' | 'video';

export type SpeedTier = 'fast' | 'medium' | 'slow';

export interface ModelPricing {
    inputPerMillion: number;
    outputPerMillion: number;
}

export interface ModelRegistryEntry {
    id: string;
    provider: string;
    displayName: string;
    contextWindow: number;
    capabilities: ModelCapability[];
    pricing: ModelPricing;
    speed: SpeedTier;
}

export const MODEL_REGISTRY: ModelRegistryEntry[] = STATIC_SEED.map(s => ({
    id: s.id,
    provider: s.provider,
    displayName: s.displayName,
    contextWindow: s.contextWindow,
    capabilities: ['conversation'],
    pricing: s.pricing,
    speed: 'medium',
}));

/**
 * Get all models in the registry.
 */
export function getAllModels(): ModelRegistryEntry[] {
    return MODEL_REGISTRY;
}

/**
 * Find a model by provider and ID.
 */
export function findModel(provider: string, id: string): ModelRegistryEntry | undefined {
    return MODEL_REGISTRY.find((m) => m.provider === provider && m.id === id);
}

/**
 * Find all models for a given provider.
 */
export function findModelsByProvider(provider: string): ModelRegistryEntry[] {
    return MODEL_REGISTRY.filter((m) => m.provider === provider);
}

/**
 * Find all models with a specific capability.
 */
export function findModelsByCapability(capability: ModelCapability): ModelRegistryEntry[] {
    return MODEL_REGISTRY.filter((m) => m.capabilities.includes(capability));
}
