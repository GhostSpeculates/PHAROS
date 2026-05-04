import type { TokenUsage, ToolCall } from '../../providers/types.js';

/**
 * Build an OpenAI-compatible chat completion response.
 */
export function buildChatCompletionResponse(opts: {
    id: string;
    model: string;
    content: string;
    finishReason: string;
    usage: TokenUsage;
    toolCalls?: ToolCall[];
}): object {
    const message: Record<string, unknown> = {
        role: 'assistant',
        content: opts.content,
    };
    if (opts.toolCalls && opts.toolCalls.length > 0) {
        message.tool_calls = opts.toolCalls.map((tc) => ({
            id: tc.id ?? '',
            type: 'function' as const,
            function: {
                name: tc.function?.name ?? '',
                arguments: tc.function?.arguments ?? '{}',
            },
        }));
    }
    return {
        id: opts.id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: opts.model,
        choices: [
            {
                index: 0,
                message,
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
    toolCalls?: ToolCall[];
}): object {
    const delta: Record<string, unknown> = {};
    if (opts.content) delta.content = opts.content;
    if (opts.toolCalls && opts.toolCalls.length > 0) {
        delta.tool_calls = opts.toolCalls.map((tc, i) => ({
            index: tc.index ?? i,
            ...(tc.id !== undefined && { id: tc.id }),
            ...(tc.type !== undefined && { type: tc.type }),
            ...(tc.function && { function: tc.function }),
        }));
    }
    return {
        id: opts.id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: opts.model,
        choices: [
            {
                index: 0,
                delta,
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
