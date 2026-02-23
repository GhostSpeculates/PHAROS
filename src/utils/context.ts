import type { ChatMessage } from '../providers/types.js';

/**
 * Known context window sizes per model (in tokens).
 * Used for pre-flight filtering to avoid sending oversized requests.
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
    // Anthropic
    'claude-opus-4-20250514': 200_000,
    'claude-sonnet-4-20250514': 200_000,
    'claude-sonnet-4-6': 200_000,
    'claude-haiku-4-5-20251001': 200_000,
    // OpenAI
    'gpt-4o': 128_000,
    'gpt-4o-mini': 128_000,
    'o3': 200_000,
    // Google
    'gemini-2.5-flash': 1_048_576,
    'gemini-2.5-pro': 1_048_576,
    'gemini-2.0-flash': 1_048_576,
    // DeepSeek
    'deepseek-chat': 131_072,
    'deepseek-reasoner': 131_072,
    // Groq
    'llama-3.3-70b-versatile': 128_000,
    // xAI
    'grok-3-mini-fast': 131_072,
};

/** Default context window when model isn't in the map. */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Get the context window size for a given model.
 */
export function getContextWindow(model: string): number {
    return MODEL_CONTEXT_WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * Estimate the token count of a messages array.
 * Uses a rough heuristic: ~4 characters per token for English text.
 * This is intentionally conservative (overestimates slightly) to avoid false passes.
 */
export function estimateTokens(messages: ChatMessage[]): number {
    let totalChars = 0;

    for (const msg of messages) {
        // Role overhead (~4 tokens per message for role/formatting)
        totalChars += 16;

        if (typeof msg.content === 'string') {
            totalChars += msg.content.length;
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part.type === 'text' && typeof (part as any).text === 'string') {
                    totalChars += (part as any).text.length;
                }
            }
        }
    }

    // ~3.5 chars per token on average, round up to be conservative
    return Math.ceil(totalChars / 3.5);
}

/**
 * Check if an error message indicates a context-size / token-limit rejection.
 * These errors mean the request was too big, NOT that the provider is broken.
 */
export function isContextSizeError(errorMessage: string): boolean {
    const lower = errorMessage.toLowerCase();
    return (
        lower.includes('prompt is too long') ||
        lower.includes('maximum context length') ||
        lower.includes('too many tokens') ||
        lower.includes('request too large') ||
        lower.includes('reduce the length') ||
        lower.includes('token limit') ||
        lower.includes('tokens > ') ||
        lower.includes('context window')
    );
}
