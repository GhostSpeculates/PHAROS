/**
 * Cost calculator — knows the price of every model.
 *
 * Prices are per million tokens (input/output).
 * Updated as of early 2025.
 *
 * The hardcoded PRICING_DEFAULTS table serves as a fallback. Config-provided
 * pricing entries (from pharos.yaml / pharos.default.yaml) take precedence
 * via initPricing().
 */

export interface PricingEntry {
    provider: string;
    model: string;
    inputCostPerMillion: number;
    outputCostPerMillion: number;
}

interface ModelPricing {
    inputPerMillion: number;
    outputPerMillion: number;
}

// Hardcoded defaults — used as fallback when config doesn't specify pricing
const PRICING_DEFAULTS: Record<string, ModelPricing> = {
    // ─── Free Tier ───
    'google/gemini-2.0-flash': { inputPerMillion: 0, outputPerMillion: 0 },
    'groq/llama-3.3-70b-versatile': { inputPerMillion: 0.59, outputPerMillion: 0.79 },

    // ─── Economical Tier ───
    'deepseek/deepseek-chat': { inputPerMillion: 0.14, outputPerMillion: 0.28 },
    'mistral/mistral-large-latest': { inputPerMillion: 2.0, outputPerMillion: 6.0 },

    // ─── Premium Tier ───
    'anthropic/claude-sonnet-4-20250514': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
    'openai/gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10.0 },
    'google/gemini-2.5-pro': { inputPerMillion: 1.25, outputPerMillion: 10.0 },

    // ─── Frontier Tier ───
    'anthropic/claude-opus-4-20250514': { inputPerMillion: 15.0, outputPerMillion: 75.0 },
    'openai/o3': { inputPerMillion: 10.0, outputPerMillion: 40.0 },
};

// Active pricing table — starts as a copy of defaults, can be overridden by config
let PRICING: Record<string, ModelPricing> = { ...PRICING_DEFAULTS };

/**
 * Initialize pricing from config values.
 * Config entries take precedence over hardcoded defaults.
 * Call this once at startup after loading config.
 */
export function initPricing(configPricing?: PricingEntry[]): void {
    // Reset to defaults first
    PRICING = { ...PRICING_DEFAULTS };

    if (!configPricing || configPricing.length === 0) {
        return;
    }

    // Merge config pricing over defaults — config values win
    for (const entry of configPricing) {
        const key = `${entry.provider}/${entry.model}`;
        PRICING[key] = {
            inputPerMillion: entry.inputCostPerMillion,
            outputPerMillion: entry.outputCostPerMillion,
        };
    }
}

/**
 * Calculate the estimated cost for a request.
 */
export function calculateCost(
    provider: string,
    model: string,
    tokensIn: number,
    tokensOut: number,
): number {
    const key = `${provider}/${model}`;
    const pricing = PRICING[key];

    if (!pricing) {
        // Unknown model — assume moderate pricing
        return ((tokensIn * 1.0) / 1_000_000) + ((tokensOut * 3.0) / 1_000_000);
    }

    return (
        (tokensIn * pricing.inputPerMillion) / 1_000_000 +
        (tokensOut * pricing.outputPerMillion) / 1_000_000
    );
}

/**
 * Calculate what this request WOULD have cost on the baseline model
 * (default: Claude Sonnet). This is how we calculate savings.
 */
export function calculateBaselineCost(
    tokensIn: number,
    tokensOut: number,
    baselineCostPerMillionInput: number,
    baselineCostPerMillionOutput: number,
): number {
    return (
        (tokensIn * baselineCostPerMillionInput) / 1_000_000 +
        (tokensOut * baselineCostPerMillionOutput) / 1_000_000
    );
}
