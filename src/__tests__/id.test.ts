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
// generateRequestId (UUID v4)
// ────────────────────────────────────────────────────────────────
describe('generateRequestId', () => {
    const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    it('returns a valid UUID v4', () => {
        const id = generateRequestId();
        expect(id).toMatch(UUID_V4_REGEX);
    });

    it('is 36 characters long (UUID format)', () => {
        const id = generateRequestId();
        expect(id).toHaveLength(36);
    });

    it('generates unique IDs (100 IDs, all different)', () => {
        const ids = new Set<string>();
        for (let i = 0; i < 100; i++) {
            ids.add(generateRequestId());
        }
        expect(ids.size).toBe(100);
    });

    it('version nibble is always 4 (UUID v4)', () => {
        for (let i = 0; i < 20; i++) {
            const id = generateRequestId();
            // The 15th character (0-indexed 14) should be '4'
            expect(id[14]).toBe('4');
        }
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
        const urlSafePattern = /^[A-Za-z0-9_-]+$/;
        const uuidSafePattern = /^[0-9a-f-]+$/;
        for (let i = 0; i < 20; i++) {
            const completionSuffix = generateCompletionId().replace('chatcmpl-', '');
            const requestId = generateRequestId();
            expect(completionSuffix).toMatch(urlSafePattern);
            expect(requestId).toMatch(uuidSafePattern);
        }
    });
});
