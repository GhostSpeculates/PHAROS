import type { TokenUsage } from '../../providers/types.js';

/**
 * Build an OpenAI-compatible chat completion response.
 */
export function buildChatCompletionResponse(opts: {
    id: string;
    model: string;
    content: string;
    finishReason: string;
    usage: TokenUsage;
}): object {
    return {
        id: opts.id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: opts.model,
        choices: [
            {
                index: 0,
                message: {
                    role: 'assistant',
                    content: opts.content,
                },
                finish_reason: opts.finishReason,
            },
        ],
        usage: {
            prompt_tokens: opts.usage.promptTokens,
            completion_tokens: opts.usage.completionTokens,
            total_tokens: opts.usage.totalTokens,
        },
    };
}

/**
 * Build an OpenAI-compatible SSE streaming chunk.
 */
export function buildStreamChunk(opts: {
    id: string;
    model: string;
    content: string;
    finishReason?: string;
}): object {
    return {
        id: opts.id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: opts.model,
        choices: [
            {
                index: 0,
                delta: opts.content ? { content: opts.content } : {},
                finish_reason: opts.finishReason ?? null,
            },
        ],
    };
}

/**
 * Build an OpenAI-compatible error response.
 */
export function buildErrorResponse(
    message: string,
    type: string = 'invalid_request_error',
    code: string | null = null,
): object {
    return {
        error: {
            message,
            type,
            param: null,
            code,
        },
    };
}
