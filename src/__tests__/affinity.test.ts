import { describe, it, expect } from 'vitest';
import { sortByAffinity, DEFAULT_TASK_AFFINITY } from '../router/affinity.js';
import type { ModelCandidate } from '../router/failover.js';

// ─── Helpers ─────────────────────────────────────────────

function candidate(provider: string, model: string, tier: string): ModelCandidate {
    return { provider, model, tier } as ModelCandidate;
}

// ─── DEFAULT_TASK_AFFINITY ───────────────────────────────

describe('DEFAULT_TASK_AFFINITY', () => {
    it('has preferences for code tasks', () => {
        expect(DEFAULT_TASK_AFFINITY.code).toBeDefined();
        expect(DEFAULT_TASK_AFFINITY.code.length).toBeGreaterThan(0);
        expect(DEFAULT_TASK_AFFINITY.code[0]).toBe('deepseek');
    });

    it('has preferences for math tasks', () => {
        expect(DEFAULT_TASK_AFFINITY.math).toBeDefined();
        expect(DEFAULT_TASK_AFFINITY.math[0]).toBe('together');
    });

    it('has preferences for reasoning tasks', () => {
        expect(DEFAULT_TASK_AFFINITY.reasoning[0]).toBe('anthropic');
    });

    it('has preferences for creative tasks', () => {
        expect(DEFAULT_TASK_AFFINITY.creative[0]).toBe('anthropic');
    });

    it('has preferences for conversation tasks', () => {
        expect(DEFAULT_TASK_AFFINITY.conversation[0]).toBe('groq');
    });

    it('has preferences for analysis tasks', () => {
        expect(DEFAULT_TASK_AFFINITY.analysis[0]).toBe('deepseek');
    });

    it('has empty preferences for greeting (no affinity)', () => {
        expect(DEFAULT_TASK_AFFINITY.greeting).toEqual([]);
    });

    it('has empty preferences for lookup (no affinity)', () => {
        expect(DEFAULT_TASK_AFFINITY.lookup).toEqual([]);
    });
});

// ─── sortByAffinity ──────────────────────────────────────

describe('sortByAffinity', () => {
    const affinityMap = {
        code: ['deepseek', 'together', 'anthropic'],
        math: ['together', 'openai'],
        greeting: [],
    };

    it('moves preferred provider to front within a tier', () => {
        const candidates = [
            candidate('anthropic', 'claude-sonnet', 'premium'),
            candidate('openai', 'gpt-4o', 'premium'),
            candidate('deepseek', 'deepseek-chat', 'premium'),
        ];

        const sorted = sortByAffinity(candidates, 'code', affinityMap);

        expect(sorted[0].provider).toBe('deepseek');
        expect(sorted[1].provider).toBe('anthropic');
        expect(sorted[2].provider).toBe('openai');
    });

    it('preserves tier ordering across different tiers', () => {
        const candidates = [
            candidate('anthropic', 'claude-sonnet', 'premium'),
            candidate('openai', 'gpt-4o', 'premium'),
            candidate('groq', 'llama', 'free'),
            candidate('deepseek', 'deepseek-chat', 'free'),
        ];

        const sorted = sortByAffinity(candidates, 'code', affinityMap);

        // Premium tier candidates should still come before free tier
        expect(sorted[0].tier).toBe('premium');
        expect(sorted[1].tier).toBe('premium');
        // Within premium, anthropic preferred for code
        expect(sorted[0].provider).toBe('anthropic');
        // Free tier after premium
        expect(sorted[2].tier).toBe('free');
        // Within free, deepseek preferred for code
        expect(sorted[2].provider).toBe('deepseek');
    });

    it('returns original order when task type has no affinity', () => {
        const candidates = [
            candidate('anthropic', 'claude-sonnet', 'premium'),
            candidate('openai', 'gpt-4o', 'premium'),
        ];

        const sorted = sortByAffinity(candidates, 'greeting', affinityMap);
        expect(sorted).toEqual(candidates);
    });

    it('returns original order for unknown task type', () => {
        const candidates = [
            candidate('anthropic', 'claude-sonnet', 'premium'),
            candidate('openai', 'gpt-4o', 'premium'),
        ];

        const sorted = sortByAffinity(candidates, 'unknown_type', affinityMap);
        expect(sorted).toEqual(candidates);
    });

    it('handles empty candidate list', () => {
        const sorted = sortByAffinity([], 'code', affinityMap);
        expect(sorted).toEqual([]);
    });

    it('handles single candidate', () => {
        const candidates = [candidate('openai', 'gpt-4o', 'premium')];
        const sorted = sortByAffinity(candidates, 'code', affinityMap);
        expect(sorted).toEqual(candidates);
    });

    it('non-preferred providers keep original relative order', () => {
        const candidates = [
            candidate('google', 'gemini', 'economical'),
            candidate('mistral', 'mistral-large', 'economical'),
            candidate('deepseek', 'deepseek-chat', 'economical'),
        ];

        const sorted = sortByAffinity(candidates, 'code', affinityMap);

        // deepseek preferred, so it goes first
        expect(sorted[0].provider).toBe('deepseek');
        // google and mistral keep their relative order
        expect(sorted[1].provider).toBe('google');
        expect(sorted[2].provider).toBe('mistral');
    });

    it('sorts math tasks with together first', () => {
        const candidates = [
            candidate('anthropic', 'claude-sonnet', 'premium'),
            candidate('openai', 'gpt-4o', 'premium'),
            candidate('together', 'qwen', 'premium'),
        ];

        const sorted = sortByAffinity(candidates, 'math', affinityMap);

        expect(sorted[0].provider).toBe('together');
        expect(sorted[1].provider).toBe('openai');
        expect(sorted[2].provider).toBe('anthropic');
    });

    it('works with DEFAULT_TASK_AFFINITY', () => {
        const candidates = [
            candidate('anthropic', 'claude', 'economical'),
            candidate('deepseek', 'deepseek-chat', 'economical'),
            candidate('together', 'deepseek-v3', 'economical'),
        ];

        const sorted = sortByAffinity(candidates, 'code', DEFAULT_TASK_AFFINITY);

        // For code: deepseek first, then together, then anthropic
        expect(sorted[0].provider).toBe('deepseek');
        expect(sorted[1].provider).toBe('together');
        expect(sorted[2].provider).toBe('anthropic');
    });

    it('multiple candidates from same preferred provider sorted by affinity', () => {
        const candidates = [
            candidate('openai', 'gpt-4o', 'economical'),
            candidate('together', 'deepseek-v3', 'economical'),
            candidate('together', 'qwen', 'economical'),
            candidate('deepseek', 'deepseek-chat', 'economical'),
        ];

        const sorted = sortByAffinity(candidates, 'code', affinityMap);

        // deepseek first (index 0 in code affinity)
        expect(sorted[0].provider).toBe('deepseek');
        // then both together entries (index 1 in code affinity)
        expect(sorted[1].provider).toBe('together');
        expect(sorted[2].provider).toBe('together');
        // then openai (not in code affinity)
        expect(sorted[3].provider).toBe('openai');
    });
});
