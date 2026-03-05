import { describe, it, expect } from 'vitest';
import { getModelSpeed, getModelCost, getSpeedRank, getRegistryEntry } from '../registry/index.js';

describe('getModelSpeed', () => {
    it('returns fast for groq llama', () => {
        expect(getModelSpeed('groq', 'llama-3.3-70b-versatile')).toBe('fast');
    });

    it('returns medium for deepseek-chat', () => {
        expect(getModelSpeed('deepseek', 'deepseek-chat')).toBe('medium');
    });

    it('returns slow for claude-opus', () => {
        expect(getModelSpeed('anthropic', 'claude-opus-4-20250514')).toBe('slow');
    });

    it('returns undefined for unknown model', () => {
        expect(getModelSpeed('unknown', 'nonexistent')).toBeUndefined();
    });
});

describe('getModelCost', () => {
    it('returns 0 for free models', () => {
        expect(getModelCost('groq', 'llama-3.3-70b-versatile')).toBe(0);
    });

    it('returns sum of input+output for paid models', () => {
        const cost = getModelCost('deepseek', 'deepseek-chat');
        expect(cost).toBeDefined();
        expect(cost).toBeCloseTo(0.42); // 0.14 + 0.28
    });

    it('returns undefined for unknown model', () => {
        expect(getModelCost('unknown', 'nonexistent')).toBeUndefined();
    });
});

describe('getSpeedRank', () => {
    it('returns 0 for fast models', () => {
        expect(getSpeedRank('groq', 'llama-3.3-70b-versatile')).toBe(0);
    });

    it('returns 1 for medium models', () => {
        expect(getSpeedRank('deepseek', 'deepseek-chat')).toBe(1);
    });

    it('returns 2 for slow models', () => {
        expect(getSpeedRank('anthropic', 'claude-opus-4-20250514')).toBe(2);
    });

    it('defaults to 1 (medium) for unknown models', () => {
        expect(getSpeedRank('unknown', 'nonexistent')).toBe(1);
    });
});

describe('getRegistryEntry', () => {
    it('returns full entry for known model', () => {
        const entry = getRegistryEntry('openai', 'gpt-4o');
        expect(entry).toBeDefined();
        expect(entry!.displayName).toBe('GPT-4o');
        expect(entry!.contextWindow).toBe(128_000);
    });

    it('returns undefined for unknown model', () => {
        expect(getRegistryEntry('unknown', 'nonexistent')).toBeUndefined();
    });
});
