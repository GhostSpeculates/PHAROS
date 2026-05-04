/**
 * Shared types for all provider adapters.
 */

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | Array<{ type: string; [key: string]: unknown }> | null;
    name?: string;
    tool_call_id?: string;
    tool_calls?: unknown[];
}

/**
 * OpenAI-shape tool definition. Anthropic and Google adapters translate
 * to/from their native shapes internally. Pharos's internal contract is
 * OpenAI-shape because that's the format the gateway routes accept.
 */
export interface ToolDefinition {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters: object;
    };
}

export type ToolChoice =
    | 'auto'
    | 'required'
    | 'none'
    | { type: 'function'; function: { name: string } };

/**
 * OpenAI-shape tool call (from assistant message OR streaming delta).
 * For streaming deltas, all fields except `index` may be partial across
 * multiple chunks — `id` and `function.name` typically arrive in the
 * first chunk for that index, `function.arguments` streams as fragments.
 */
export interface ToolCall {
    index?: number;
    id?: string;
    type?: 'function';
    function?: {
        name?: string;
        arguments?: string;
    };
}

export interface ChatRequest {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    maxTokens?: number;
    stream?: boolean;
    topP?: number;
    stop?: string[];
    /** Penalize tokens by their existing frequency in the text so far. -2.0 to 2.0. */
    presencePenalty?: number;
    /** Penalize tokens by how often they've appeared so far. -2.0 to 2.0. */
    frequencyPenalty?: number;
    /** Anthropic extended thinking config — passed through when routing to Anthropic, ignored for other providers. */
    thinking?: ThinkingConfig;
    /** OpenAI-shape tool definitions. Adapters translate to native shapes. */
    tools?: ToolDefinition[];
    /** OpenAI-shape tool choice. Adapters translate to native shapes. */
    toolChoice?: ToolChoice;
}

/**
 * Extended thinking configuration.
 * Supports both the full Anthropic format and shorthand strings (e.g. "low", "medium", "high").
 */
export type ThinkingConfig =
    | { type: 'enabled'; budget_tokens: number }
    | { type: 'disabled' }
    | string;

export interface ChatResponse {
    content: string;
    model: string;
    usage: TokenUsage;
    finishReason: string;
    /** Tool calls emitted by the assistant. Empty/undefined when the model didn't call any tools. */
    toolCalls?: ToolCall[];
}

export interface ChatStreamChunk {
    content: string;
    finishReason?: string;
    model?: string;
    usage?: TokenUsage;
    /**
     * Tool call fragments for THIS chunk. Each delta may carry partial
     * data — the same `index` across chunks builds up one tool call.
     * `id` and `function.name` typically arrive in the first chunk
     * for that index; `function.arguments` streams as JSON fragments.
     */
    toolCalls?: ToolCall[];
}

export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}

export interface ProviderHealth {
    available: boolean;
    lastError?: string;
    lastErrorTime?: number;
    consecutiveErrors: number;
}

export interface LatencyStats {
    avgMs: number;
    minMs: number;
    maxMs: number;
    p95Ms: number;
    samples: number;
    degraded: boolean;
}
