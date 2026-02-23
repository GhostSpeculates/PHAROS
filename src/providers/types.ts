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
}

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
