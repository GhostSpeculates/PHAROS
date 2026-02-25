import { z } from 'zod';

// ─── Model definition within a tier ───
export const ModelEntrySchema = z.object({
    provider: z.string(),
    model: z.string(),
});

// ─── Tier configuration ───
export const TierSchema = z.object({
    scoreRange: z
        .tuple([z.number().min(1), z.number().max(10)])
        .refine(([min, max]) => min <= max, {
            message: 'scoreRange[0] (min) must be <= scoreRange[1] (max)',
        }),
    models: z.array(ModelEntrySchema).min(1),
});

// ─── Pricing entry configuration ───
export const PricingEntrySchema = z.object({
    provider: z.string(),
    model: z.string(),
    inputCostPerMillion: z.number(),
    outputCostPerMillion: z.number(),
});

// ─── Provider configuration ───
export const ProviderConfigSchema = z.object({
    apiKeyEnv: z.string(),
    baseUrl: z.string().url().optional(),
    timeoutMs: z.number().min(1000).default(30000),
    healthCooldownMs: z.number().min(1000).default(60000),
});

// ─── Classifier provider entry ───
export const ClassifierProviderEntrySchema = z.object({
    provider: z.string(),
    model: z.string(),
});

// ─── Classifier configuration ───
// Supports both new format (providers array) and legacy (single provider/model).
export const ClassifierConfigSchema = z.object({
    providers: z.array(ClassifierProviderEntrySchema).optional(),
    // Legacy format — auto-wrapped into providers array
    provider: z.string().optional(),
    model: z.string().optional(),
    fallbackTier: z
        .enum(['free', 'economical', 'premium', 'frontier'])
        .default('economical'),
    timeoutMs: z.number().positive().default(5000),
}).transform((data) => {
    // Backward compatibility: wrap single provider/model into providers array
    let providers: Array<{ provider: string; model: string }>;
    if (!data.providers) {
        if (data.provider && data.model) {
            providers = [{ provider: data.provider, model: data.model }];
        } else {
            providers = [{ provider: 'google', model: 'gemini-2.0-flash' }];
        }
    } else {
        providers = data.providers;
    }
    return {
        providers,
        fallbackTier: data.fallbackTier,
        timeoutMs: data.timeoutMs,
    };
});

// ─── Tracking configuration ───
export const TrackingConfigSchema = z.object({
    enabled: z.boolean().default(true),
    dbPath: z.string().default('./data/pharos.db'),
    baselineModel: z.string().default('claude-sonnet-4-20250514'),
    baselineCostPerMillionInput: z.number().default(3.0),
    baselineCostPerMillionOutput: z.number().default(15.0),
    retentionDays: z.number().int().positive().default(30),
});

// ─── Server configuration ───
export const ServerConfigSchema = z.object({
    port: z.number().int().positive().default(3777),
    host: z.string().default('0.0.0.0'),
    bodyLimitMb: z.number().positive().default(10),
    rateLimitPerMinute: z.number().int().positive().default(100),
});

// ─── Router configuration ───
export const RouterConfigSchema = z.object({
    oversizedThresholdTokens: z.number().int().positive().default(100_000),
});

// ─── Alerts configuration ───
export const AlertsConfigSchema = z.object({
    discordWebhookUrl: z.string().url().optional(),
});

// ─── Auth configuration ───
export const AuthConfigSchema = z.object({
    apiKey: z.string().default(''),
});

// ─── Logging configuration ───
export const LoggingConfigSchema = z.object({
    level: z.string().default('info'),
    pretty: z.boolean().default(true),
});

// ─── Full Pharos configuration ───
export const PharosConfigSchema = z.object({
    server: ServerConfigSchema.default({}),
    auth: AuthConfigSchema.default({}),
    alerts: AlertsConfigSchema.default({}),
    router: RouterConfigSchema.default({}),
    classifier: ClassifierConfigSchema.default({}),
    tiers: z
        .object({
            free: TierSchema,
            economical: TierSchema,
            premium: TierSchema,
            frontier: TierSchema,
        })
        .refine(
            (tiers) => {
                const entries = Object.values(tiers);
                for (let i = 0; i < entries.length; i++) {
                    for (let j = i + 1; j < entries.length; j++) {
                        const [aMin, aMax] = entries[i].scoreRange;
                        const [bMin, bMax] = entries[j].scoreRange;
                        // Two ranges overlap if one starts before the other ends
                        if (aMin <= bMax && bMin <= aMax) {
                            return false;
                        }
                    }
                }
                return true;
            },
            { message: 'Tier score ranges must not overlap' },
        )
        .default({
            free: { scoreRange: [1, 3], models: [{ provider: 'google', model: 'gemini-2.0-flash' }] },
            economical: {
                scoreRange: [4, 6],
                models: [{ provider: 'deepseek', model: 'deepseek-chat' }],
            },
            premium: {
                scoreRange: [7, 8],
                models: [{ provider: 'anthropic', model: 'claude-sonnet-4-20250514' }],
            },
            frontier: {
                scoreRange: [9, 10],
                models: [{ provider: 'anthropic', model: 'claude-opus-4-20250514' }],
            },
        }),
    providers: z.record(z.string(), ProviderConfigSchema).default({}),
    pricing: z.array(PricingEntrySchema).optional(),
    tracking: TrackingConfigSchema.default({}),
    logging: LoggingConfigSchema.default({}),
});

// ─── Type exports ───
export type PharosConfig = z.infer<typeof PharosConfigSchema>;
export type TierConfig = z.infer<typeof TierSchema>;
export type ModelEntry = z.infer<typeof ModelEntrySchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type PricingEntry = z.infer<typeof PricingEntrySchema>;
export type TierName = 'free' | 'economical' | 'premium' | 'frontier';
