import type { ChatRequest, ChatResponse, ChatStreamChunk, ProviderHealth } from './types.js';
import type { Logger } from '../utils/logger.js';

/**
 * Abstract base class for all LLM provider adapters.
 *
 * Every provider (Anthropic, Google, OpenAI, etc.) extends this class
 * and implements the chat() and chatStream() methods. This gives us
 * a uniform interface no matter which provider we're talking to.
 */
export abstract class LLMProvider {
    readonly name: string;
    readonly available: boolean;
    protected logger: Logger;
    protected health: ProviderHealth;
    protected readonly timeoutMs: number;
    private readonly cooldownMs: number;

    constructor(
        name: string,
        apiKey: string | undefined,
        logger: Logger,
        timeoutMs: number = 30_000,
        cooldownMs: number = 60_000,
    ) {
        this.name = name;
        this.logger = logger;
        this.available = !!apiKey;
        this.timeoutMs = timeoutMs;
        this.cooldownMs = cooldownMs;
        this.health = {
            available: this.available,
            consecutiveErrors: 0,
        };

        if (!this.available) {
            this.logger.debug(`Provider ${name}: no API key, skipping`);
        }
    }

    /**
     * Send a chat request and get a complete response.
     */
    abstract chat(request: ChatRequest): Promise<ChatResponse>;

    /**
     * Send a chat request and get a streaming response.
     */
    abstract chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk>;

    /**
     * Record a successful request (resets error tracking).
     */
    protected recordSuccess(): void {
        this.health.consecutiveErrors = 0;
        this.health.available = true;
    }

    /**
     * Record a failed request.
     */
    protected recordError(error: string): void {
        this.health.consecutiveErrors++;
        this.health.lastError = error;
        this.health.lastErrorTime = Date.now();

        // Mark as unavailable after 3 consecutive failures
        if (this.health.consecutiveErrors >= 3) {
            this.health.available = false;
            this.logger.warn(`Provider ${this.name}: marked unavailable after 3 consecutive errors`);
        }
    }

    /**
     * Check if this provider is currently healthy.
     */
    isHealthy(): boolean {
        if (!this.available) return false;

        // If marked unhealthy, check if cooldown period has passed
        if (!this.health.available && this.health.lastErrorTime) {
            if (Date.now() - this.health.lastErrorTime > this.cooldownMs) {
                this.health.available = true;
                this.health.consecutiveErrors = 0;
                this.logger.info(`Provider ${this.name}: cooldown expired, marking available`);
            }
        }

        return this.health.available;
    }

    /**
     * Get current health status.
     */
    getHealth(): ProviderHealth {
        return { ...this.health };
    }
}
