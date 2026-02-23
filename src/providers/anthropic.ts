import Anthropic from '@anthropic-ai/sdk';
import { LLMProvider } from './base.js';
import type { ChatRequest, ChatResponse, ChatStreamChunk } from './types.js';
import type { Logger } from '../utils/logger.js';

/**
 * Anthropic provider adapter (Claude models).
 *
 * Handles the format differences between OpenAI and Anthropic APIs:
 * - Anthropic uses a separate `system` param instead of a system message
 * - Different streaming format
 * - Different response structure
 */
export class AnthropicProvider extends LLMProvider {
    private client: Anthropic | null = null;

    constructor(
        apiKey: string | undefined,
        logger: Logger,
        timeoutMs?: number,
        cooldownMs?: number,
    ) {
        super('anthropic', apiKey, logger, timeoutMs, cooldownMs);
        if (apiKey) {
            this.client = new Anthropic({ apiKey });
        }
    }

    async chat(request: ChatRequest): Promise<ChatResponse> {
        if (!this.client) throw new Error('Anthropic provider not configured');

        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), this.timeoutMs);

        try {
            const { system, messages } = this.convertMessages(request.messages);

            const response = await this.client.messages.create(
                {
                    model: request.model,
                    max_tokens: request.maxTokens ?? 4096,
                    ...(system ? { system } : {}),
                    messages,
                    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
                    ...(request.topP !== undefined ? { top_p: request.topP } : {}),
                    ...(request.stop ? { stop_sequences: request.stop } : {}),
                },
                { signal: abort.signal },
            );

            this.recordSuccess();

            const textContent = response.content
                .filter((block): block is Anthropic.TextBlock => block.type === 'text')
                .map((block) => block.text)
                .join('');

            return {
                content: textContent,
                model: response.model,
                usage: {
                    promptTokens: response.usage.input_tokens,
                    completionTokens: response.usage.output_tokens,
                    totalTokens: response.usage.input_tokens + response.usage.output_tokens,
                },
                finishReason: response.stop_reason ?? 'stop',
            };
        } catch (error) {
            if (abort.signal.aborted) {
                const timeoutError = new Error(`Anthropic request timed out after ${this.timeoutMs}ms`);
                this.recordError(timeoutError.message);
                throw timeoutError;
            }
            const msg = error instanceof Error ? error.message : 'unknown';
            this.recordError(msg);
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    async *chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk> {
        if (!this.client) throw new Error('Anthropic provider not configured');

        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), this.timeoutMs);

        try {
            const { system, messages } = this.convertMessages(request.messages);

            const stream = this.client.messages.stream(
                {
                    model: request.model,
                    max_tokens: request.maxTokens ?? 4096,
                    ...(system ? { system } : {}),
                    messages,
                    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
                    ...(request.topP !== undefined ? { top_p: request.topP } : {}),
                    ...(request.stop ? { stop_sequences: request.stop } : {}),
                },
                { signal: abort.signal },
            );

            for await (const event of stream) {
                if (
                    event.type === 'content_block_delta' &&
                    event.delta.type === 'text_delta'
                ) {
                    yield { content: event.delta.text };
                }
            }

            // Get final message for usage stats
            const finalMessage = await stream.finalMessage();
            this.recordSuccess();

            yield {
                content: '',
                finishReason: finalMessage.stop_reason ?? 'stop',
                model: finalMessage.model,
                usage: {
                    promptTokens: finalMessage.usage.input_tokens,
                    completionTokens: finalMessage.usage.output_tokens,
                    totalTokens: finalMessage.usage.input_tokens + finalMessage.usage.output_tokens,
                },
            };
        } catch (error) {
            if (abort.signal.aborted) {
                const timeoutError = new Error(`Anthropic stream timed out after ${this.timeoutMs}ms`);
                this.recordError(timeoutError.message);
                throw timeoutError;
            }
            const msg = error instanceof Error ? error.message : 'unknown';
            this.recordError(msg);
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Convert OpenAI-format messages to Anthropic format.
     * Anthropic requires system messages to be separate from the messages array.
     */
    private convertMessages(messages: ChatRequest['messages']): {
        system: string | undefined;
        messages: Anthropic.MessageParam[];
    } {
        let system: string | undefined;
        const converted: Anthropic.MessageParam[] = [];

        for (const msg of messages) {
            if (msg.role === 'system') {
                // Extract text from string or array content
                const text = typeof msg.content === 'string'
                    ? msg.content
                    : Array.isArray(msg.content)
                        ? msg.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join(' ')
                        : '';
                system = (system ? system + '\n\n' : '') + text;
            } else if (msg.role === 'user' || msg.role === 'assistant') {
                converted.push({
                    role: msg.role,
                    content: msg.content as any,
                });
            }
        }

        return { system, messages: converted };
    }
}
