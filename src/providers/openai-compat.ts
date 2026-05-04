import OpenAI from 'openai';
import { LLMProvider } from './base.js';
import type { ChatRequest, ChatResponse, ChatStreamChunk } from './types.js';
import type { Logger } from '../utils/logger.js';

/**
 * OpenAI-compatible provider adapter.
 *
 * This single adapter handles ALL providers that speak the OpenAI API format:
 * - OpenAI (GPT-4o, o3, etc.)
 * - DeepSeek (deepseek-chat)
 * - Groq (llama-3.3-70b-versatile)
 * - Mistral (mistral-large-latest)
 *
 * Just change the baseURL and API key and it works.
 * This is the most versatile adapter — one class for 4+ providers.
 */
export class OpenAICompatProvider extends LLMProvider {
    private client: OpenAI | null = null;

    constructor(
        name: string,
        apiKey: string | undefined,
        baseUrl: string,
        logger: Logger,
        timeoutMs?: number,
        cooldownMs?: number,
    ) {
        super(name, apiKey, logger, timeoutMs, cooldownMs);
        if (apiKey) {
            this.client = new OpenAI({ apiKey, baseURL: baseUrl });
        }
    }

    async chat(request: ChatRequest): Promise<ChatResponse> {
        if (!this.client) throw new Error(`${this.name} provider not configured`);

        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), this.timeoutMs);

        try {
            const response = await this.client.chat.completions.create(
                {
                    model: request.model,
                    // Pass messages as-is; SDK handles string and array content
                    messages: request.messages as any,
                    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
                    ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
                    ...(request.topP !== undefined ? { top_p: request.topP } : {}),
                    ...(request.stop ? { stop: request.stop } : {}),
                    ...(request.presencePenalty !== undefined ? { presence_penalty: request.presencePenalty } : {}),
                    ...(request.frequencyPenalty !== undefined ? { frequency_penalty: request.frequencyPenalty } : {}),
                    ...(request.tools && request.tools.length > 0 ? { tools: request.tools as any } : {}),
                    ...(request.toolChoice !== undefined ? { tool_choice: request.toolChoice as any } : {}),
                    stream: false,
                },
                { signal: abort.signal },
            );

            this.recordSuccess();

            const choice = response.choices[0];
            const message = choice?.message;
            const toolCalls = (message as any)?.tool_calls as ChatResponse['toolCalls'] | undefined;

            return {
                content: message?.content ?? '',
                model: response.model,
                usage: {
                    promptTokens: response.usage?.prompt_tokens ?? 0,
                    completionTokens: response.usage?.completion_tokens ?? 0,
                    totalTokens: response.usage?.total_tokens ?? 0,
                },
                finishReason: choice?.finish_reason ?? 'stop',
                ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
            };
        } catch (error) {
            if (abort.signal.aborted) {
                const timeoutError = new Error(`${this.name} request timed out after ${this.timeoutMs}ms`);
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
        if (!this.client) throw new Error(`${this.name} provider not configured`);

        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), this.timeoutMs);

        try {
            const stream = await this.client.chat.completions.create(
                {
                    model: request.model,
                    // Pass messages as-is; SDK handles string and array content
                    messages: request.messages as any,
                    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
                    ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
                    ...(request.topP !== undefined ? { top_p: request.topP } : {}),
                    ...(request.stop ? { stop: request.stop } : {}),
                    ...(request.presencePenalty !== undefined ? { presence_penalty: request.presencePenalty } : {}),
                    ...(request.frequencyPenalty !== undefined ? { frequency_penalty: request.frequencyPenalty } : {}),
                    ...(request.tools && request.tools.length > 0 ? { tools: request.tools as any } : {}),
                    ...(request.toolChoice !== undefined ? { tool_choice: request.toolChoice as any } : {}),
                    stream: true,
                    stream_options: { include_usage: true },
                },
                { signal: abort.signal },
            );

            let usage: ChatStreamChunk['usage'] | undefined;

            for await (const chunk of stream) {
                const delta = chunk.choices[0]?.delta;
                const content = delta?.content ?? '';
                const toolCalls = (delta as any)?.tool_calls as ChatStreamChunk['toolCalls'] | undefined;

                // Yield text and tool-call fragments. Same chunk can carry both —
                // assistant might emit a final text snippet + start a tool call
                // in the same delta. We surface whatever's present.
                if (content || (toolCalls && toolCalls.length > 0)) {
                    yield {
                        content,
                        ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
                    };
                }

                // Usage comes in the final chunk
                if (chunk.usage) {
                    usage = {
                        promptTokens: chunk.usage.prompt_tokens ?? 0,
                        completionTokens: chunk.usage.completion_tokens ?? 0,
                        totalTokens: chunk.usage.total_tokens ?? 0,
                    };
                }

                if (chunk.choices[0]?.finish_reason) {
                    this.recordSuccess();
                    yield {
                        content: '',
                        finishReason: chunk.choices[0].finish_reason,
                        model: chunk.model,
                        usage,
                    };
                }
            }
        } catch (error) {
            if (abort.signal.aborted) {
                const timeoutError = new Error(`${this.name} stream timed out after ${this.timeoutMs}ms`);
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
}
