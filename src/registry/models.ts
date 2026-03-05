/**
 * Model Registry — metadata catalog for all known models.
 *
 * Provides capability tags, pricing, speed tiers, and context windows
 * for every model that Pharos can route to. Used by the /v1/models
 * endpoint to enrich responses with Pharos-specific metadata.
 */

export type ModelCapability =
    | 'code'
    | 'math'
    | 'reasoning'
    | 'creative'
    | 'conversation'
    | 'multilingual';

export type SpeedTier = 'fast' | 'medium' | 'slow';

export interface ModelPricing {
    inputPerMillion: number;
    outputPerMillion: number;
}

export interface ModelRegistryEntry {
    /** Model ID as sent to the provider (e.g. "gpt-4o", "claude-opus-4-20250514") */
    id: string;
    /** Provider name matching config key (e.g. "openai", "anthropic") */
    provider: string;
    /** Human-readable display name */
    displayName: string;
    /** Context window size in tokens */
    contextWindow: number;
    /** What this model is good at */
    capabilities: ModelCapability[];
    /** Cost per million tokens */
    pricing: ModelPricing;
    /** Relative speed tier */
    speed: SpeedTier;
}

/**
 * Central registry of all models Pharos knows about.
 */
export const MODEL_REGISTRY: ModelRegistryEntry[] = [
    // ─── Anthropic ───
    {
        id: 'claude-opus-4-20250514',
        provider: 'anthropic',
        displayName: 'Claude Opus 4',
        contextWindow: 200_000,
        capabilities: ['code', 'math', 'reasoning', 'creative', 'conversation', 'multilingual'],
        pricing: { inputPerMillion: 15.0, outputPerMillion: 75.0 },
        speed: 'slow',
    },
    {
        id: 'claude-sonnet-4-20250514',
        provider: 'anthropic',
        displayName: 'Claude Sonnet 4',
        contextWindow: 200_000,
        capabilities: ['code', 'math', 'reasoning', 'creative', 'conversation', 'multilingual'],
        pricing: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
        speed: 'medium',
    },

    // ─── Google ───
    {
        id: 'gemini-2.5-flash',
        provider: 'google',
        displayName: 'Gemini 2.5 Flash',
        contextWindow: 1_048_576,
        capabilities: ['code', 'math', 'reasoning', 'conversation', 'multilingual'],
        pricing: { inputPerMillion: 0, outputPerMillion: 0 },
        speed: 'fast',
    },
    {
        id: 'gemini-2.5-pro',
        provider: 'google',
        displayName: 'Gemini 2.5 Pro',
        contextWindow: 1_048_576,
        capabilities: ['code', 'math', 'reasoning', 'creative', 'conversation', 'multilingual'],
        pricing: { inputPerMillion: 1.25, outputPerMillion: 10.0 },
        speed: 'medium',
    },

    // ─── OpenAI ───
    {
        id: 'gpt-4o',
        provider: 'openai',
        displayName: 'GPT-4o',
        contextWindow: 128_000,
        capabilities: ['code', 'math', 'reasoning', 'creative', 'conversation', 'multilingual'],
        pricing: { inputPerMillion: 2.5, outputPerMillion: 10.0 },
        speed: 'medium',
    },
    {
        id: 'o3',
        provider: 'openai',
        displayName: 'o3',
        contextWindow: 200_000,
        capabilities: ['code', 'math', 'reasoning'],
        pricing: { inputPerMillion: 10.0, outputPerMillion: 40.0 },
        speed: 'slow',
    },

    // ─── DeepSeek ───
    {
        id: 'deepseek-chat',
        provider: 'deepseek',
        displayName: 'DeepSeek V3',
        contextWindow: 131_072,
        capabilities: ['code', 'math', 'reasoning', 'conversation', 'multilingual'],
        pricing: { inputPerMillion: 0.14, outputPerMillion: 0.28 },
        speed: 'medium',
    },
    {
        id: 'deepseek-reasoner',
        provider: 'deepseek',
        displayName: 'DeepSeek R1',
        contextWindow: 131_072,
        capabilities: ['code', 'math', 'reasoning'],
        pricing: { inputPerMillion: 0.55, outputPerMillion: 2.19 },
        speed: 'slow',
    },

    // ─── Groq ───
    {
        id: 'llama-3.3-70b-versatile',
        provider: 'groq',
        displayName: 'Llama 3.3 70B (Groq)',
        contextWindow: 128_000,
        capabilities: ['code', 'math', 'reasoning', 'conversation', 'multilingual'],
        pricing: { inputPerMillion: 0, outputPerMillion: 0 },
        speed: 'fast',
    },

    // ─── Mistral ───
    {
        id: 'mistral-large-latest',
        provider: 'mistral',
        displayName: 'Mistral Large',
        contextWindow: 128_000,
        capabilities: ['code', 'math', 'reasoning', 'creative', 'conversation', 'multilingual'],
        pricing: { inputPerMillion: 2.0, outputPerMillion: 6.0 },
        speed: 'medium',
    },

    // ─── xAI ───
    {
        id: 'grok-3-mini-fast',
        provider: 'xai',
        displayName: 'Grok 3 Mini Fast',
        contextWindow: 131_072,
        capabilities: ['code', 'math', 'reasoning', 'conversation'],
        pricing: { inputPerMillion: 0.3, outputPerMillion: 0.5 },
        speed: 'fast',
    },

    // ─── Moonshot ───
    {
        id: 'kimi-latest',
        provider: 'moonshot',
        displayName: 'Kimi Latest',
        contextWindow: 131_072,
        capabilities: ['code', 'reasoning', 'conversation', 'multilingual'],
        pricing: { inputPerMillion: 0.5, outputPerMillion: 2.5 },
        speed: 'medium',
    },

    // ─── Together AI ───
    {
        id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        provider: 'together',
        displayName: 'Llama 3.3 70B Turbo (Together)',
        contextWindow: 128_000,
        capabilities: ['code', 'math', 'reasoning', 'conversation', 'multilingual'],
        pricing: { inputPerMillion: 0.88, outputPerMillion: 0.88 },
        speed: 'fast',
    },
    {
        id: 'deepseek-ai/DeepSeek-V3',
        provider: 'together',
        displayName: 'DeepSeek V3 (Together)',
        contextWindow: 131_072,
        capabilities: ['code', 'math', 'reasoning', 'conversation', 'multilingual'],
        pricing: { inputPerMillion: 0.50, outputPerMillion: 0.90 },
        speed: 'medium',
    },
    {
        id: 'Qwen/Qwen2.5-72B-Instruct-Turbo',
        provider: 'together',
        displayName: 'Qwen 2.5 72B Turbo (Together)',
        contextWindow: 131_072,
        capabilities: ['code', 'math', 'reasoning', 'conversation', 'multilingual'],
        pricing: { inputPerMillion: 0.60, outputPerMillion: 0.60 },
        speed: 'fast',
    },

    // ─── Fireworks AI ───
    {
        id: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
        provider: 'fireworks',
        displayName: 'Llama 3.3 70B (Fireworks)',
        contextWindow: 128_000,
        capabilities: ['code', 'math', 'reasoning', 'conversation', 'multilingual'],
        pricing: { inputPerMillion: 0.90, outputPerMillion: 0.90 },
        speed: 'fast',
    },
    {
        id: 'accounts/fireworks/models/deepseek-v3',
        provider: 'fireworks',
        displayName: 'DeepSeek V3 (Fireworks)',
        contextWindow: 131_072,
        capabilities: ['code', 'math', 'reasoning', 'conversation', 'multilingual'],
        pricing: { inputPerMillion: 0.50, outputPerMillion: 1.40 },
        speed: 'medium',
    },
];

/**
 * Get all models in the registry.
 */
export function getAllModels(): ModelRegistryEntry[] {
    return MODEL_REGISTRY;
}

/**
 * Find a model by provider and ID.
 */
export function findModel(provider: string, id: string): ModelRegistryEntry | undefined {
    return MODEL_REGISTRY.find((m) => m.provider === provider && m.id === id);
}

/**
 * Find all models for a given provider.
 */
export function findModelsByProvider(provider: string): ModelRegistryEntry[] {
    return MODEL_REGISTRY.filter((m) => m.provider === provider);
}

/**
 * Find all models with a specific capability.
 */
export function findModelsByCapability(capability: ModelCapability): ModelRegistryEntry[] {
    return MODEL_REGISTRY.filter((m) => m.capabilities.includes(capability));
}
