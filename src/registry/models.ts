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
    | 'multilingual'
    | 'embedding'
    | 'tts'
    | 'stt'
    | 'image'
    | 'video';

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
    // ─── Together: high-reasoning open-weight (added 2026-05-01) ───
    {
        id: 'deepseek-ai/DeepSeek-R1',
        provider: 'together',
        displayName: 'DeepSeek R1 (Together) — o1-class reasoning',
        contextWindow: 128_000,
        capabilities: ['code', 'math', 'reasoning'],
        pricing: { inputPerMillion: 3.00, outputPerMillion: 7.00 },
        speed: 'slow',
    },
    {
        id: 'Qwen/QwQ-32B-Preview',
        provider: 'together',
        displayName: 'Qwen QwQ-32B Preview (Together) — reasoning',
        contextWindow: 32_768,
        capabilities: ['code', 'math', 'reasoning'],
        pricing: { inputPerMillion: 1.20, outputPerMillion: 1.20 },
        speed: 'medium',
    },
    {
        id: 'meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo',
        provider: 'together',
        displayName: 'Llama 3.1 405B Turbo (Together) — frontier-class',
        contextWindow: 130_815,
        capabilities: ['code', 'math', 'reasoning', 'conversation', 'multilingual', 'creative'],
        pricing: { inputPerMillion: 3.50, outputPerMillion: 3.50 },
        speed: 'slow',
    },

    // ─── OpenRouter — Llama 4 + Gemma 3 + Anthropic resilience (added 2026-05-01) ───
    {
        id: 'google/gemma-3-27b-it',
        provider: 'openrouter',
        displayName: 'Gemma 3 27B Instruct (via OpenRouter)',
        contextWindow: 128_000,
        capabilities: ['code', 'math', 'reasoning', 'conversation', 'multilingual'],
        pricing: { inputPerMillion: 0.10, outputPerMillion: 0.30 },
        speed: 'fast',
    },
    {
        id: 'meta-llama/llama-4-scout',
        provider: 'openrouter',
        displayName: 'Llama 4 Scout (via OpenRouter)',
        contextWindow: 1_000_000,
        capabilities: ['code', 'math', 'reasoning', 'conversation', 'multilingual', 'creative'],
        pricing: { inputPerMillion: 0.15, outputPerMillion: 0.30 },
        speed: 'fast',
    },
    {
        id: 'meta-llama/llama-4-maverick',
        provider: 'openrouter',
        displayName: 'Llama 4 Maverick (via OpenRouter) — Meta flagship MoE',
        contextWindow: 1_000_000,
        capabilities: ['code', 'math', 'reasoning', 'conversation', 'multilingual', 'creative'],
        pricing: { inputPerMillion: 0.30, outputPerMillion: 0.50 },
        speed: 'medium',
    },
    {
        id: 'anthropic/claude-opus-4',
        provider: 'openrouter',
        displayName: 'Claude Opus 4 (via OpenRouter, resilience backup)',
        contextWindow: 200_000,
        capabilities: ['code', 'math', 'reasoning', 'conversation', 'multilingual', 'creative'],
        pricing: { inputPerMillion: 30.00, outputPerMillion: 150.00 },
        speed: 'slow',
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

    // ─── Embeddings (Phase 1 multi-modal) ───
    {
        id: 'text-embedding-3-small',
        provider: 'openai',
        displayName: 'OpenAI Embedding 3 Small',
        contextWindow: 8191,
        capabilities: ['embedding'],
        pricing: { inputPerMillion: 0.020, outputPerMillion: 0 },
        speed: 'fast',
    },
    {
        id: 'voyage-4-lite',
        provider: 'voyage',
        displayName: 'Voyage 4 Lite',
        contextWindow: 32_000,
        capabilities: ['embedding'],
        pricing: { inputPerMillion: 0.020, outputPerMillion: 0 },
        speed: 'fast',
    },
    {
        id: 'jina-embeddings-v4',
        provider: 'jina',
        displayName: 'Jina Embeddings v4',
        contextWindow: 32_000,
        capabilities: ['embedding'],
        pricing: { inputPerMillion: 0.020, outputPerMillion: 0 },
        speed: 'fast',
    },

    // ─── TTS (Phase 2 multi-modal) ───
    // Pricing here is per-character ($/M-chars), not per-token.
    {
        id: 'tts-1',
        provider: 'openai',
        displayName: 'OpenAI TTS-1',
        contextWindow: 4096,
        capabilities: ['tts'],
        pricing: { inputPerMillion: 15.0, outputPerMillion: 0 },
        speed: 'fast',
    },
    {
        id: 'eleven_turbo_v2_5',
        provider: 'elevenlabs',
        displayName: 'ElevenLabs Turbo v2.5 (voice cloning)',
        contextWindow: 4096,
        capabilities: ['tts'],
        pricing: { inputPerMillion: 180.0, outputPerMillion: 0 },
        speed: 'fast',
    },
    {
        id: 'sonic-2',
        provider: 'cartesia',
        displayName: 'Cartesia Sonic 2 (real-time, <100ms)',
        contextWindow: 4096,
        capabilities: ['tts'],
        pricing: { inputPerMillion: 30.0, outputPerMillion: 0 },
        speed: 'fast',
    },

    // ─── STT (Phase 2 multi-modal) ───
    // Pricing encoded as cost per 1,000,000 audio-seconds — STT bills per-minute, not per-token.
    // Route sets tokens_in = durationSeconds, so cost = durationSeconds * (rate/3600M) collapses correctly.
    {
        id: 'whisper-large-v3-turbo',
        provider: 'groq',
        displayName: 'Groq Whisper Large v3 Turbo',
        contextWindow: 0,
        capabilities: ['stt'],
        pricing: { inputPerMillion: 11.111, outputPerMillion: 0 },
        speed: 'fast',
    },
    {
        id: 'nova-3',
        provider: 'deepgram',
        displayName: 'Deepgram Nova-3 (real-time)',
        contextWindow: 0,
        capabilities: ['stt'],
        pricing: { inputPerMillion: 80.0, outputPerMillion: 0 },
        speed: 'fast',
    },
    {
        id: 'ink-whisper',
        provider: 'cartesia',
        displayName: 'Cartesia Ink-Whisper (streaming)',
        contextWindow: 0,
        capabilities: ['stt'],
        pricing: { inputPerMillion: 36.111, outputPerMillion: 0 },
        speed: 'fast',
    },

    // ─── Images (Phase 3 multi-modal) ───
    // Pricing encoded as cost per 1,000,000 images (rate × 1e6).
    // Route sets tokens_in = image count, so cost = n × pricePerImage collapses correctly.
    {
        id: 'fal-ai/flux/schnell',
        provider: 'fal',
        displayName: 'FLUX.1 Schnell via fal.ai (cheapest tier)',
        contextWindow: 0,
        capabilities: ['image'],
        pricing: { inputPerMillion: 3000.0, outputPerMillion: 0 },
        speed: 'fast',
    },
    {
        id: 'fal-ai/flux-pro/v1.1',
        provider: 'fal',
        displayName: 'FLUX 1.1 Pro via fal.ai (balanced tier)',
        contextWindow: 0,
        capabilities: ['image'],
        pricing: { inputPerMillion: 40000.0, outputPerMillion: 0 },
        speed: 'medium',
    },
    {
        id: 'fal-ai/flux-pro/v1.1-ultra',
        provider: 'fal',
        displayName: 'FLUX 1.1 Pro Ultra via fal.ai (best tier)',
        contextWindow: 0,
        capabilities: ['image'],
        pricing: { inputPerMillion: 60000.0, outputPerMillion: 0 },
        speed: 'slow',
    },
    {
        id: 'flux-pro-1.1',
        provider: 'bfl',
        displayName: 'FLUX 1.1 Pro via BFL direct',
        contextWindow: 0,
        capabilities: ['image'],
        pricing: { inputPerMillion: 40000.0, outputPerMillion: 0 },
        speed: 'medium',
    },
    {
        id: 'flux-pro-1.1-ultra',
        provider: 'bfl',
        displayName: 'FLUX 1.1 Pro Ultra via BFL direct',
        contextWindow: 0,
        capabilities: ['image'],
        pricing: { inputPerMillion: 60000.0, outputPerMillion: 0 },
        speed: 'slow',
    },
    {
        id: 'dall-e-3',
        provider: 'openai',
        displayName: 'OpenAI DALL-E 3 (resilience backstop, universal access)',
        contextWindow: 0,
        capabilities: ['image'],
        pricing: { inputPerMillion: 40000.0, outputPerMillion: 0 },
        speed: 'medium',
    },

    // ─── Video (Phase 4 multi-modal) ───
    // Pricing encoded as cost per 1,000,000 audio-seconds equivalent — pricePerSecond × 1e6.
    // Route sets tokens_in = duration_seconds, so cost = duration × pricePerSecond collapses correctly.
    {
        id: 'fal-ai/kling-video/v1.6/standard/text-to-video',
        provider: 'fal',
        displayName: 'Kling v1.6 Standard via fal.ai (cheapest video tier)',
        contextWindow: 0,
        capabilities: ['video'],
        pricing: { inputPerMillion: 29000.0, outputPerMillion: 0 },
        speed: 'slow',
    },
    {
        id: 'fal-ai/kling-video/v1.6/pro/text-to-video',
        provider: 'fal',
        displayName: 'Kling v1.6 Pro via fal.ai (balanced video tier)',
        contextWindow: 0,
        capabilities: ['video'],
        pricing: { inputPerMillion: 58000.0, outputPerMillion: 0 },
        speed: 'slow',
    },
    {
        id: 'fal-ai/kling-video/v2-master/text-to-video',
        provider: 'fal',
        displayName: 'Kling v2 Master via fal.ai (best video tier)',
        contextWindow: 0,
        capabilities: ['video'],
        pricing: { inputPerMillion: 160000.0, outputPerMillion: 0 },
        speed: 'slow',
    },
    {
        id: 'kling-v1.6-standard',
        provider: 'kling',
        displayName: 'Kling v1.6 Standard direct (PAYG)',
        contextWindow: 0,
        capabilities: ['video'],
        pricing: { inputPerMillion: 29000.0, outputPerMillion: 0 },
        speed: 'slow',
    },
    {
        id: 'kling-v1.6-pro',
        provider: 'kling',
        displayName: 'Kling v1.6 Pro direct',
        contextWindow: 0,
        capabilities: ['video'],
        pricing: { inputPerMillion: 58000.0, outputPerMillion: 0 },
        speed: 'slow',
    },
    {
        id: 'veo-3',
        provider: 'kie',
        displayName: 'Google Veo 3 via KIE AI',
        contextWindow: 0,
        capabilities: ['video'],
        pricing: { inputPerMillion: 100000.0, outputPerMillion: 0 },
        speed: 'slow',
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
