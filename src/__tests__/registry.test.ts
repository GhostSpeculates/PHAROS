import { describe, it, expect } from 'vitest';
import {
    MODEL_REGISTRY,
    getAllModels,
    findModel,
    findModelsByProvider,
    findModelsByCapability,
} from '../registry/models.js';
import type { ModelCapability, SpeedTier } from '../registry/models.js';

const VALID_CAPABILITIES: ModelCapability[] = [
    'code', 'math', 'reasoning', 'creative', 'conversation', 'multilingual',
];
const VALID_SPEEDS: SpeedTier[] = ['fast', 'medium', 'slow'];

// ─── Registry Structure ─────────────────────────────────

describe('MODEL_REGISTRY structure', () => {
    it('is a non-empty array', () => {
        expect(Array.isArray(MODEL_REGISTRY)).toBe(true);
        expect(MODEL_REGISTRY.length).toBeGreaterThan(0);
    });

    it('every entry has required string fields', () => {
        for (const entry of MODEL_REGISTRY) {
            expect(typeof entry.id).toBe('string');
            expect(entry.id.length).toBeGreaterThan(0);
            expect(typeof entry.provider).toBe('string');
            expect(entry.provider.length).toBeGreaterThan(0);
            expect(typeof entry.displayName).toBe('string');
            expect(entry.displayName.length).toBeGreaterThan(0);
        }
    });

    it('every entry has a positive context window', () => {
        for (const entry of MODEL_REGISTRY) {
            expect(entry.contextWindow).toBeGreaterThan(0);
        }
    });

    it('every entry has valid capabilities', () => {
        for (const entry of MODEL_REGISTRY) {
            expect(Array.isArray(entry.capabilities)).toBe(true);
            expect(entry.capabilities.length).toBeGreaterThan(0);
            for (const cap of entry.capabilities) {
                expect(VALID_CAPABILITIES).toContain(cap);
            }
        }
    });

    it('every entry has non-negative pricing', () => {
        for (const entry of MODEL_REGISTRY) {
            expect(entry.pricing.inputPerMillion).toBeGreaterThanOrEqual(0);
            expect(entry.pricing.outputPerMillion).toBeGreaterThanOrEqual(0);
        }
    });

    it('every entry has a valid speed tier', () => {
        for (const entry of MODEL_REGISTRY) {
            expect(VALID_SPEEDS).toContain(entry.speed);
        }
    });

    it('has no duplicate provider+id pairs', () => {
        const keys = MODEL_REGISTRY.map((m) => `${m.provider}/${m.id}`);
        const unique = new Set(keys);
        expect(unique.size).toBe(keys.length);
    });
});

// ─── getAllModels ─────────────────────────────────────────

describe('getAllModels', () => {
    it('returns the full registry', () => {
        const all = getAllModels();
        expect(all).toBe(MODEL_REGISTRY);
        expect(all.length).toBe(MODEL_REGISTRY.length);
    });
});

// ─── findModel ──────────────────────────────────────────

describe('findModel', () => {
    it('finds claude-opus by provider and id', () => {
        const model = findModel('anthropic', 'claude-opus-4-20250514');
        expect(model).toBeDefined();
        expect(model!.displayName).toBe('Claude Opus 4');
        expect(model!.speed).toBe('slow');
    });

    it('finds gpt-4o', () => {
        const model = findModel('openai', 'gpt-4o');
        expect(model).toBeDefined();
        expect(model!.contextWindow).toBe(128_000);
    });

    it('finds Together AI model', () => {
        const model = findModel('together', 'meta-llama/Llama-3.3-70B-Instruct-Turbo');
        expect(model).toBeDefined();
        expect(model!.displayName).toContain('Together');
    });

    it('finds Fireworks AI model', () => {
        const model = findModel('fireworks', 'accounts/fireworks/models/llama-v3p3-70b-instruct');
        expect(model).toBeDefined();
        expect(model!.displayName).toContain('Fireworks');
    });

    it('returns undefined for unknown provider', () => {
        expect(findModel('nonexistent', 'gpt-4o')).toBeUndefined();
    });

    it('returns undefined for unknown model id', () => {
        expect(findModel('openai', 'nonexistent-model')).toBeUndefined();
    });
});

// ─── findModelsByProvider ───────────────────────────────

describe('findModelsByProvider', () => {
    it('returns all anthropic models', () => {
        const models = findModelsByProvider('anthropic');
        expect(models.length).toBeGreaterThanOrEqual(2);
        expect(models.every((m) => m.provider === 'anthropic')).toBe(true);
    });

    it('returns all together models', () => {
        const models = findModelsByProvider('together');
        expect(models.length).toBe(3);
        expect(models.every((m) => m.provider === 'together')).toBe(true);
    });

    it('returns all fireworks models', () => {
        const models = findModelsByProvider('fireworks');
        expect(models.length).toBe(2);
        expect(models.every((m) => m.provider === 'fireworks')).toBe(true);
    });

    it('returns empty array for unknown provider', () => {
        expect(findModelsByProvider('nonexistent')).toEqual([]);
    });
});

// ─── findModelsByCapability ─────────────────────────────

describe('findModelsByCapability', () => {
    it('finds models with code capability', () => {
        const models = findModelsByCapability('code');
        expect(models.length).toBeGreaterThan(5);
        expect(models.every((m) => m.capabilities.includes('code'))).toBe(true);
    });

    it('finds models with creative capability', () => {
        const models = findModelsByCapability('creative');
        expect(models.length).toBeGreaterThan(0);
        expect(models.every((m) => m.capabilities.includes('creative'))).toBe(true);
    });

    it('finds models with multilingual capability', () => {
        const models = findModelsByCapability('multilingual');
        expect(models.length).toBeGreaterThan(5);
    });

    it('reasoning capability includes most models', () => {
        const models = findModelsByCapability('reasoning');
        expect(models.length).toBeGreaterThan(10);
    });
});
