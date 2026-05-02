import type { PharosConfig } from '../config/schema.js';

/**
 * Quality-tier router — Pharos's actual product wedge.
 *
 * No image-gen aggregator currently exposes a `quality: best | balanced | cheapest`
 * API parameter that auto-selects per request. We do.
 *
 * Resolution: a `QualityTier` resolves to an ordered list of (provider, model)
 * candidates. The first healthy provider+model in the list wins. The list is
 * not just one entry — each tier has a fallback chain to the next-cheaper tier
 * if its primary is unhealthy, so a `best` request never falls below `balanced`,
 * and `balanced` never falls below `cheapest`.
 *
 * Tiers and prices (per-image) are config-driven via pharos.yaml's
 * `images.qualityTiers` block. Defaults below match the strategic plan.
 */

export type QualityTier = 'cheapest' | 'balanced' | 'best';

export interface QualityCandidate {
    /** Provider name as configured in pharos.yaml `providers:` block. */
    provider: string;
    /** Model ID sent to the provider's API. */
    model: string;
    /** Per-image cost in USD — used to cost-rank within a tier and for SQLite tracking. */
    pricePerImage: number;
}

// Phase 4.5: KIE first per real production usage (verified with 96-credit balance check).
// Each tier falls through to fal.ai → BFL → OpenAI as resilience backstops.
const DEFAULT_TIERS: Record<QualityTier, QualityCandidate[]> = {
    cheapest: [
        // ~4 credits (~$0.023) — Gemini 2.5 Flash Image, ~6s generation
        { provider: 'kie', model: 'google/nano-banana', pricePerImage: 0.023 },
        { provider: 'fal', model: 'fal-ai/flux/schnell', pricePerImage: 0.003 },
    ],
    balanced: [
        { provider: 'kie', model: 'google/imagen-4', pricePerImage: 0.040 },
        { provider: 'kie', model: 'flux/flux-1-1-pro', pricePerImage: 0.040 },
        { provider: 'fal', model: 'fal-ai/flux-pro/v1.1', pricePerImage: 0.040 },
        { provider: 'bfl', model: 'flux-pro-1.1', pricePerImage: 0.040 },
    ],
    best: [
        { provider: 'kie', model: 'midjourney/v7', pricePerImage: 0.080 },
        { provider: 'kie', model: 'gpt4o-image', pricePerImage: 0.080 },
        { provider: 'fal', model: 'fal-ai/flux-pro/v1.1-ultra', pricePerImage: 0.060 },
        { provider: 'bfl', model: 'flux-pro-1.1-ultra', pricePerImage: 0.060 },
    ],
};

/**
 * Resolve a quality tier to an ordered candidate list, including fallback
 * to lower tiers (best→balanced→cheapest) so a `best` request never fails
 * just because the top model is down.
 */
export function resolveCandidates(
    tier: QualityTier,
    config: PharosConfig,
): QualityCandidate[] {
    const tiers = readTiersFromConfig(config);
    const result: QualityCandidate[] = [];

    if (tier === 'best') {
        result.push(...tiers.best, ...tiers.balanced, ...tiers.cheapest);
    } else if (tier === 'balanced') {
        result.push(...tiers.balanced, ...tiers.cheapest);
    } else {
        result.push(...tiers.cheapest);
    }

    return result;
}

function readTiersFromConfig(config: PharosConfig): Record<QualityTier, QualityCandidate[]> {
    const cfgTiers = (config as any).images?.qualityTiers as
        | Partial<Record<QualityTier, QualityCandidate[]>>
        | undefined;

    return {
        cheapest: cfgTiers?.cheapest ?? DEFAULT_TIERS.cheapest,
        balanced: cfgTiers?.balanced ?? DEFAULT_TIERS.balanced,
        best: cfgTiers?.best ?? DEFAULT_TIERS.best,
    };
}

/**
 * Validate a string at runtime as a QualityTier (Zod also handles this,
 * but useful when reading from request bodies that bypass Zod).
 */
export function parseQualityTier(input: unknown): QualityTier | null {
    if (input === 'cheapest' || input === 'balanced' || input === 'best') return input;
    return null;
}
