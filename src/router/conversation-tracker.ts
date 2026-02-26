import type { TierName } from '../config/schema.js';
import { LRUCache, type LRUCacheOptions } from '../utils/lru-cache.js';

/** Numeric rank for each tier (higher = more powerful). */
export const TIER_RANK: Record<TierName, number> = {
    free: 0,
    economical: 1,
    premium: 2,
    frontier: 3,
};

/** Reverse lookup: rank number → tier name. */
export const RANK_TO_TIER: TierName[] = ['free', 'economical', 'premium', 'frontier'];

interface ConversationInfo {
    highestTier: TierName;
    requestCount: number;
}

/**
 * Tracks the highest tier used in each conversation so that
 * follow-up messages aren't accidentally routed to a lower tier.
 *
 * Uses the existing LRUCache for bounded memory + TTL expiry.
 */
export class ConversationTracker {
    private cache: LRUCache<ConversationInfo>;

    constructor(options: LRUCacheOptions) {
        this.cache = new LRUCache<ConversationInfo>(options);
    }

    /**
     * Record that a conversation used a given tier.
     * Updates the highest tier if the new tier is higher, and increments the request count.
     */
    recordTier(conversationId: string, tier: TierName): void {
        const existing = this.cache.get(conversationId);

        if (!existing) {
            this.cache.set(conversationId, { highestTier: tier, requestCount: 1 });
            return;
        }

        const newRank = TIER_RANK[tier];
        const existingRank = TIER_RANK[existing.highestTier];

        this.cache.set(conversationId, {
            highestTier: newRank > existingRank ? tier : existing.highestTier,
            requestCount: existing.requestCount + 1,
        });
    }

    /**
     * Get the tier floor for a conversation.
     * Returns one tier below the highest tier seen (min: free), or null if unknown.
     */
    getTierFloor(conversationId: string): TierName | null {
        const info = this.cache.get(conversationId);
        if (!info) return null;

        const rank = TIER_RANK[info.highestTier];
        const floorRank = Math.max(0, rank - 1);
        return RANK_TO_TIER[floorRank];
    }

    /**
     * Get full info about a conversation's routing history.
     */
    getInfo(conversationId: string): { highestTier: TierName; tierFloor: TierName; requestCount: number } | null {
        const info = this.cache.get(conversationId);
        if (!info) return null;

        const rank = TIER_RANK[info.highestTier];
        const floorRank = Math.max(0, rank - 1);

        return {
            highestTier: info.highestTier,
            tierFloor: RANK_TO_TIER[floorRank],
            requestCount: info.requestCount,
        };
    }
}

/**
 * Pure function: returns the higher of two tiers.
 * Used to apply the conversation tier floor to the classifier's tier.
 */
export function applyTierFloor(classifierTier: TierName, floorTier: TierName): TierName {
    const classifierRank = TIER_RANK[classifierTier];
    const floorRank = TIER_RANK[floorTier];
    return classifierRank >= floorRank ? classifierTier : floorTier;
}
