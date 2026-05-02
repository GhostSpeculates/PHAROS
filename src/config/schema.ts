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
    timeoutMs: z.number().positive().default(3000),
    maxConcurrent: z.number().int().positive().default(5),
    cacheMaxSize: z.number().int().positive().default(100),
    cacheTtlMs: z.number().int().positive().default(30000),
}).transform((data) => {
    // Backward compatibility: wrap single provider/model into providers array
    let providers: Array<{ provider: string; model: string }>;
    if (!data.providers) {
        if (data.provider && data.model) {
            providers = [{ provider: data.provider, model: data.model }];
        } else {
            providers = [{ provider: 'google', model: 'gemini-2.5-flash' }];
        }
    } else {
        providers = data.providers;
    }
    return {
        providers,
        fallbackTier: data.fallbackTier,
        timeoutMs: data.timeoutMs,
        maxConcurrent: data.maxConcurrent,
        cacheMaxSize: data.cacheMaxSize,
        cacheTtlMs: data.cacheTtlMs,
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
    agentRateLimitPerMinute: z.number().int().positive().default(30),
    selfTest: z.boolean().default(true),
    debugLogging: z.boolean().default(false),
});

// ─── Router configuration ───
export const RouterConfigSchema = z.object({
    oversizedThresholdTokens: z.number().int().positive().default(100_000),
});

// ─── Alerts configuration ───
export const AlertsConfigSchema = z.object({
    discordWebhookUrl: z.string().url().optional(),
    ntfyTopic: z.string().optional(),
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

// ─── Task Affinity configuration ───
// Maps task types to preferred provider order for model selection within a tier
export const TaskAffinitySchema = z.record(
    z.string(),
    z.array(z.string()),
).default({});

// ─── Spending limits configuration ───
export const SpendingConfigSchema = z.object({
    dailyLimit: z.number().positive().nullable().default(null),
    monthlyLimit: z.number().positive().nullable().default(null),
});

// ─── Agent profile configuration ───
export const AgentProfileSchema = z.object({
    description: z.string().optional(),
    scoreFloor: z.number().min(1).max(10).optional(),
    scoreCeiling: z.number().min(1).max(10).optional(),
    minTier: z.enum(['free', 'economical', 'premium', 'frontier']).optional(),
    maxTier: z.enum(['free', 'economical', 'premium', 'frontier']).optional(),
});

// ─── Prompt enhancement configuration ───
export const PromptEnhancementSchema = z.object({
    enabled: z.boolean().default(true),
    excludeTiers: z.array(z.enum(['free', 'economical', 'premium', 'frontier'])).default(['premium', 'frontier']),
    hints: z.record(z.string(), z.string()).default({}),
});

// ─── Performance learning configuration ───
export const PerformanceLearningSchema = z.object({
    enabled: z.boolean().default(true),
    minConfidenceSamples: z.number().int().positive().default(10),
    decayFactor: z.number().min(0).max(1).default(0.85),
    maxWeight: z.number().positive().default(2.0),
    minWeight: z.number().positive().default(0.3),
});

// ─── Conversation tracking configuration ───
export const ConversationConfigSchema = z.object({
    maxConversations: z.number().int().positive().default(500),
    conversationTtlMs: z.number().int().positive().default(1_800_000),
    enabled: z.boolean().default(true),
});

// ─── Embeddings configuration ───
// Provider list ordered by routing priority (cost-tied, so first healthy wins).
export const EmbeddingProviderEntrySchema = z.object({
    name: z.string(),    // matches a key in top-level `providers:` block
    model: z.string(),   // model ID sent to the provider's /v1/embeddings endpoint
});

export const EmbeddingsConfigSchema = z.object({
    enabled: z.boolean().default(true),
    providers: z.array(EmbeddingProviderEntrySchema).min(1),
});

// ─── TTS configuration (Phase 2) ───
// TTSRouter hardcodes the three providers (openai/elevenlabs/cartesia) since
// each has a fundamentally different request shape; toggle is enable-only.
export const TTSConfigSchema = z.object({
    enabled: z.boolean().default(true),
});

// ─── STT configuration (Phase 2) ───
// Same shape as TTS — STTRouter hardcodes groq/deepgram/cartesia.
export const STTConfigSchema = z.object({
    enabled: z.boolean().default(true),
});

// ─── Images configuration (Phase 3) ───
// Quality-tier mapping is the actual product wedge — caller passes
// `quality: best | balanced | cheapest` and Pharos resolves it to a
// (provider, model) candidate with built-in fallback to lower tiers.
export const ImageQualityCandidateSchema = z.object({
    provider: z.string(),
    model: z.string(),
    pricePerImage: z.number().nonnegative(),
});

export const ImagesConfigSchema = z.object({
    enabled: z.boolean().default(true),
    qualityTiers: z.object({
        cheapest: z.array(ImageQualityCandidateSchema).optional(),
        balanced: z.array(ImageQualityCandidateSchema).optional(),
        best: z.array(ImageQualityCandidateSchema).optional(),
    }).optional(),
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
            free: { scoreRange: [1, 3], models: [{ provider: 'google', model: 'gemini-2.5-flash' }] },
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
    agents: z.record(z.string(), AgentProfileSchema).default({}),
    pricing: z.array(PricingEntrySchema).optional(),
    taskAffinity: TaskAffinitySchema.default({}),
    spending: SpendingConfigSchema.default({}),
    promptEnhancement: PromptEnhancementSchema.default({}),
    conversation: ConversationConfigSchema.default({}),
    performanceLearning: PerformanceLearningSchema.default({}),
    tracking: TrackingConfigSchema.default({}),
    logging: LoggingConfigSchema.default({}),
    embeddings: EmbeddingsConfigSchema.optional(),
    tts: TTSConfigSchema.optional(),
    stt: STTConfigSchema.optional(),
    images: ImagesConfigSchema.optional(),
});

// ─── Type exports ───
export type PharosConfig = z.infer<typeof PharosConfigSchema>;
export type TierConfig = z.infer<typeof TierSchema>;
export type ModelEntry = z.infer<typeof ModelEntrySchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type PricingEntry = z.infer<typeof PricingEntrySchema>;
export type TierName = 'free' | 'economical' | 'premium' | 'frontier';
