import { describe, expect, it } from 'vitest';
import { anthropicToOpenAI } from '../translation/anthropic-openai.js';
import { openAIToAnthropic } from '../translation/anthropic-openai.js';
import type { AnthropicMessagesRequest } from '../translation/types.js';

describe('anthropicToOpenAI', () => {
    it('translates a text-only request', () => {
        const req: AnthropicMessagesRequest = {
            model: 'pharos-auto:scout',
            max_tokens: 200,
            messages: [{ role: 'user', content: 'Say hi in 5 words' }],
            stream: false,
        };
        const out = anthropicToOpenAI(req);
        expect(out.model).toBe('pharos-auto:scout');
        expect(out.max_tokens).toBe(200);
        expect(out.messages).toEqual([{ role: 'user', content: 'Say hi in 5 words' }]);
        expect(out.stream).toBe(false);
    });

    it('preserves the agent-id colon syntax in the model field', () => {
        const req: AnthropicMessagesRequest = {
            model: 'pharos-auto:scout',
            max_tokens: 100,
            messages: [{ role: 'user', content: 'hi' }],
            stream: false,
        };
        expect(anthropicToOpenAI(req).model).toBe('pharos-auto:scout');
    });

    it('prepends a string system prompt as a system message', () => {
        const req: AnthropicMessagesRequest = {
            model: 'pharos-auto',
            max_tokens: 100,
            system: 'You are Scout.',
            messages: [{ role: 'user', content: 'hi' }],
            stream: false,
        };
        const out = anthropicToOpenAI(req);
        expect(out.messages[0]).toEqual({ role: 'system', content: 'You are Scout.' });
        expect(out.messages[1]).toEqual({ role: 'user', content: 'hi' });
    });

    it('joins an array system prompt into a single system message', () => {
        const req: AnthropicMessagesRequest = {
            model: 'pharos-auto',
            max_tokens: 100,
            system: [
                { type: 'text', text: 'You are Scout.' },
                { type: 'text', text: 'Be concise.' },
            ],
            messages: [{ role: 'user', content: 'hi' }],
            stream: false,
        };
        const out = anthropicToOpenAI(req);
        expect(out.messages[0]).toEqual({
            role: 'system',
            content: 'You are Scout.\n\nBe concise.',
        });
    });

    it('translates text content blocks to a string', () => {
        const req: AnthropicMessagesRequest = {
            model: 'pharos-auto',
            max_tokens: 100,
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hi there' }] }],
            stream: false,
        };
        const out = anthropicToOpenAI(req);
        expect(out.messages[0].content).toBe('hi there');
    });

    it('translates tool_use assistant blocks to OpenAI tool_calls', () => {
        const req: AnthropicMessagesRequest = {
            model: 'pharos-auto',
            max_tokens: 100,
            messages: [
                { role: 'user', content: 'whats the weather?' },
                {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'Let me check.' },
                        {
                            type: 'tool_use',
                            id: 'toolu_abc',
                            name: 'get_weather',
                            input: { location: 'NY' },
                        },
                    ],
                },
            ],
            stream: false,
        };
        const out = anthropicToOpenAI(req);
        expect(out.messages[1]).toEqual({
            role: 'assistant',
            content: 'Let me check.',
            tool_calls: [
                {
                    id: 'toolu_abc',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '{"location":"NY"}' },
                },
            ],
        });
    });

    it('sets content to null when assistant emits only tool_use blocks', () => {
        const req: AnthropicMessagesRequest = {
            model: 'pharos-auto',
            max_tokens: 100,
            messages: [
                { role: 'user', content: 'whats the weather?' },
                {
                    role: 'assistant',
                    content: [
                        {
                            type: 'tool_use',
                            id: 'toolu_xyz',
                            name: 'get_weather',
                            input: { location: 'NY' },
                        },
                    ],
                },
            ],
            stream: false,
        };
        const out = anthropicToOpenAI(req);
        expect(out.messages[1]).toEqual({
            role: 'assistant',
            content: null,
            tool_calls: [
                {
                    id: 'toolu_xyz',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '{"location":"NY"}' },
                },
            ],
        });
    });

    it('translates tool_result user blocks to OpenAI tool messages', () => {
        const req: AnthropicMessagesRequest = {
            model: 'pharos-auto',
            max_tokens: 100,
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: 'toolu_abc',
                            content: '72°F sunny',
                        },
                    ],
                },
            ],
            stream: false,
        };
        const out = anthropicToOpenAI(req);
        expect(out.messages[0]).toEqual({
            role: 'tool',
            tool_call_id: 'toolu_abc',
            content: '72°F sunny',
        });
    });

    it('emits tool messages before user text in mixed user blocks', () => {
        const req: AnthropicMessagesRequest = {
            model: 'pharos-auto',
            max_tokens: 100,
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: 'toolu_abc',
                            content: '72°F sunny',
                        },
                        { type: 'text', text: 'Thanks. Now what about LA?' },
                    ],
                },
            ],
            stream: false,
        };
        const out = anthropicToOpenAI(req);
        expect(out.messages).toEqual([
            { role: 'tool', tool_call_id: 'toolu_abc', content: '72°F sunny' },
            { role: 'user', content: 'Thanks. Now what about LA?' },
        ]);
    });

    it('translates Anthropic tools[] to OpenAI tools[]', () => {
        const req: AnthropicMessagesRequest = {
            model: 'pharos-auto',
            max_tokens: 100,
            messages: [{ role: 'user', content: 'hi' }],
            tools: [
                {
                    name: 'get_weather',
                    description: 'Look up weather',
                    input_schema: { type: 'object', properties: { location: { type: 'string' } } },
                },
            ],
            stream: false,
        };
        const out = anthropicToOpenAI(req);
        expect(out.tools).toEqual([
            {
                type: 'function',
                function: {
                    name: 'get_weather',
                    description: 'Look up weather',
                    parameters: { type: 'object', properties: { location: { type: 'string' } } },
                },
            },
        ]);
    });

    it('translates tool_choice variants', () => {
        const base = {
            model: 'pharos-auto',
            max_tokens: 100,
            messages: [{ role: 'user' as const, content: 'hi' }],
            stream: false,
        };
        expect(anthropicToOpenAI({ ...base, tool_choice: { type: 'auto' } }).tool_choice).toBe('auto');
        expect(anthropicToOpenAI({ ...base, tool_choice: { type: 'any' } }).tool_choice).toBe('required');
        expect(anthropicToOpenAI({ ...base, tool_choice: { type: 'none' } }).tool_choice).toBe('none');
        expect(
            anthropicToOpenAI({ ...base, tool_choice: { type: 'tool', name: 'get_weather' } }).tool_choice,
        ).toEqual({ type: 'function', function: { name: 'get_weather' } });
    });

    it('passes through stream, temperature, top_p, stop_sequences, thinking', () => {
        const req: AnthropicMessagesRequest = {
            model: 'pharos-auto',
            max_tokens: 100,
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
            temperature: 0.7,
            top_p: 0.9,
            stop_sequences: ['STOP'],
            thinking: { type: 'enabled', budget_tokens: 1000 },
        };
        const out = anthropicToOpenAI(req);
        expect(out.stream).toBe(true);
        expect(out.temperature).toBe(0.7);
        expect(out.top_p).toBe(0.9);
        expect(out.stop).toEqual(['STOP']);
        expect(out.thinking).toEqual({ type: 'enabled', budget_tokens: 1000 });
    });
});

describe('openAIToAnthropic', () => {
    it('translates a text-only response', () => {
        const out = openAIToAnthropic(
            {
                id: 'chatcmpl-123',
                choices: [
                    {
                        index: 0,
                        message: { role: 'assistant', content: 'Hi, friend.' },
                        finish_reason: 'stop',
                    },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
                model: 'gpt-4o',
            },
            'pharos-auto:scout',
        );
        expect(out.type).toBe('message');
        expect(out.role).toBe('assistant');
        expect(out.content).toEqual([{ type: 'text', text: 'Hi, friend.' }]);
        expect(out.stop_reason).toBe('end_turn');
        expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 4 });
        expect(out.model).toBe('pharos-auto:scout');
    });

    it('translates a tool_calls response', () => {
        const out = openAIToAnthropic(
            {
                id: 'chatcmpl-456',
                choices: [
                    {
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: 'Let me check.',
                            tool_calls: [
                                {
                                    id: 'call_xyz',
                                    type: 'function',
                                    function: {
                                        name: 'get_weather',
                                        arguments: '{"location":"NY"}',
                                    },
                                },
                            ],
                        },
                        finish_reason: 'tool_calls',
                    },
                ],
                usage: { prompt_tokens: 50, completion_tokens: 12, total_tokens: 62 },
                model: 'claude-sonnet',
            },
            'pharos-auto',
        );
        expect(out.content).toEqual([
            { type: 'text', text: 'Let me check.' },
            {
                type: 'tool_use',
                id: 'call_xyz',
                name: 'get_weather',
                input: { location: 'NY' },
            },
        ]);
        expect(out.stop_reason).toBe('tool_use');
    });

    it('handles tool_calls with no text content', () => {
        const out = openAIToAnthropic(
            {
                id: 'chatcmpl-789',
                choices: [
                    {
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: null,
                            tool_calls: [
                                {
                                    id: 'call_only',
                                    type: 'function',
                                    function: { name: 'lookup', arguments: '{}' },
                                },
                            ],
                        },
                        finish_reason: 'tool_calls',
                    },
                ],
                usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
                model: 'm',
            },
            'pharos-auto',
        );
        expect(out.content).toEqual([
            { type: 'tool_use', id: 'call_only', name: 'lookup', input: {} },
        ]);
    });

    it('returns empty input object for malformed tool argument JSON', () => {
        const out = openAIToAnthropic(
            {
                id: 'chatcmpl-bad',
                choices: [
                    {
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: null,
                            tool_calls: [
                                {
                                    id: 'call_bad',
                                    type: 'function',
                                    function: { name: 'broken', arguments: '{not valid json' },
                                },
                            ],
                        },
                        finish_reason: 'tool_calls',
                    },
                ],
                usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
                model: 'm',
            },
            'pharos-auto',
        );
        expect((out.content[0] as any).input).toEqual({});
    });

    it('maps finish_reason values correctly', () => {
        const base = {
            id: 'x',
            choices: [
                {
                    index: 0,
                    message: { role: 'assistant' as const, content: 'x' },
                    finish_reason: 'stop',
                },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            model: 'm',
        };
        expect(openAIToAnthropic({ ...base }, 'm').stop_reason).toBe('end_turn');
        expect(
            openAIToAnthropic(
                { ...base, choices: [{ ...base.choices[0], finish_reason: 'length' }] },
                'm',
            ).stop_reason,
        ).toBe('max_tokens');
        expect(
            openAIToAnthropic(
                { ...base, choices: [{ ...base.choices[0], finish_reason: 'tool_calls' }] },
                'm',
            ).stop_reason,
        ).toBe('tool_use');
        expect(
            openAIToAnthropic(
                { ...base, choices: [{ ...base.choices[0], finish_reason: 'stop_sequence' }] },
                'm',
            ).stop_reason,
        ).toBe('stop_sequence');
    });

    it('round-trips: anthropicToOpenAI(req) then openAIToAnthropic(resp) preserves shape', () => {
        const req: AnthropicMessagesRequest = {
            model: 'pharos-auto:scout',
            max_tokens: 100,
            messages: [{ role: 'user', content: 'hi' }],
            stream: false,
        };
        const oReq = anthropicToOpenAI(req);
        const oResp = {
            id: 'chatcmpl-rt',
            choices: [
                {
                    index: 0,
                    message: { role: 'assistant' as const, content: 'hello' },
                    finish_reason: 'stop',
                },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
            model: oReq.model,
        };
        const aResp = openAIToAnthropic(oResp, req.model);
        expect(aResp.role).toBe('assistant');
        expect(aResp.content[0]).toEqual({ type: 'text', text: 'hello' });
    });

    it('throws a clear error when choices is empty', () => {
        const resp = {
            id: 'chatcmpl-empty',
            choices: [],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            model: 'm',
        };
        expect(() => openAIToAnthropic(resp, 'pharos-auto')).toThrow(/no choices/);
    });
});
