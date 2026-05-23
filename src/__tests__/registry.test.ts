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
    'embedding', 'tts', 'stt', 'image', 'video',
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
    it('finds claude-sonnet by provider and id', () => {
        const model = findModel('anthropic', 'claude-sonnet-4-20250514');
        expect(model).toBeDefined();
        expect(model!.displayName).toBe('Claude Sonnet 4');
        expect(model!.speed).toBe('medium');
    });

    it('finds gpt-4o', () => {
        const model = findModel('openai', 'gpt-4o');
        expect(model).toBeDefined();
        expect(model!.contextWindow).toBe(128_000);
    });

    it('returns undefined for together (not in static seed)', () => {
        const model = findModel('together', 'meta-llama/Llama-3.3-70B-Instruct-Turbo');
        expect(model).toBeUndefined();
    });

    it('returns undefined for fireworks (not in static seed)', () => {
        const model = findModel('fireworks', 'accounts/fireworks/models/llama-v3p3-70b-instruct');
        expect(model).toBeUndefined();
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
    it('returns anthropic models from static seed', () => {
        const models = findModelsByProvider('anthropic');
        expect(models.length).toBeGreaterThanOrEqual(1);
        expect(models.every((m) => m.provider === 'anthropic')).toBe(true);
    });

    it('returns empty array for together (not in static seed)', () => {
        const models = findModelsByProvider('together');
        expect(models.length).toBe(0);
    });

    it('returns empty array for fireworks (not in static seed)', () => {
        const models = findModelsByProvider('fireworks');
        expect(models.length).toBe(0);
    });

    it('returns empty array for unknown provider', () => {
        expect(findModelsByProvider('nonexistent')).toEqual([]);
    });
});

// ─── findModelsByCapability ─────────────────────────────

describe('findModelsByCapability', () => {
    it('finds models with conversation capability (static seed default)', () => {
        const models = findModelsByCapability('conversation');
        expect(models.length).toBe(MODEL_REGISTRY.length);
        expect(models.every((m) => m.capabilities.includes('conversation'))).toBe(true);
    });

    it('returns empty for code capability (static seed uses conversation only)', () => {
        expect(findModelsByCapability('code').length).toBe(0);
    });

    it('returns empty for creative capability (static seed uses conversation only)', () => {
        expect(findModelsByCapability('creative').length).toBe(0);
    });

    it('returns empty for multilingual capability (static seed uses conversation only)', () => {
        expect(findModelsByCapability('multilingual').length).toBe(0);
    });
});
