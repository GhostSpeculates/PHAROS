import type { PharosConfig, TierName, ModelEntry } from '../config/schema.js';
import type { ProviderRegistry } from '../providers/index.js';
import type { Logger } from '../utils/logger.js';
import { getTierFailoverOrder } from './tier-resolver.js';

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
): FailoverResult {
    const tierOrder = getTierFailoverOrder(primaryTier);
    const failedProviders: string[] = [];
    let attempts = 0;

    for (const tierName of tierOrder) {
        const tier = config.tiers[tierName];
        if (!tier) continue;

        for (const modelEntry of tier.models) {
            attempts++;

            if (registry.isAvailable(modelEntry.provider)) {
                if (tierName !== primaryTier) {
                    logger.info(
                        { from: primaryTier, to: tierName, model: modelEntry.model },
                        'Failover: escalated to different tier',
                    );
                }

                return {
                    provider: modelEntry.provider,
                    model: modelEntry.model,
                    tier: tierName,
                    attempts,
                    failedProviders,
                };
            } else {
                failedProviders.push(`${modelEntry.provider}/${modelEntry.model}`);
            }
        }
    }

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
