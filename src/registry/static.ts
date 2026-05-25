/**
 * Emergency-fallback seed entries. Used only when:
 *   - all sync sources fail on cold boot
 *   - AND no cached catalog exists
 *
 * One entry per direct-key provider so Pharos can still serve.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StaticSeedEntry {
    canonicalId: string;
    id: string;
    provider: string;
    displayName: string;
    contextWindow: number;
    pricing: { inputPerMillion: number; outputPerMillion: number };
}

// ─── Seed ────────────────────────────────────────────────────────────────────

export const STATIC_SEED: StaticSeedEntry[] = [
    {
        canonicalId: 'anthropic/claude-sonnet-4',
        id: 'claude-sonnet-4-20250514',
        provider: 'anthropic',
        displayName: 'Claude Sonnet 4',
        contextWindow: 200_000,
        pricing: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
    },
    {
        canonicalId: 'openai/gpt-4o',
        id: 'gpt-4o',
        provider: 'openai',
        displayName: 'GPT-4o',
        contextWindow: 128_000,
        pricing: { inputPerMillion: 2.5, outputPerMillion: 10.0 },
    },
    {
        canonicalId: 'google/gemini-2.5-flash',
        id: 'gemini-2.5-flash',
        provider: 'google',
        displayName: 'Gemini 2.5 Flash',
        contextWindow: 1_048_576,
        pricing: { inputPerMillion: 0.075, outputPerMillion: 0.30 },
    },
    {
        canonicalId: 'meta-llama/Llama-3.3-70B-Instruct',
        id: 'llama-3.3-70b-versatile',
        provider: 'groq',
        displayName: 'Llama 3.3 70B (Groq)',
        contextWindow: 128_000,
        pricing: { inputPerMillion: 0.59, outputPerMillion: 0.79 },
    },
    {
        canonicalId: 'moonshot/kimi-latest',
        id: 'kimi-latest',
        provider: 'moonshot',
        displayName: 'Kimi Latest',
        contextWindow: 128_000,
        pricing: { inputPerMillion: 0.50, outputPerMillion: 2.00 },
    },
    {
        canonicalId: 'xai/grok-3-mini-fast',
        id: 'grok-3-mini-fast',
        provider: 'xai',
        displayName: 'Grok 3 Mini Fast',
        contextWindow: 131_072,
        pricing: { inputPerMillion: 0.30, outputPerMillion: 0.50 },
    },
];
