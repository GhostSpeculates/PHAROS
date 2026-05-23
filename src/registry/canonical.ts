/**
 * Normalize provider-specific model IDs into canonical IDs.
 *
 * Canonical ID is `<namespace>/<model>`:
 *   - Open-weights: HF-style namespace (e.g. `meta-llama/Llama-3.3-70B-Instruct`)
 *   - Closed providers: `<provider>/<model>` (e.g. `anthropic/claude-sonnet-4`)
 */

// ─── Lookup tables ────────────────────────────────────────────────────────────

const GROQ_TO_HF: Record<string, string> = {
    'llama-3.3-70b-versatile': 'meta-llama/Llama-3.3-70B-Instruct',
    'llama-3.1-70b-versatile': 'meta-llama/Meta-Llama-3.1-70B-Instruct',
    'llama-3.1-8b-instant':    'meta-llama/Meta-Llama-3.1-8B-Instruct',
    'mixtral-8x7b-32768':      'mistralai/Mixtral-8x7B-Instruct-v0.1',
};

const ANTHROPIC_STRIP_DATE = /^(claude-(?:opus|sonnet|haiku)-\d+)-\d{8}$/;

const FIREWORKS_TO_HF: Record<string, string> = {
    'accounts/fireworks/models/llama-v3p3-70b-instruct': 'meta-llama/Llama-3.3-70B-Instruct',
    'accounts/fireworks/models/deepseek-v3':            'deepseek-ai/DeepSeek-V3',
    'accounts/fireworks/models/deepseek-r1':            'deepseek-ai/DeepSeek-R1',
};

const TOGETHER_STRIP_TURBO = /-Turbo$/;

// ─── Export ───────────────────────────────────────────────────────────────────

export function toCanonicalId(id: string, provider?: string): string {
    // Already namespaced
    if (id.includes('/')) {
        if (id in FIREWORKS_TO_HF) return FIREWORKS_TO_HF[id];
        // Together turbo suffix → strip
        const stripped = id.replace(TOGETHER_STRIP_TURBO, '');
        return stripped;
    }

    if (provider === 'groq' && id in GROQ_TO_HF) {
        return GROQ_TO_HF[id];
    }

    if (provider === 'anthropic') {
        const m = id.match(ANTHROPIC_STRIP_DATE);
        return `anthropic/${m ? m[1] : id}`;
    }

    if (provider) {
        return `${provider}/${id}`;
    }

    return id;
}
