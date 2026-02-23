import type { TierName, PharosConfig } from '../config/schema.js';

/**
 * Resolve a complexity score to the correct routing tier.
 *
 * This is the simple but critical mapping:
 *   Score 1-3  → free
 *   Score 4-6  → economical
 *   Score 7-8  → premium
 *   Score 9-10 → frontier
 */
export function resolveTier(score: number, config: PharosConfig): TierName {
    // Clamp score to valid range
    const clamped = Math.max(1, Math.min(10, Math.round(score)));

    // Check each tier's score range
    for (const [tierName, tierConfig] of Object.entries(config.tiers)) {
        const [min, max] = tierConfig.scoreRange;
        if (clamped >= min && clamped <= max) {
            return tierName as TierName;
        }
    }

    // Fallback: if score goes out-of-range somehow
    if (clamped <= 3) return 'free';
    if (clamped <= 6) return 'economical';
    if (clamped <= 8) return 'premium';
    return 'frontier';
}

/**
 * Get the ordered list of tiers to try, starting from the given tier
 * and escalating upward. Used for failover.
 *
 * Example: if starting tier is 'economical', order is:
 *   economical → premium → frontier → free
 */
export function getTierFailoverOrder(startTier: TierName): TierName[] {
    const tierOrder: TierName[] = ['free', 'economical', 'premium', 'frontier'];
    const startIndex = tierOrder.indexOf(startTier);

    // Unknown tier — default to full order starting from 'premium'
    if (startIndex === -1) {
        return ['premium', 'frontier', 'economical', 'free'];
    }

    // Start from current tier, then try higher tiers, then lower tiers
    const result: TierName[] = [];

    // Current tier first
    result.push(tierOrder[startIndex]);

    // Then escalate upward
    for (let i = startIndex + 1; i < tierOrder.length; i++) {
        result.push(tierOrder[i]);
    }

    // Then try lower tiers as last resort
    for (let i = startIndex - 1; i >= 0; i--) {
        result.push(tierOrder[i]);
    }

    return result;
}
