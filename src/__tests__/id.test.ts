import { describe, it, expect } from 'vitest';
import { generateCompletionId, generateRequestId } from '../utils/id.js';

// ────────────────────────────────────────────────────────────────
// generateCompletionId
// ────────────────────────────────────────────────────────────────
describe('generateCompletionId', () => {
    it('starts with "chatcmpl-"', () => {
        const id = generateCompletionId();
        expect(id.startsWith('chatcmpl-')).toBe(true);
    });

    it('has content after the prefix', () => {
        const id = generateCompletionId();
        const suffix = id.replace('chatcmpl-', '');
        expect(suffix.length).toBeGreaterThan(0);
    });

    it('suffix is exactly 24 characters (nanoid(24))', () => {
        const id = generateCompletionId();
        const suffix = id.replace('chatcmpl-', '');
        expect(suffix).toHaveLength(24);
    });

    it('generates unique IDs (100 IDs, all different)', () => {
        const ids = new Set<string>();
        for (let i = 0; i < 100; i++) {
            ids.add(generateCompletionId());
        }
        expect(ids.size).toBe(100);
    });
});

// ────────────────────────────────────────────────────────────────
// generateRequestId
// ────────────────────────────────────────────────────────────────
describe('generateRequestId', () => {
    it('starts with "req-"', () => {
        const id = generateRequestId();
        expect(id.startsWith('req-')).toBe(true);
    });

    it('has content after the prefix', () => {
        const id = generateRequestId();
        const suffix = id.replace('req-', '');
        expect(suffix.length).toBeGreaterThan(0);
    });

    it('suffix is exactly 16 characters (nanoid(16))', () => {
        const id = generateRequestId();
        const suffix = id.replace('req-', '');
        expect(suffix).toHaveLength(16);
    });

    it('generates unique IDs (100 IDs, all different)', () => {
        const ids = new Set<string>();
        for (let i = 0; i < 100; i++) {
            ids.add(generateRequestId());
        }
        expect(ids.size).toBe(100);
    });
});

// ────────────────────────────────────────────────────────────────
// Cross-function uniqueness
// ────────────────────────────────────────────────────────────────
describe('ID uniqueness across functions', () => {
    it('completion IDs and request IDs never collide', () => {
        const allIds = new Set<string>();
        for (let i = 0; i < 50; i++) {
            allIds.add(generateCompletionId());
            allIds.add(generateRequestId());
        }
        expect(allIds.size).toBe(100);
    });

    it('IDs contain only URL-safe characters', () => {
        // nanoid uses A-Za-z0-9_- by default
        const urlSafePattern = /^[A-Za-z0-9_-]+$/;
        for (let i = 0; i < 20; i++) {
            const completionSuffix = generateCompletionId().replace('chatcmpl-', '');
            const requestSuffix = generateRequestId().replace('req-', '');
            expect(completionSuffix).toMatch(urlSafePattern);
            expect(requestSuffix).toMatch(urlSafePattern);
        }
    });
});
