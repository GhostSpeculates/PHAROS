import type { PharosConfig, TierName, ModelEntry } from '../config/schema.js';
import type { ProviderRegistry } from '../providers/index.js';
import type { Logger } from '../utils/logger.js';
import { getTierFailoverOrder } from './tier-resolver.js';
import { sendAlert } from '../utils/alerts.js';
import { sortByAffinity } from './affinity.js';

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
    // Build candidates with affinity sorting
    const candidates = getCandidateModels(primaryTier, config, registry);
    const sorted = (taskType && affinityMap)
        ? sortByAffinity(candidates, taskType, affinityMap)
        : candidates;

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
