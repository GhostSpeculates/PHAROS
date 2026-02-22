import type { PharosConfig, TierName } from '../config/schema.js';
import type { ClassificationResult } from '../classifier/types.js';
import type { ProviderRegistry } from '../providers/index.js';
import type { Logger } from '../utils/logger.js';
import { resolveTier } from './tier-resolver.js';
import { findAvailableModel, type FailoverResult } from './failover.js';

export interface RoutingDecision {
    /** Which provider to use */
    provider: string;
    /** Which model to use */
    model: string;
    /** Which tier this falls into */
    tier: TierName;
    /** The classification that drove this decision */
    classification: ClassificationResult;
    /** Whether failover was needed */
    failoverAttempts: number;
    /** Whether classification was bypassed (direct model request) */
    isDirectRoute: boolean;
}

/**
 * Model Router — the decision engine.
 *
 * Takes a classification result and determines exactly which provider
 * and model should handle this request.
 */
export class ModelRouter {
    private config: PharosConfig;
    private registry: ProviderRegistry;
    private logger: Logger;

    constructor(config: PharosConfig, registry: ProviderRegistry, logger: Logger) {
        this.config = config;
        this.registry = registry;
        this.logger = logger;
    }

    /**
     * Route based on classification result.
     */
    route(classification: ClassificationResult): RoutingDecision {
        const tier = resolveTier(classification.score, this.config);

        this.logger.debug(
            {
                score: classification.score,
                type: classification.type,
                tier,
            },
            'Routing decision',
        );

        const result = findAvailableModel(tier, this.config, this.registry, this.logger);

        return {
            provider: result.provider,
            model: result.model,
            tier: result.tier,
            classification,
            failoverAttempts: result.attempts - 1,
            isDirectRoute: false,
        };
    }

    /**
     * Route directly to a specific model (bypasses classification).
     * Used when the client sends a specific model name instead of "pharos-auto".
     */
    routeDirect(
        providerName: string,
        modelName: string,
        classification: ClassificationResult,
    ): RoutingDecision {
        if (!this.registry.isAvailable(providerName)) {
            throw new Error(`Provider "${providerName}" is not available`);
        }

        // Determine which tier this model belongs to
        let tier: TierName = 'premium'; // default
        for (const [tierName, tierConfig] of Object.entries(this.config.tiers)) {
            if (tierConfig.models.some((m) => m.provider === providerName && m.model === modelName)) {
                tier = tierName as TierName;
                break;
            }
        }

        return {
            provider: providerName,
            model: modelName,
            tier,
            classification,
            failoverAttempts: 0,
            isDirectRoute: true,
        };
    }

    /**
     * Resolve a model name from the request to a provider + model pair.
     * Returns null if it's "pharos-auto" (needs classification).
     */
    resolveDirectModel(
        requestModel: string,
    ): { provider: string; model: string } | null {
        // "pharos-auto" or empty means use the classifier
        if (!requestModel || requestModel === 'pharos-auto' || requestModel === 'auto') {
            return null;
        }

        // Check if this is a known model in any tier
        for (const tierConfig of Object.values(this.config.tiers)) {
            for (const modelEntry of tierConfig.models) {
                if (modelEntry.model === requestModel) {
                    return { provider: modelEntry.provider, model: modelEntry.model };
                }
            }
        }

        // Unknown model — return null, will use classifier
        this.logger.debug({ model: requestModel }, 'Unknown model requested, using classifier');
        return null;
    }
}
