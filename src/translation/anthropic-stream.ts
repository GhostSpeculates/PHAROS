import type { AnthropicStreamEvent, AnthropicMessagesResponse } from './types.js';

interface OpenAIDelta {
    choices: Array<{
        delta?: {
            role?: string;
            content?: string;
            tool_calls?: Array<{
                index: number;
                id?: string;
                type?: 'function';
                function?: { name?: string; arguments?: string };
            }>;
        };
        finish_reason?: string;
    }>;
}

interface InitArgs {
    messageId: string;
    model: string;
    inputTokens: number;
}

/**
 * Stateful translator. OpenAI streams chunks of {choices:[{delta:...}]};
 * Anthropic expects a strict event sequence:
 *   message_start
 *   content_block_start (per text or tool_use block)
 *   content_block_delta (text_delta or input_json_delta)
 *   content_block_stop
 *   ...repeat per block...
 *   message_delta (with stop_reason)
 *   message_stop
 *
 * We track which Anthropic block index is currently open. Switching
 * from text → tool (or tool index N → tool index M) requires closing
 * the prior block and opening a new one.
 */
export class AnthropicStreamTranslator {
    private messageStarted = false;
    private currentBlockIndex = -1;
    /** Maps OpenAI tool_call.index → our Anthropic content block index */
    private toolBlockIndexByOpenAIIndex = new Map<number, number>();
    private currentBlockType: 'text' | 'tool_use' | null = null;
    private nextBlockIndex = 0;

    constructor(private init: InitArgs) {}

    /** Returns the events to emit for this OpenAI delta. */
    handleDelta(chunk: OpenAIDelta): AnthropicStreamEvent[] {
        const out: AnthropicStreamEvent[] = [];
        const choice = chunk.choices?.[0];
        if (!choice) return out;
        const delta = choice.delta;
        if (!delta) return out;

        // Emit message_start once, on the first chunk that names the role.
        if (!this.messageStarted) {
            this.messageStarted = true;
            const initialMessage: AnthropicMessagesResponse = {
                id: this.init.messageId,
                type: 'message',
                role: 'assistant',
                content: [],
                model: this.init.model,
                stop_reason: null,
                stop_sequence: null,
                usage: {
                    input_tokens: this.init.inputTokens,
                    output_tokens: 0,
                },
            };
            out.push({ type: 'message_start', message: initialMessage });
        }

        // Text content
        if (typeof delta.content === 'string' && delta.content.length > 0) {
            // Switch to text block if not already on one
            if (this.currentBlockType !== 'text') {
                this.closeCurrentBlock(out);
                this.openTextBlock(out);
            }
            out.push({
                type: 'content_block_delta',
                index: this.currentBlockIndex,
                delta: { type: 'text_delta', text: delta.content },
            });
        }

        // Tool calls
        if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
                let blockIndex = this.toolBlockIndexByOpenAIIndex.get(tc.index);

                // First time we see this tool_call index — open a new block
                if (blockIndex === undefined) {
                    // Close any current text or other tool block
                    this.closeCurrentBlock(out);

                    blockIndex = this.nextBlockIndex++;
                    this.toolBlockIndexByOpenAIIndex.set(tc.index, blockIndex);
                    this.currentBlockIndex = blockIndex;
                    this.currentBlockType = 'tool_use';

                    out.push({
                        type: 'content_block_start',
                        index: blockIndex,
                        content_block: {
                            type: 'tool_use',
                            id: tc.id ?? `tool_${blockIndex}`,
                            name: tc.function?.name ?? '',
                            input: {},
                        },
                    });
                } else if (this.currentBlockIndex !== blockIndex) {
                    // Switch to a different tool_call than is currently open
                    this.closeCurrentBlock(out);
                    this.currentBlockIndex = blockIndex;
                    this.currentBlockType = 'tool_use';
                }

                // Emit input_json_delta for any args fragment
                const argFragment = tc.function?.arguments;
                if (argFragment !== undefined && argFragment.length > 0) {
                    out.push({
                        type: 'content_block_delta',
                        index: blockIndex,
                        delta: { type: 'input_json_delta', partial_json: argFragment },
                    });
                }
            }
        }

        return out;
    }

    /** Emit terminating events. Call exactly once at end of stream. */
    handleFinish(
        finishReason: string,
        usage: { promptTokens: number; completionTokens: number; totalTokens: number },
    ): AnthropicStreamEvent[] {
        const out: AnthropicStreamEvent[] = [];

        // If message_start was never emitted (empty stream), emit it now so the client
        // gets a coherent sequence rather than just message_delta + message_stop.
        if (!this.messageStarted) {
            this.messageStarted = true;
            out.push({
                type: 'message_start',
                message: {
                    id: this.init.messageId,
                    type: 'message',
                    role: 'assistant',
                    content: [],
                    model: this.init.model,
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: this.init.inputTokens, output_tokens: 0 },
                },
            });
        }

        this.closeCurrentBlock(out);

        const stopReason = mapFinishReason(finishReason);

        out.push({
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: usage.completionTokens },
        });
        out.push({ type: 'message_stop' });
        return out;
    }

    private openTextBlock(out: AnthropicStreamEvent[]): void {
        this.currentBlockIndex = this.nextBlockIndex++;
        this.currentBlockType = 'text';
        out.push({
            type: 'content_block_start',
            index: this.currentBlockIndex,
            content_block: { type: 'text', text: '' },
        });
    }

    private closeCurrentBlock(out: AnthropicStreamEvent[]): void {
        if (this.currentBlockType !== null && this.currentBlockIndex >= 0) {
            out.push({ type: 'content_block_stop', index: this.currentBlockIndex });
            this.currentBlockType = null;
        }
    }
}

function mapFinishReason(reason: string): 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' {
    switch (reason) {
        case 'stop':
            return 'end_turn';
        case 'length':
            return 'max_tokens';
        case 'tool_calls':
            return 'tool_use';
        case 'stop_sequence':
            return 'stop_sequence';
        default:
            return 'end_turn';
    }
}
