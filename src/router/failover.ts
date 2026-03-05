import type { PharosConfig, TierName, ModelEntry } from '../config/schema.js';
import type { ProviderRegistry } from '../providers/index.js';
import type { Logger } from '../utils/logger.js';
import { getTierFailoverOrder } from './tier-resolver.js';
import { sendAlert } from '../utils/alerts.js';
import { sortByAffinity } from './affinity.js';
import { getSpeedRank, getModelCost } from '../registry/index.js';

export interface FailoverResult {
    provider: string;
    model: string;
    tier: TierName;
    attempts: number;
    failedProviders: string[];
}

export interface ModelCandidate {
    provider: string;
    model: string;
    tier: TierName;
}

/**
 * Attempt to find an available model, trying failover options.
 *
 * Strategy:
 * 1. Try each model in the primary tier (in order)
 * 2. If all fail, escalate to the next tier up
 * 3. If all tiers exhausted, throw an error
 */
export function findAvailableModel(
    primaryTier: TierName,
    config: PharosConfig,
    registry: ProviderRegistry,
    logger: Logger,
    taskType?: string,
    affinityMap?: Record<string, string[]>,
): FailoverResult {
    // Build candidates with affinity sorting, then registry-aware sorting
    const candidates = getCandidateModels(primaryTier, config, registry);
    const affinitySorted = (taskType && affinityMap)
        ? sortByAffinity(candidates, taskType, affinityMap)
        : candidates;
    const sorted = sortByRegistry(affinitySorted, primaryTier);

    // Try each candidate in order
    if (sorted.length > 0) {
        const first = sorted[0];
        // Count attempts for backward compat
        const attempts = candidates.indexOf(first) + 1;
        const failedProviders = candidates
            .slice(0, candidates.indexOf(first))
            .map(c => `${c.provider}/${c.model}`);

        if (first.tier !== primaryTier) {
            logger.info(
                { from: primaryTier, to: first.tier, model: first.model },
                'Failover: escalated to different tier',
            );
        }

        return {
            provider: first.provider,
            model: first.model,
            tier: first.tier,
            attempts: failedProviders.length + 1,
            failedProviders,
        };
    }

    // Fall through — no candidates at all
    const tierOrder = getTierFailoverOrder(primaryTier);
    const failedProviders: string[] = [];
    let attempts = 0;

    for (const tierName of tierOrder) {
        const tier = config.tiers[tierName];
        if (!tier) continue;

        for (const modelEntry of tier.models) {
            attempts++;
            failedProviders.push(`${modelEntry.provider}/${modelEntry.model}`);
        }
    }

    sendAlert(
        'All Providers Unavailable',
        `No available providers across all tiers.\nTried ${attempts} models: ${failedProviders.join(', ')}`,
        'critical',
        'all_providers_unavailable',
    );

    throw new Error(
        `No available providers found after trying ${attempts} models across all tiers. ` +
        `Failed: ${failedProviders.join(', ')}`,
    );
}

/**
 * Get all candidate models in failover order for runtime retry.
 *
 * Unlike findAvailableModel which returns the first healthy model,
 * this returns ALL healthy models so the gateway can retry on execution failure.
 */
export function getCandidateModels(
    primaryTier: TierName,
    config: PharosConfig,
    registry: ProviderRegistry,
): ModelCandidate[] {
    const tierOrder = getTierFailoverOrder(primaryTier);
    const candidates: ModelCandidate[] = [];

    for (const tierName of tierOrder) {
        const tier = config.tiers[tierName];
        if (!tier) continue;
        for (const modelEntry of tier.models) {
            if (registry.isAvailable(modelEntry.provider)) {
                candidates.push({
                    provider: modelEntry.provider,
                    model: modelEntry.model,
                    tier: tierName,
                });
            }
        }
    }

    return candidates;
}

/** Tiers where speed preference applies (cheap tiers benefit from fast models) */
const SPEED_PREFERENCE_TIERS: Set<string> = new Set(['free', 'economical']);

/**
 * Registry-aware secondary sort within each tier group.
 *
 * After affinity sorting, this applies:
 * 1. Speed preference: for free/economical tiers, prefer fast > medium > slow
 * 2. Price preference: for same-speed candidates, prefer cheaper providers
 *
 * This is a stable sort — candidates with the same speed+cost keep their
 * affinity-determined order.
 */
export function sortByRegistry(
    candidates: ModelCandidate[],
    primaryTier: TierName,
): ModelCandidate[] {
    if (candidates.length <= 1) return candidates;

    // Group by tier to preserve tier ordering
    const tierGroups = new Map<string, ModelCandidate[]>();
    const tierOrder: string[] = [];

    for (const c of candidates) {
        if (!tierGroups.has(c.tier)) {
            tierGroups.set(c.tier, []);
            tierOrder.push(c.tier);
        }
        tierGroups.get(c.tier)!.push(c);
    }

    const result: ModelCandidate[] = [];
    for (const tier of tierOrder) {
        const group = tierGroups.get(tier)!;

        // Only apply speed/price sorting for cheap tiers
        if (SPEED_PREFERENCE_TIERS.has(tier)) {
            // Stable sort: speed first, then cost
            const sorted = [...group].sort((a, b) => {
                const speedA = getSpeedRank(a.provider, a.model);
                const speedB = getSpeedRank(b.provider, b.model);
                if (speedA !== speedB) return speedA - speedB;

                // Same speed — prefer cheaper
                const costA = getModelCost(a.provider, a.model) ?? Infinity;
                const costB = getModelCost(b.provider, b.model) ?? Infinity;
                return costA - costB;
            });
            result.push(...sorted);
        } else {
            result.push(...group);
        }
    }

    return result;
}
