import { describe, it, expect } from 'vitest';
import { isMemoryFlush } from '../utils/flush-detector.js';
import type { ChatMessage } from '../providers/types.js';

describe('isMemoryFlush', () => {
    // ─── Positive matches ───────────────────────────────────

    it('detects "Write any lasting notes" pattern', () => {
        const messages: ChatMessage[] = [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Write any lasting notes about this conversation to memory.' },
        ];
        expect(isMemoryFlush(messages)).toBe(true);
    });

    it('detects "save to memory" pattern', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'Please save to memory the important details from our chat.' },
        ];
        expect(isMemoryFlush(messages)).toBe(true);
    });

    it('detects "update memory" pattern', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'Update memory with these findings.' },
        ];
        expect(isMemoryFlush(messages)).toBe(true);
    });

    it('detects "add to memory" pattern', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'Add to memory: the user prefers dark mode.' },
        ];
        expect(isMemoryFlush(messages)).toBe(true);
    });

    it('detects "memory flush" pattern', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'Perform a memory flush now.' },
        ];
        expect(isMemoryFlush(messages)).toBe(true);
    });

    it('detects "save important" pattern', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'Save important information from this session.' },
        ];
        expect(isMemoryFlush(messages)).toBe(true);
    });

    it('detects "lasting notes" pattern', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'Create lasting notes about the project decisions.' },
        ];
        expect(isMemoryFlush(messages)).toBe(true);
    });

    // ─── Case insensitivity ─────────────────────────────────

    it('is case-insensitive', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'WRITE ANY LASTING NOTES about this conversation.' },
        ];
        expect(isMemoryFlush(messages)).toBe(true);
    });

    it('detects mixed case patterns', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'Save To Memory all the details.' },
        ];
        expect(isMemoryFlush(messages)).toBe(true);
    });

    // ─── Only checks last 2 user messages ───────────────────

    it('detects pattern in second-to-last user message', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'Write any lasting notes.' },
            { role: 'assistant', content: 'Sure, I will save notes.' },
            { role: 'user', content: 'Thanks for doing that.' },
        ];
        expect(isMemoryFlush(messages)).toBe(true);
    });

    it('ignores flush patterns in older user messages (beyond last 2)', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'Write any lasting notes.' },
            { role: 'assistant', content: 'Done.' },
            { role: 'user', content: 'Now let us talk about something else.' },
            { role: 'assistant', content: 'Sure.' },
            { role: 'user', content: 'What is the weather today?' },
        ];
        // Only last 2 user messages checked: "Now let us..." and "What is the weather..."
        expect(isMemoryFlush(messages)).toBe(false);
    });

    // ─── Negative matches (no false positives) ──────────────

    it('does not false-positive on normal messages mentioning "memory"', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'How much memory does my server have?' },
        ];
        expect(isMemoryFlush(messages)).toBe(false);
    });

    it('does not match partial pattern "save" alone', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'Please save the file to disk.' },
        ];
        expect(isMemoryFlush(messages)).toBe(false);
    });

    it('does not match "notes" without "lasting"', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'Take notes on this meeting please.' },
        ];
        expect(isMemoryFlush(messages)).toBe(false);
    });

    it('does not match "update" without "memory"', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'Update the database with the new records.' },
        ];
        expect(isMemoryFlush(messages)).toBe(false);
    });

    it('returns false for empty messages array', () => {
        expect(isMemoryFlush([])).toBe(false);
    });

    it('returns false when only system/assistant messages exist', () => {
        const messages: ChatMessage[] = [
            { role: 'system', content: 'Write any lasting notes.' },
            { role: 'assistant', content: 'Save to memory all details.' },
        ];
        expect(isMemoryFlush(messages)).toBe(false);
    });

    // ─── Array content (multimodal) ─────────────────────────

    it('handles array content with text parts', () => {
        const messages: ChatMessage[] = [
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'Write any lasting notes about this session.' },
                ],
            },
        ];
        expect(isMemoryFlush(messages)).toBe(true);
    });

    it('handles array content without flush patterns', () => {
        const messages: ChatMessage[] = [
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'What is quantum computing?' },
                ],
            },
        ];
        expect(isMemoryFlush(messages)).toBe(false);
    });
});
