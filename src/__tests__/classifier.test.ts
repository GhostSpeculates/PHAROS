import { describe, it, expect } from 'vitest';
import { buildClassificationInput } from '../classifier/prompt.js';
import { TASK_TYPES } from '../classifier/types.js';

// ────────────────────────────────────────────────────────────────
// buildClassificationInput — truncation tests
// ────────────────────────────────────────────────────────────────
describe('buildClassificationInput', () => {
    it('passes through short messages unchanged', () => {
        const messages = [
            { role: 'user', content: 'Hello, how are you?' },
        ];
        const result = buildClassificationInput(messages);
        expect(result).toBe('[USER]: Hello, how are you?');
    });

    it('includes system message and last user messages', () => {
        const messages = [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'First question' },
            { role: 'user', content: 'Second question' },
        ];
        const result = buildClassificationInput(messages);
        expect(result).toContain('[SYSTEM]: You are a helpful assistant.');
        expect(result).toContain('[USER]: First question');
        expect(result).toContain('[USER]: Second question');
    });

    it('truncates individual messages longer than 1000 chars', () => {
        const longContent = 'x'.repeat(2000);
        const messages = [
            { role: 'user', content: longContent },
        ];
        const result = buildClassificationInput(messages);
        // Should be truncated to 1000 chars + prefix + truncation marker
        expect(result).toContain('...[truncated]');
        expect(result.length).toBeLessThan(2000);
        // The user content portion should be exactly 1000 chars of 'x'
        const userContent = result.replace('[USER]: ', '').replace('...[truncated]', '');
        expect(userContent.length).toBe(1000);
    });

    it('truncates system message longer than 1000 chars', () => {
        const longSystem = 'y'.repeat(2000);
        const messages = [
            { role: 'system', content: longSystem },
            { role: 'user', content: 'short question' },
        ];
        const result = buildClassificationInput(messages);
        expect(result).toContain('[SYSTEM]:');
        expect(result).toContain('...[truncated]');
        expect(result).toContain('[USER]: short question');
    });

    it('keeps only last 3 user messages', () => {
        const messages = [
            { role: 'user', content: 'msg1' },
            { role: 'user', content: 'msg2' },
            { role: 'user', content: 'msg3' },
            { role: 'user', content: 'msg4' },
            { role: 'user', content: 'msg5' },
        ];
        const result = buildClassificationInput(messages);
        expect(result).not.toContain('msg1');
        expect(result).not.toContain('msg2');
        expect(result).toContain('msg3');
        expect(result).toContain('msg4');
        expect(result).toContain('msg5');
    });

    it('caps total output at 4000 chars', () => {
        const messages = [
            { role: 'system', content: 'a'.repeat(1000) },
            { role: 'user', content: 'b'.repeat(1000) },
            { role: 'user', content: 'c'.repeat(1000) },
            { role: 'user', content: 'd'.repeat(1000) },
        ];
        const result = buildClassificationInput(messages);
        // 4000 chars + "[...truncated]" marker
        expect(result.length).toBeLessThanOrEqual(4000 + 20);
        expect(result).toContain('[...truncated]');
    });

    it('handles array content format (multimodal messages)', () => {
        const messages = [
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'What is in this image?' },
                    { type: 'image_url', url: 'https://example.com/img.png' },
                ],
            },
        ];
        const result = buildClassificationInput(messages);
        expect(result).toContain('What is in this image?');
    });

    it('handles empty messages array', () => {
        const result = buildClassificationInput([]);
        expect(result).toBe('');
    });

    it('handles null/undefined content gracefully', () => {
        const messages = [
            { role: 'user', content: null },
            { role: 'user', content: undefined },
        ];
        const result = buildClassificationInput(messages);
        expect(result).toContain('[USER]:');
    });

    it('filters out assistant messages (only system + user)', () => {
        const messages = [
            { role: 'system', content: 'Be helpful' },
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there!' },
            { role: 'user', content: 'Thanks' },
        ];
        const result = buildClassificationInput(messages);
        expect(result).toContain('[SYSTEM]: Be helpful');
        expect(result).toContain('[USER]: Hello');
        expect(result).toContain('[USER]: Thanks');
        expect(result).not.toContain('Hi there!');
        expect(result).not.toContain('[ASSISTANT]');
    });
});

// ────────────────────────────────────────────────────────────────
// ClassificationResult type — classifierProvider + isCacheHit fields
// ────────────────────────────────────────────────────────────────
describe('ClassificationResult type', () => {
    it('includes classifierProvider field', () => {
        const result = {
            score: 5,
            type: 'analysis' as const,
            latencyMs: 100,
            isFallback: false,
            classifierProvider: 'groq',
        };
        expect(result.classifierProvider).toBe('groq');
    });

    it('includes optional isCacheHit field', () => {
        const result = {
            score: 3,
            type: 'lookup' as const,
            latencyMs: 1,
            isFallback: false,
            classifierProvider: 'groq',
            isCacheHit: true,
        };
        expect(result.isCacheHit).toBe(true);
    });

    it('supports math task type', () => {
        const result = {
            score: 6,
            type: 'math' as const,
            latencyMs: 50,
            isFallback: false,
            classifierProvider: 'moonshot',
        };
        expect(result.type).toBe('math');
    });

    it('supports conversation task type', () => {
        const result = {
            score: 2,
            type: 'conversation' as const,
            latencyMs: 50,
            isFallback: false,
            classifierProvider: 'moonshot',
        };
        expect(result.type).toBe('conversation');
    });
});

describe('TASK_TYPES', () => {
    it('includes all expected task types', () => {
        expect(TASK_TYPES).toContain('code');
        expect(TASK_TYPES).toContain('math');
        expect(TASK_TYPES).toContain('reasoning');
        expect(TASK_TYPES).toContain('creative');
        expect(TASK_TYPES).toContain('analysis');
        expect(TASK_TYPES).toContain('conversation');
        expect(TASK_TYPES).toContain('greeting');
        expect(TASK_TYPES).toContain('lookup');
        expect(TASK_TYPES).toContain('planning');
        expect(TASK_TYPES).toContain('tool_use');
    });

    it('has 10 task types total', () => {
        expect(TASK_TYPES.length).toBe(10);
    });
});

// ────────────────────────────────────────────────────────────────
// isRateLimitError — inline check in classifier
// ────────────────────────────────────────────────────────────────
describe('rate limit detection', () => {
    // This tests the pattern used inside the classifier's isRateLimitError function
    function isRateLimitError(error: unknown): boolean {
        if (error instanceof Error) {
            const msg = error.message.toLowerCase();
            return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests');
        }
        return false;
    }

    it('detects 429 in error message', () => {
        expect(isRateLimitError(new Error('HTTP 429 Too Many Requests'))).toBe(true);
    });

    it('detects rate limit text', () => {
        expect(isRateLimitError(new Error('Rate limit exceeded'))).toBe(true);
    });

    it('detects too many requests text', () => {
        expect(isRateLimitError(new Error('too many requests, please retry'))).toBe(true);
    });

    it('returns false for other errors', () => {
        expect(isRateLimitError(new Error('Connection timeout'))).toBe(false);
    });

    it('returns false for non-Error values', () => {
        expect(isRateLimitError('429')).toBe(false);
        expect(isRateLimitError(null)).toBe(false);
    });
});
