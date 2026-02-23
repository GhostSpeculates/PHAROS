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
}

export interface ChatStreamChunk {
    content: string;
    finishReason?: string;
    model?: string;
    usage?: TokenUsage;
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
