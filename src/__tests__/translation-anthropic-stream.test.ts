import { describe, expect, it } from 'vitest';
import { AnthropicStreamTranslator } from '../translation/anthropic-stream.js';

describe('AnthropicStreamTranslator', () => {
    it('translates a simple text stream', () => {
        const t = new AnthropicStreamTranslator({
            messageId: 'msg_abc',
            model: 'pharos-auto:scout',
            inputTokens: 10,
        });

        const events: unknown[] = [];

        t.handleDelta({ choices: [{ delta: { role: 'assistant' } }] }).forEach((e) => events.push(e));
        t.handleDelta({ choices: [{ delta: { content: 'Hi' } }] }).forEach((e) => events.push(e));
        t.handleDelta({ choices: [{ delta: { content: ' there' } }] }).forEach((e) => events.push(e));
        t.handleFinish('stop', { promptTokens: 10, completionTokens: 2, totalTokens: 12 }).forEach((e) =>
            events.push(e),
        );

        expect(events[0]).toMatchObject({ type: 'message_start' });
        expect((events[0] as any).message.id).toBe('msg_abc');
        expect((events[0] as any).message.usage.input_tokens).toBe(10);

        expect(events[1]).toEqual({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
        });
        expect(events[2]).toEqual({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Hi' },
        });
        expect(events[3]).toEqual({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: ' there' },
        });
        expect(events[4]).toEqual({ type: 'content_block_stop', index: 0 });
        expect(events[5]).toMatchObject({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 2 },
        });
        expect(events[6]).toEqual({ type: 'message_stop' });
    });

    it('translates a tool_call stream', () => {
        const t = new AnthropicStreamTranslator({
            messageId: 'msg_tool',
            model: 'pharos-auto',
            inputTokens: 50,
        });
        const events: unknown[] = [];

        t.handleDelta({
            choices: [
                {
                    delta: {
                        role: 'assistant',
                        tool_calls: [
                            {
                                index: 0,
                                id: 'call_xyz',
                                type: 'function',
                                function: { name: 'get_weather', arguments: '' },
                            },
                        ],
                    },
                },
            ],
        }).forEach((e) => events.push(e));
        t.handleDelta({
            choices: [
                {
                    delta: {
                        tool_calls: [{ index: 0, function: { arguments: '{"loc' } }],
                    },
                },
            ],
        }).forEach((e) => events.push(e));
        t.handleDelta({
            choices: [
                {
                    delta: {
                        tool_calls: [{ index: 0, function: { arguments: 'ation":"NY"}' } }],
                    },
                },
            ],
        }).forEach((e) => events.push(e));
        t.handleFinish('tool_calls', { promptTokens: 50, completionTokens: 8, totalTokens: 58 }).forEach(
            (e) => events.push(e),
        );

        expect((events[0] as any).type).toBe('message_start');
        expect((events[1] as any).type).toBe('content_block_start');
        expect((events[1] as any).content_block).toEqual({
            type: 'tool_use',
            id: 'call_xyz',
            name: 'get_weather',
            input: {},
        });
        expect(events[2]).toEqual({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"loc' },
        });
        expect(events[3]).toEqual({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: 'ation":"NY"}' },
        });
        expect((events[4] as any).type).toBe('content_block_stop');
        expect((events[5] as any).delta.stop_reason).toBe('tool_use');
    });

    it('translates text + tool_call combined stream', () => {
        const t = new AnthropicStreamTranslator({
            messageId: 'msg_mixed',
            model: 'm',
            inputTokens: 5,
        });
        const events: unknown[] = [];

        t.handleDelta({ choices: [{ delta: { role: 'assistant' } }] }).forEach((e) => events.push(e));
        t.handleDelta({ choices: [{ delta: { content: 'Checking...' } }] }).forEach((e) =>
            events.push(e),
        );
        t.handleDelta({
            choices: [
                {
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                id: 'call_1',
                                type: 'function',
                                function: { name: 'lookup', arguments: '{}' },
                            },
                        ],
                    },
                },
            ],
        }).forEach((e) => events.push(e));
        t.handleFinish('tool_calls', { promptTokens: 5, completionTokens: 3, totalTokens: 8 }).forEach(
            (e) => events.push(e),
        );

        const types = events.map((e: any) => e.type);
        expect(types).toEqual([
            'message_start',
            'content_block_start',
            'content_block_delta',
            'content_block_stop',
            'content_block_start',
            'content_block_delta',
            'content_block_stop',
            'message_delta',
            'message_stop',
        ]);
    });

    it('emits message_start even on empty stream when handleFinish is called', () => {
        const t = new AnthropicStreamTranslator({
            messageId: 'msg_empty',
            model: 'm',
            inputTokens: 0,
        });
        const events = t.handleFinish('stop', { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
        const types = events.map((e: any) => e.type);
        expect(types).toEqual(['message_start', 'message_delta', 'message_stop']);
    });

    it('handleFinish is idempotent — second call returns no events', () => {
        const t = new AnthropicStreamTranslator({
            messageId: 'msg_idem',
            model: 'm',
            inputTokens: 1,
        });
        t.handleDelta({ choices: [{ delta: { role: 'assistant' } }] });
        t.handleDelta({ choices: [{ delta: { content: 'x' } }] });
        const first = t.handleFinish('stop', {
            promptTokens: 1,
            completionTokens: 1,
            totalTokens: 2,
        });
        const second = t.handleFinish('stop', {
            promptTokens: 1,
            completionTokens: 1,
            totalTokens: 2,
        });
        expect(first.at(-1)).toEqual({ type: 'message_stop' });
        expect(second).toEqual([]);
    });

    it('handleDelta after handleFinish is a no-op', () => {
        const t = new AnthropicStreamTranslator({
            messageId: 'msg_late',
            model: 'm',
            inputTokens: 1,
        });
        t.handleDelta({ choices: [{ delta: { role: 'assistant' } }] });
        t.handleFinish('stop', { promptTokens: 1, completionTokens: 0, totalTokens: 1 });
        const late = t.handleDelta({ choices: [{ delta: { content: 'too late' } }] });
        expect(late).toEqual([]);
    });
});
