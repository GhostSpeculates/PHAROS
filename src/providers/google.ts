import { GoogleGenAI } from '@google/genai';
import { LLMProvider } from './base.js';
import type { ChatRequest, ChatResponse, ChatStreamChunk } from './types.js';
import type { Logger } from '../utils/logger.js';

/**
 * Google provider adapter (Gemini models).
 *
 * Handles conversion between OpenAI format and Google's Gemini API.
 */
export class GoogleProvider extends LLMProvider {
    private genai: GoogleGenAI | null = null;

    constructor(
        apiKey: string | undefined,
        logger: Logger,
        timeoutMs?: number,
        cooldownMs?: number,
    ) {
        super('google', apiKey, logger, timeoutMs, cooldownMs);
        if (apiKey) {
            this.genai = new GoogleGenAI({ apiKey });
        }
    }

    async chat(request: ChatRequest): Promise<ChatResponse> {
        if (!this.genai) throw new Error('Google provider not configured');

        try {
            const { systemInstruction, contents } = this.convertMessages(request.messages);

            const response = await this.genai.models.generateContent({
                model: request.model,
                contents,
                config: {
                    ...(systemInstruction ? { systemInstruction } : {}),
                    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
                    ...(request.maxTokens ? { maxOutputTokens: request.maxTokens } : {}),
                    ...(request.topP !== undefined ? { topP: request.topP } : {}),
                    ...(request.stop ? { stopSequences: request.stop } : {}),
                    ...(request.presencePenalty !== undefined ? { presencePenalty: request.presencePenalty } : {}),
                    ...(request.frequencyPenalty !== undefined ? { frequencyPenalty: request.frequencyPenalty } : {}),
                    httpOptions: { timeout: this.timeoutMs },
                },
            });

            this.recordSuccess();

            const usage = response.usageMetadata;

            return {
                content: response.text ?? '',
                model: request.model,
                usage: {
                    promptTokens: usage?.promptTokenCount ?? 0,
                    completionTokens: usage?.candidatesTokenCount ?? 0,
                    totalTokens: usage?.totalTokenCount ?? 0,
                },
                finishReason: 'stop',
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : 'unknown';
            this.recordError(msg);
            throw error;
        }
    }

    async *chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk> {
        if (!this.genai) throw new Error('Google provider not configured');

        try {
            const { systemInstruction, contents } = this.convertMessages(request.messages);

            const response = await this.genai.models.generateContentStream({
                model: request.model,
                contents,
                config: {
                    ...(systemInstruction ? { systemInstruction } : {}),
                    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
                    ...(request.maxTokens ? { maxOutputTokens: request.maxTokens } : {}),
                    ...(request.topP !== undefined ? { topP: request.topP } : {}),
                    ...(request.stop ? { stopSequences: request.stop } : {}),
                    ...(request.presencePenalty !== undefined ? { presencePenalty: request.presencePenalty } : {}),
                    ...(request.frequencyPenalty !== undefined ? { frequencyPenalty: request.frequencyPenalty } : {}),
                    httpOptions: { timeout: this.timeoutMs },
                },
            });

            let lastUsage: ChatStreamChunk['usage'] | undefined;

            for await (const chunk of response) {
                const text = chunk.text ?? '';
                if (text) {
                    yield { content: text };
                }

                if (chunk.usageMetadata) {
                    lastUsage = {
                        promptTokens: chunk.usageMetadata.promptTokenCount ?? 0,
                        completionTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
                        totalTokens: chunk.usageMetadata.totalTokenCount ?? 0,
                    };
                }
            }

            this.recordSuccess();

            // Final chunk with usage — default to zeroes if stream never sent usage metadata
            if (!lastUsage) {
                this.logger.warn(
                    { model: request.model },
                    'Google stream completed without usageMetadata — defaulting to zero usage',
                );
                lastUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
            }

            yield {
                content: '',
                finishReason: 'stop',
                model: request.model,
                usage: lastUsage,
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : 'unknown';
            this.recordError(msg);
            throw error;
        }
    }

    /**
     * Convert OpenAI-format messages to Google Gemini format.
     */
    private convertMessages(messages: ChatRequest['messages']): {
        systemInstruction: string | undefined;
        contents: string;
    } {
        let systemInstruction: string | undefined;
        const parts: string[] = [];

        for (const msg of messages) {
            if (msg.role === 'system') {
                systemInstruction = (systemInstruction ? systemInstruction + '\n\n' : '') + msg.content;
            } else {
                parts.push(`${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`);
            }
        }

        return { systemInstruction, contents: parts.join('\n\n') };
    }
}
