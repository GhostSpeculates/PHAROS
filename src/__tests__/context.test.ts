import { describe, it, expect } from 'vitest';
import { estimateTokens, getContextWindow, isContextSizeError } from '../utils/context.js';
import type { ChatMessage } from '../providers/types.js';

// ─── getContextWindow ────────────────────────────────────

describe('getContextWindow', () => {
    it('returns known context window for gpt-4o', () => {
        expect(getContextWindow('gpt-4o')).toBe(128_000);
    });

    it('returns known context window for claude-opus', () => {
        expect(getContextWindow('claude-opus-4-20250514')).toBe(200_000);
    });

    it('returns known context window for gemini-2.0-flash', () => {
        expect(getContextWindow('gemini-2.0-flash')).toBe(1_048_576);
    });

    it('returns default (128K) for unknown model', () => {
        expect(getContextWindow('unknown-model-xyz')).toBe(128_000);
    });

    it('returns known context window for deepseek-chat', () => {
        expect(getContextWindow('deepseek-chat')).toBe(131_072);
    });

    it('returns known context window for kimi-latest', () => {
        expect(getContextWindow('kimi-latest')).toBe(131_072);
    });

    // Together AI
    it('returns known context window for Together Llama 3.3 70B', () => {
        expect(getContextWindow('meta-llama/Llama-3.3-70B-Instruct-Turbo')).toBe(128_000);
    });

    it('returns known context window for Together DeepSeek V3', () => {
        expect(getContextWindow('deepseek-ai/DeepSeek-V3')).toBe(131_072);
    });

    it('returns known context window for Together Qwen 2.5 72B', () => {
        expect(getContextWindow('Qwen/Qwen2.5-72B-Instruct-Turbo')).toBe(131_072);
    });

    // Fireworks AI
    it('returns known context window for Fireworks Llama 3.3 70B', () => {
        expect(getContextWindow('accounts/fireworks/models/llama-v3p3-70b-instruct')).toBe(128_000);
    });

    it('returns known context window for Fireworks DeepSeek V3', () => {
        expect(getContextWindow('accounts/fireworks/models/deepseek-v3')).toBe(131_072);
    });
});

// ─── estimateTokens ──────────────────────────────────────

describe('estimateTokens', () => {
    it('estimates tokens for string content messages', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'Hello, world!' },
        ];
        const tokens = estimateTokens(messages);
        // ~13 chars content + 16 role overhead = 29 chars / 3.5 ≈ 9 tokens
        expect(tokens).toBeGreaterThan(0);
        expect(tokens).toBeLessThan(50);
    });

    it('estimates tokens for array content (multimodal)', () => {
        const messages: ChatMessage[] = [
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'Describe this image' },
                    { type: 'image_url', url: 'https://example.com/img.png' },
                ],
            },
        ];
        const tokens = estimateTokens(messages);
        // Only text parts counted
        expect(tokens).toBeGreaterThan(0);
    });

    it('handles null content gracefully', () => {
        const messages: ChatMessage[] = [
            { role: 'assistant', content: null },
        ];
        const tokens = estimateTokens(messages);
        // Only role overhead
        expect(tokens).toBeGreaterThan(0);
        expect(tokens).toBeLessThan(10);
    });

    it('sums across multiple messages', () => {
        const short: ChatMessage[] = [{ role: 'user', content: 'Hi' }];
        const long: ChatMessage[] = [
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: 'Hello! How can I help you today?' },
            { role: 'user', content: 'Tell me about quantum computing in detail please.' },
        ];

        expect(estimateTokens(long)).toBeGreaterThan(estimateTokens(short));
    });

    it('returns higher estimates for longer content', () => {
        const short: ChatMessage[] = [{ role: 'user', content: 'Hello' }];
        const long: ChatMessage[] = [{ role: 'user', content: 'A'.repeat(10000) }];

        expect(estimateTokens(long)).toBeGreaterThan(estimateTokens(short));
    });
});

// ─── isContextSizeError ──────────────────────────────────

describe('isContextSizeError', () => {
    it('detects "prompt is too long"', () => {
        expect(isContextSizeError('Error: prompt is too long for this model')).toBe(true);
    });

    it('detects "maximum context length"', () => {
        expect(isContextSizeError('This model has a maximum context length of 128000 tokens')).toBe(true);
    });

    it('detects "too many tokens"', () => {
        expect(isContextSizeError('Request has too many tokens: 150000 > 128000')).toBe(true);
    });

    it('detects "request too large"', () => {
        expect(isContextSizeError('request too large for model')).toBe(true);
    });

    it('detects "reduce the length"', () => {
        expect(isContextSizeError('Please reduce the length of the messages')).toBe(true);
    });

    it('detects "token limit"', () => {
        expect(isContextSizeError('Exceeded token limit for this model')).toBe(true);
    });

    it('detects "tokens > " pattern', () => {
        expect(isContextSizeError('150000 tokens > 128000 allowed')).toBe(true);
    });

    it('detects "context window"', () => {
        expect(isContextSizeError('Exceeds the context window of 128K tokens')).toBe(true);
    });

    it('returns false for unrelated errors', () => {
        expect(isContextSizeError('Connection timeout')).toBe(false);
        expect(isContextSizeError('Rate limit exceeded')).toBe(false);
        expect(isContextSizeError('Invalid API key')).toBe(false);
    });

    it('is case-insensitive', () => {
        expect(isContextSizeError('PROMPT IS TOO LONG')).toBe(true);
        expect(isContextSizeError('Maximum Context Length exceeded')).toBe(true);
    });
});
