import type { PharosConfig, TierName } from '../config/schema.js';
import { resolveTier } from './tier-resolver.js';

const TIER_ORDER: TierName[] = ['free', 'economical', 'premium', 'frontier'];

export interface AgentAdjustment {
  adjustedScore: number;
  rawScore: number;
  agentId: string | undefined;
  maxTier: TierName | undefined;
}

/**
 * Apply an agent profile to clamp the classification score.
 *
 * The profile can set:
 * - scoreFloor / scoreCeiling: hard score bounds
 * - minTier / maxTier: ensure resolved tier stays within bounds
 *   (bumps or caps the score to enforce tier constraints)
 *
 * Returns the adjusted score and metadata for logging.
 */
export function applyAgentProfile(
  rawScore: number,
  agentId: string | undefined,
  config: PharosConfig,
): AgentAdjustment {
  const noAdjustment: AgentAdjustment = {
    adjustedScore: rawScore,
    rawScore,
    agentId,
    maxTier: undefined,
  };

  if (!agentId || !config.agents) return noAdjustment;

  const profile = config.agents[agentId] ?? config.agents['_default'];
  if (!profile) return noAdjustment;

  let score = rawScore;

  // Apply score floor/ceiling
  if (profile.scoreFloor !== undefined) {
    score = Math.max(score, profile.scoreFloor);
  }
  if (profile.scoreCeiling !== undefined) {
    score = Math.min(score, profile.scoreCeiling);
  }

  // Enforce minTier: bump score to reach at least this tier
  if (profile.minTier !== undefined) {
    const currentTier = resolveTier(score, config);
    if (TIER_ORDER.indexOf(currentTier) < TIER_ORDER.indexOf(profile.minTier)) {
      // Bump score to the minimum of the target tier's scoreRange
      const targetRange = config.tiers[profile.minTier as TierName]?.scoreRange;
      if (targetRange) {
        score = Math.max(score, targetRange[0]);
      }
    }
  }

  // Enforce maxTier: cap score to stay at or below this tier
  if (profile.maxTier !== undefined) {
    const currentTier = resolveTier(score, config);
    if (TIER_ORDER.indexOf(currentTier) > TIER_ORDER.indexOf(profile.maxTier)) {
      // Cap score to the maximum of the allowed tier's scoreRange
      const targetRange = config.tiers[profile.maxTier as TierName]?.scoreRange;
      if (targetRange) {
        score = Math.min(score, targetRange[1]);
      }
    }
  }

  return {
    adjustedScore: score,
    rawScore,
    agentId,
    maxTier: profile.maxTier ?? undefined,
  };
}
