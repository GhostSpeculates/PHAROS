import type { MergedEntry } from '../registry/index.js';
import type { TierPriceBoundaries, ModelEntry } from '../config/schema.js';

export interface PopulatedTier {
    scoreRange: [number, number];
    models: ModelEntry[];
}

export type PopulatedTiers = Record<'free' | 'economical' | 'premium' | 'frontier', PopulatedTier>;

const TIER_ORDER: (keyof PopulatedTiers)[] = ['free', 'economical', 'premium', 'frontier'];

export function populateTiers(merged: MergedEntry[], boundaries: TierPriceBoundaries): PopulatedTiers {
    const result = {} as PopulatedTiers;

    for (const name of TIER_ORDER) {
        const b = boundaries[name];
        const inTier = merged
            .filter(m =>
                m.pricing.inputPerMillion  <= b.maxInputPerMillion &&
                m.pricing.outputPerMillion <= b.maxOutputPerMillion,
            )
            .filter(m => bestTierFor(m, boundaries) === name)
            .sort((a, b2) => a.pricing.inputPerMillion - b2.pricing.inputPerMillion)
            .map(m => ({ provider: m.provider, model: m.id }));

        result[name] = { scoreRange: b.tier, models: inTier };
    }

    return result;
}

function bestTierFor(m: MergedEntry, boundaries: TierPriceBoundaries): keyof PopulatedTiers {
    for (const name of TIER_ORDER) {
        const b = boundaries[name];
        if (m.pricing.inputPerMillion <= b.maxInputPerMillion && m.pricing.outputPerMillion <= b.maxOutputPerMillion) {
            return name;
        }
    }
    return 'frontier';
}
