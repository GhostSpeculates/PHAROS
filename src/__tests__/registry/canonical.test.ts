import { describe, it, expect } from 'vitest';
import { toCanonicalId } from '../../registry/canonical.js';

describe('canonical id', () => {
    it('keeps namespace/model format unchanged', () => {
        expect(toCanonicalId('meta-llama/Llama-3.3-70B-Instruct')).toBe('meta-llama/Llama-3.3-70B-Instruct');
    });

    it('namespaces direct anthropic models', () => {
        expect(toCanonicalId('claude-sonnet-4-20250514', 'anthropic')).toBe('anthropic/claude-sonnet-4');
    });

    it('namespaces direct openai models', () => {
        expect(toCanonicalId('gpt-4o', 'openai')).toBe('openai/gpt-4o');
    });

    it('strips together/fireworks vendor prefix', () => {
        expect(toCanonicalId('meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo')).toBe('meta-llama/Meta-Llama-3.1-405B-Instruct');
        expect(toCanonicalId('accounts/fireworks/models/llama-v3p3-70b-instruct')).toBe('meta-llama/Llama-3.3-70B-Instruct');
    });

    it('normalizes groq slugs to HF style', () => {
        expect(toCanonicalId('llama-3.3-70b-versatile', 'groq')).toBe('meta-llama/Llama-3.3-70B-Instruct');
    });

    it('lowercases nothing else (case-sensitive)', () => {
        expect(toCanonicalId('moonshot/Kimi-K2')).toBe('moonshot/Kimi-K2');
    });
});
