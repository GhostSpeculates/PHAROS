/**
 * Registry helpers — query model metadata for routing decisions.
 *
 * Provides speed tier and cost lookups so the router can prefer
 * faster providers for simple queries and cheaper ones when
 * multiple host the same-capability model.
 */

import { MODEL_REGISTRY, type SpeedTier, type ModelRegistryEntry } from './models.js';

/** Speed tier numeric values for sorting (lower = faster) */
const SPEED_ORDER: Record<SpeedTier, number> = {
    fast: 0,
    medium: 1,
    slow: 2,
};

/**
 * Get the speed tier for a provider/model pair.
 */
export function getModelSpeed(provider: string, model: string): SpeedTier | undefined {
    const entry = MODEL_REGISTRY.find(m => m.provider === provider && m.id === model);
    return entry?.speed;
}

/**
 * Get the total cost per million tokens (input + output average) for sorting.
 * Returns undefined if the model is not in the registry.
 */
export function getModelCost(provider: string, model: string): number | undefined {
    const entry = MODEL_REGISTRY.find(m => m.provider === provider && m.id === model);
    if (!entry) return undefined;
    return entry.pricing.inputPerMillion + entry.pricing.outputPerMillion;
}

/**
 * Get the numeric speed rank for sorting (0=fast, 1=medium, 2=slow).
 * Unknown models get medium (1) as default.
 */
export function getSpeedRank(provider: string, model: string): number {
    const speed = getModelSpeed(provider, model);
    return speed ? SPEED_ORDER[speed] : 1; // default to medium
}

/**
 * Get the full registry entry for a provider/model pair.
 */
export function getRegistryEntry(provider: string, model: string): ModelRegistryEntry | undefined {
    return MODEL_REGISTRY.find(m => m.provider === provider && m.id === model);
}
