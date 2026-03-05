import { describe, it, expect } from 'vitest';
import { enhancePrompt } from '../router/prompt-enhancer.js';
import type { ChatMessage } from '../providers/types.js';
import type { PharosConfig, TierName } from '../config/schema.js';
import type { TaskType } from '../classifier/types.js';

// ─── Helpers ─────────────────────────────────────────────

function makeConfig(overrides?: Partial<any>): PharosConfig {
    return {
        server: { port: 3777, host: '0.0.0.0' },
        auth: { apiKey: '' },
        classifier: {
            providers: [],
            fallbackTier: 'economical',
            timeoutMs: 3000,
            maxConcurrent: 5,
            cacheMaxSize: 100,
            cacheTtlMs: 30000,
        },
        tiers: {
            free: { scoreRange: [1, 3], models: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }] },
            economical: { scoreRange: [4, 6], models: [{ provider: 'deepseek', model: 'deepseek-chat' }] },
            premium: { scoreRange: [7, 8], models: [{ provider: 'anthropic', model: 'claude-sonnet-4-20250514' }] },
            frontier: { scoreRange: [9, 10], models: [{ provider: 'anthropic', model: 'claude-opus-4-20250514' }] },
        },
        providers: {},
        agents: {},
        alerts: {},
        router: { oversizedThresholdTokens: 100000 },
        taskAffinity: {},
        spending: { dailyLimit: null, monthlyLimit: null },
        promptEnhancement: { enabled: true, excludeTiers: ['premium', 'frontier'], hints: {} },
        conversation: { enabled: true, maxConversations: 500, conversationTtlMs: 1800000 },
        tracking: {
            enabled: true,
            dbPath: './data/pharos.db',
            baselineModel: 'claude-sonnet-4-20250514',
            baselineCostPerMillionInput: 3.0,
            baselineCostPerMillionOutput: 15.0,
            retentionDays: 30,
        },
        logging: { level: 'info', pretty: true },
        ...overrides,
    } as unknown as PharosConfig;
}

function makeMessages(system?: string, user?: string): ChatMessage[] {
    const msgs: ChatMessage[] = [];
    if (system) msgs.push({ role: 'system', content: system });
    if (user) msgs.push({ role: 'user', content: user ?? 'Hello' });
    return msgs;
}

// ─── Tests ───────────────────────────────────────────────

describe('enhancePrompt', () => {
    const config = makeConfig();

    describe('activation rules', () => {
        it('enhances free tier code tasks', () => {
            const result = enhancePrompt(
                makeMessages('You are a helpful assistant.', 'Write a function'),
                'code', 'free', config,
            );
            expect(result.enhanced).toBe(true);
            expect(result.hint).toBeDefined();
        });

        it('enhances economical tier reasoning tasks', () => {
            const result = enhancePrompt(
                makeMessages('You are a helpful assistant.', 'Solve this'),
                'reasoning', 'economical', config,
            );
            expect(result.enhanced).toBe(true);
        });

        it('does NOT enhance premium tier', () => {
            const result = enhancePrompt(
                makeMessages('System', 'Code task'),
                'code', 'premium', config,
            );
            expect(result.enhanced).toBe(false);
        });

        it('does NOT enhance frontier tier', () => {
            const result = enhancePrompt(
                makeMessages('System', 'Code task'),
                'code', 'frontier', config,
            );
            expect(result.enhanced).toBe(false);
        });

        it('skips greeting task type', () => {
            const result = enhancePrompt(
                makeMessages('System', 'Hi!'),
                'greeting', 'free', config,
            );
            expect(result.enhanced).toBe(false);
        });

        it('skips lookup task type', () => {
            const result = enhancePrompt(
                makeMessages('System', 'What time is it?'),
                'lookup', 'free', config,
            );
            expect(result.enhanced).toBe(false);
        });
    });

    describe('hint content per task type', () => {
        const taskTypes: TaskType[] = ['code', 'reasoning', 'math', 'analysis', 'planning', 'creative', 'conversation', 'tool_use'];

        for (const taskType of taskTypes) {
            it(`provides a hint for ${taskType}`, () => {
                const result = enhancePrompt(
                    makeMessages('System prompt.', 'User message.'),
                    taskType, 'free', config,
                );
                expect(result.enhanced).toBe(true);
                expect(result.hint).toBeTruthy();
                expect(result.hint!.length).toBeGreaterThan(10);
            });
        }
    });

    describe('message mutation safety', () => {
        it('never mutates the original messages array', () => {
            const original: ChatMessage[] = [
                { role: 'system', content: 'Original system message.' },
                { role: 'user', content: 'Write some code.' },
            ];
            const originalCopy = JSON.parse(JSON.stringify(original));

            enhancePrompt(original, 'code', 'free', config);

            expect(original).toEqual(originalCopy);
        });

        it('returns a new array reference when enhanced', () => {
            const original = makeMessages('System', 'Write code');
            const result = enhancePrompt(original, 'code', 'free', config);
            expect(result.messages).not.toBe(original);
        });

        it('returns the original array reference when not enhanced', () => {
            const original = makeMessages('System', 'Hi');
            const result = enhancePrompt(original, 'greeting', 'free', config);
            expect(result.messages).toBe(original);
        });
    });

    describe('system message handling', () => {
        it('appends hint to existing system message', () => {
            const result = enhancePrompt(
                makeMessages('You are a helpful assistant.', 'Write code'),
                'code', 'free', config,
            );
            expect(result.enhanced).toBe(true);
            const systemMsg = result.messages.find(m => m.role === 'system');
            expect(systemMsg).toBeDefined();
            expect(typeof systemMsg!.content).toBe('string');
            expect((systemMsg!.content as string)).toContain('You are a helpful assistant.');
            expect((systemMsg!.content as string)).toContain('Think step by step');
        });

        it('creates a system message when none exists', () => {
            const result = enhancePrompt(
                [{ role: 'user', content: 'Write code' }],
                'code', 'free', config,
            );
            expect(result.enhanced).toBe(true);
            expect(result.messages[0].role).toBe('system');
            expect((result.messages[0].content as string)).toContain('Think step by step');
        });

        it('separates existing content from hint with double newline', () => {
            const result = enhancePrompt(
                makeMessages('Original system.', 'Code'),
                'code', 'free', config,
            );
            const content = result.messages.find(m => m.role === 'system')!.content as string;
            expect(content).toBe('Original system.\n\nThink step by step. Consider edge cases and error handling. Write clean, well-documented code.');
        });
    });

    describe('config overrides', () => {
        it('respects enabled=false', () => {
            const disabledConfig = makeConfig({
                promptEnhancement: { enabled: false, excludeTiers: ['premium', 'frontier'], hints: {} },
            });
            const result = enhancePrompt(
                makeMessages('System', 'Code'),
                'code', 'free', disabledConfig,
            );
            expect(result.enhanced).toBe(false);
        });

        it('uses custom hints from config', () => {
            const customConfig = makeConfig({
                promptEnhancement: {
                    enabled: true,
                    excludeTiers: ['premium', 'frontier'],
                    hints: { code: 'CUSTOM CODE HINT' },
                },
            });
            const result = enhancePrompt(
                makeMessages('System', 'Code'),
                'code', 'free', customConfig,
            );
            expect(result.enhanced).toBe(true);
            expect(result.hint).toBe('CUSTOM CODE HINT');
        });

        it('allows including premium tier if not in excludeTiers', () => {
            const includeAllConfig = makeConfig({
                promptEnhancement: { enabled: true, excludeTiers: [], hints: {} },
            });
            const result = enhancePrompt(
                makeMessages('System', 'Code'),
                'code', 'premium', includeAllConfig,
            );
            expect(result.enhanced).toBe(true);
        });

        it('respects custom excludeTiers', () => {
            const customConfig = makeConfig({
                promptEnhancement: {
                    enabled: true,
                    excludeTiers: ['free', 'economical', 'premium', 'frontier'],
                    hints: {},
                },
            });
            const result = enhancePrompt(
                makeMessages('System', 'Code'),
                'code', 'free', customConfig,
            );
            expect(result.enhanced).toBe(false);
        });
    });

    describe('edge cases', () => {
        it('handles empty messages array', () => {
            const result = enhancePrompt([], 'code', 'free', config);
            expect(result.enhanced).toBe(true);
            expect(result.messages).toHaveLength(1);
            expect(result.messages[0].role).toBe('system');
        });

        it('handles system message with empty string content', () => {
            const result = enhancePrompt(
                [{ role: 'system', content: '' }, { role: 'user', content: 'Code' }],
                'code', 'free', config,
            );
            expect(result.enhanced).toBe(true);
            const system = result.messages.find(m => m.role === 'system')!;
            expect((system.content as string)).toContain('Think step by step');
        });

        it('handles config without promptEnhancement section (uses defaults)', () => {
            const bareConfig = { ...config } as any;
            delete bareConfig.promptEnhancement;
            const result = enhancePrompt(
                makeMessages('System', 'Code'),
                'code', 'free', bareConfig,
            );
            // With no config section, defaults apply (enabled, exclude premium/frontier)
            expect(result.enhanced).toBe(true);
        });

        it('handles system message with array content (treats as empty string)', () => {
            const msgs: ChatMessage[] = [
                { role: 'system', content: [{ type: 'text', text: 'System text' }] },
                { role: 'user', content: 'Code' },
            ];
            const result = enhancePrompt(msgs, 'code', 'free', config);
            expect(result.enhanced).toBe(true);
        });
    });
});
