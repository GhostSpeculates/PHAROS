import type { PharosConfig, TierName } from '../config/schema.js';
import type { ClassificationResult } from '../classifier/types.js';
import type { TaskType, TASK_TYPES } from '../classifier/types.js';
import { TASK_TYPES as VALID_TASK_TYPES } from '../classifier/types.js';
import type { ProviderRegistry } from '../providers/index.js';
import type { PerformanceLearningStore } from '../learning/performance-store.js';
import type { Logger } from '../utils/logger.js';
import { resolveTier } from './tier-resolver.js';
import { findAvailableModel, getCandidateModels, sortByPerformance, type FailoverResult, type ModelCandidate } from './failover.js';
import { sortByAffinity, DEFAULT_TASK_AFFINITY } from './affinity.js';

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
    private affinityMap: Record<string, string[]>;
    private learningStore: PerformanceLearningStore | null;

    constructor(
        config: PharosConfig,
        registry: ProviderRegistry,
        logger: Logger,
        learningStore?: PerformanceLearningStore | null,
    ) {
        this.config = config;
        this.registry = registry;
        this.logger = logger;
        this.learningStore = learningStore ?? null;

        // Merge config-provided affinity with defaults (config wins)
        this.affinityMap = { ...DEFAULT_TASK_AFFINITY, ...config.taskAffinity };
    }

    /**
     * Route based on classification result.
     * Uses task-type affinity to prefer the best model for the task.
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

        const result = findAvailableModel(
            tier, this.config, this.registry, this.logger,
            classification.type, this.affinityMap, this.learningStore,
        );

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
        let foundInTier = false;
        for (const [tierName, tierConfig] of Object.entries(this.config.tiers)) {
            if (tierConfig.models.some((m) => m.provider === providerName && m.model === modelName)) {
                tier = tierName as TierName;
                foundInTier = true;
                break;
            }
        }
        if (!foundInTier) {
            this.logger.warn(
                { provider: providerName, model: modelName, defaultTier: 'premium' },
                'Direct-routed model not found in any tier config — defaulting to premium',
            );
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
     * Get all candidate models in retry order for a classification.
     * Uses task-type affinity to prefer the best model for the task.
     */
    getCandidates(classification: ClassificationResult): ModelCandidate[] {
        const tier = resolveTier(classification.score, this.config);
        const candidates = getCandidateModels(tier, this.config, this.registry);
        const affinitySorted = sortByAffinity(candidates, classification.type, this.affinityMap);
        return sortByPerformance(affinitySorted, classification.type, this.learningStore);
    }

    /**
     * Resolve a model name from the request to a provider + model pair.
     * Returns null if it's "pharos-auto" or a virtual model (needs classification).
     */
    resolveDirectModel(
        requestModel: string,
    ): { provider: string; model: string } | null {
        // "pharos-auto", empty, or virtual model → use the classifier
        if (!requestModel || requestModel === 'pharos-auto' || requestModel === 'auto') {
            return null;
        }

        // Strip agent suffix for matching (e.g. "pharos-code:agent-name" → "pharos-code")
        const modelPart = requestModel.includes(':') ? requestModel.split(':')[0] : requestModel;

        // Virtual model names (pharos-code, pharos-math, etc.) use classifier
        if (this.resolveTaskTypeOverride(modelPart) !== null) {
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

    /**
     * Check if the model name is a virtual task-type model (e.g. "pharos-code").
     * Returns the forced task type, or null if it's not a virtual model.
     *
     * Supported: pharos-code, pharos-math, pharos-reasoning, pharos-creative,
     *            pharos-analysis, pharos-conversation
     * Also works with agent suffix: pharos-code:agent-name
     */
    resolveTaskTypeOverride(requestModel: string): TaskType | null {
        if (!requestModel) return null;

        // Strip agent suffix
        const modelPart = requestModel.includes(':') ? requestModel.split(':')[0] : requestModel;

        // Must start with "pharos-" and the remainder must be a valid task type
        if (!modelPart.startsWith('pharos-')) return null;

        const typePart = modelPart.slice('pharos-'.length);

        // "auto" is not a task type override
        if (typePart === 'auto') return null;

        if ((VALID_TASK_TYPES as readonly string[]).includes(typePart)) {
            return typePart as TaskType;
        }

        return null;
    }
}
