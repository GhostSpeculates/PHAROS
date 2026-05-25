import { describe, it, expect } from 'vitest';
import { getModelSpeed, getModelCost, getSpeedRank, getRegistryEntry } from '../registry/index.js';

describe('getModelSpeed', () => {
    it('returns medium for groq llama (static seed uniform speed)', () => {
        expect(getModelSpeed('groq', 'llama-3.3-70b-versatile')).toBe('medium');
    });

    it('returns undefined for deepseek-chat (not in static seed)', () => {
        expect(getModelSpeed('deepseek', 'deepseek-chat')).toBeUndefined();
    });

    it('returns undefined for claude-opus (not in static seed)', () => {
        expect(getModelSpeed('anthropic', 'claude-opus-4-20250514')).toBeUndefined();
    });

    it('returns undefined for unknown model', () => {
        expect(getModelSpeed('unknown', 'nonexistent')).toBeUndefined();
    });
});

describe('getModelCost', () => {
    it('returns real static-seed price for groq llama (was 0 in legacy MODEL_REGISTRY)', () => {
        // getModelCost now prefers merged-registry pricing over legacy MODEL_REGISTRY zeros.
        // Static seed has groq llama at 0.59 + 0.79 = 1.38 per million tokens.
        expect(getModelCost('groq', 'llama-3.3-70b-versatile')).toBeCloseTo(1.38);
    });

    it('returns undefined for deepseek-chat (not in static seed)', () => {
        expect(getModelCost('deepseek', 'deepseek-chat')).toBeUndefined();
    });

    it('returns undefined for unknown model', () => {
        expect(getModelCost('unknown', 'nonexistent')).toBeUndefined();
    });
});

describe('getSpeedRank', () => {
    it('returns 1 (medium) for groq llama (static seed uniform speed)', () => {
        expect(getSpeedRank('groq', 'llama-3.3-70b-versatile')).toBe(1);
    });

    it('returns 1 for deepseek-chat (not in seed, defaults to medium)', () => {
        expect(getSpeedRank('deepseek', 'deepseek-chat')).toBe(1);
    });

    it('returns 1 for claude-opus (not in static seed, defaults to medium)', () => {
        expect(getSpeedRank('anthropic', 'claude-opus-4-20250514')).toBe(1);
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
