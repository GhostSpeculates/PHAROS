import type { ChatRequest, ChatResponse, ChatStreamChunk, ProviderHealth, LatencyStats } from './types.js';
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
    private readonly latencyWindow = 50;
    private latencyHistory: number[] = [];
    private baselineAvg: number | null = null;

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
     * Undo the last recordError() call.
     * Used when an error was not the provider's fault (e.g. context too large).
     */
    undoLastError(): void {
        if (this.health.consecutiveErrors > 0) {
            this.health.consecutiveErrors--;
        }
        // If we just restored from unavailable, re-enable
        if (!this.health.available && this.health.consecutiveErrors < 3) {
            this.health.available = true;
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

    /**
     * Record a request's latency for rolling average tracking.
     * Called from the gateway after a successful provider call.
     */
    recordLatency(ms: number): void {
        this.latencyHistory.push(ms);
        if (this.latencyHistory.length > this.latencyWindow) {
            this.latencyHistory.shift();
        }

        // Establish baseline after first 10 samples, then check for degradation
        const avg = this.latencyHistory.reduce((a, b) => a + b, 0) / this.latencyHistory.length;

        if (this.latencyHistory.length >= 10 && this.baselineAvg === null) {
            this.baselineAvg = avg;
        }

        if (this.baselineAvg !== null && avg > this.baselineAvg * 2) {
            this.logger.warn(
                { provider: this.name, avgMs: Math.round(avg), baselineMs: Math.round(this.baselineAvg) },
                `Provider ${this.name}: latency degraded (${Math.round(avg)}ms avg vs ${Math.round(this.baselineAvg)}ms baseline)`,
            );
        }
    }

    /**
     * Get rolling latency statistics.
     */
    getLatencyStats(): LatencyStats {
        if (this.latencyHistory.length === 0) {
            return { avgMs: 0, minMs: 0, maxMs: 0, p95Ms: 0, samples: 0, degraded: false };
        }

        const sorted = [...this.latencyHistory].sort((a, b) => a - b);
        const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
        const p95Index = Math.floor(sorted.length * 0.95);

        return {
            avgMs: Math.round(avg),
            minMs: sorted[0],
            maxMs: sorted[sorted.length - 1],
            p95Ms: sorted[p95Index],
            samples: sorted.length,
            degraded: this.baselineAvg !== null && avg > this.baselineAvg * 2,
        };
    }
}
