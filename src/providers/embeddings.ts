import OpenAI from 'openai';
import type { PharosConfig } from '../config/schema.js';
import type { Logger } from '../utils/logger.js';
import { sendAlert } from '../utils/alerts.js';
import { isTransientError, calculateBackoffMs, sleep } from '../utils/retry.js';

/**
 * Embedding modality — separate from chat (LLMProvider).
 *
 * All three embedding providers (OpenAI, Voyage, Jina) speak the OpenAI
 * /v1/embeddings request shape, so a single adapter handles them by
 * swapping baseURL + model. Voyage returns `usage.total_tokens` only
 * (no prompt_tokens), handled defensively below.
 *
 * Routing: cost-priority list from config; first healthy provider wins.
 * No classifier, no tier-floor — embeddings have no semantic-tier concept.
 */

export interface EmbeddingResult {
    /** One vector per input string (single-string inputs return [vector]). */
    vectors: number[][];
    /** The actual model ID returned by the provider. */
    model: string;
    /** Token usage. promptTokens is approximated from total_tokens for providers that don't split. */
    usage: { promptTokens: number; totalTokens: number };
}

export interface RoutedEmbeddingResult extends EmbeddingResult {
    provider: string;
    latencyMs: number;
    /** How many providers we had to skip/retry before this one succeeded. */
    failoverAttempts: number;
}

interface ProviderHealth {
    available: boolean;
    consecutiveErrors: number;
    lastErrorTime: number;
    lastError?: string;
}

const COOLDOWN_MS = 60_000;
const MAX_CONSECUTIVE_ERRORS = 3;

export class EmbeddingProvider {
    readonly name: string;
    readonly model: string;
    readonly available: boolean;
    private client: OpenAI | null = null;
    private logger: Logger;
    private timeoutMs: number;
    private health: ProviderHealth;

    constructor(opts: {
        name: string;
        apiKey: string | undefined;
        baseUrl: string;
        model: string;
        timeoutMs: number;
        logger: Logger;
    }) {
        this.name = opts.name;
        this.model = opts.model;
        this.available = !!opts.apiKey;
        this.timeoutMs = opts.timeoutMs;
        this.logger = opts.logger;
        this.health = { available: this.available, consecutiveErrors: 0, lastErrorTime: 0 };

        if (opts.apiKey) {
            this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseUrl });
        } else {
            opts.logger.debug(`Embedding provider ${opts.name}: no API key, skipping`);
        }
    }

    isHealthy(): boolean {
        if (!this.available) return false;
        if (
            !this.health.available
            && this.health.lastErrorTime > 0
            && Date.now() - this.health.lastErrorTime > COOLDOWN_MS
        ) {
            this.health.available = true;
            this.health.consecutiveErrors = 0;
            this.logger.info(`Embedding provider ${this.name}: cooldown expired, marking available`);
        }
        return this.health.available;
    }

    async embed(input: string | string[]): Promise<EmbeddingResult> {
        if (!this.client) throw new Error(`Embedding provider ${this.name} not configured`);

        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), this.timeoutMs);

        try {
            const response = await this.client.embeddings.create(
                { model: this.model, input },
                { signal: abort.signal },
            );

            this.health.consecutiveErrors = 0;
            this.health.available = true;

            // OpenAI returns prompt_tokens; Voyage only returns total_tokens.
            const usage = response.usage as { prompt_tokens?: number; total_tokens?: number } | undefined;
            const totalTokens = usage?.total_tokens ?? 0;
            const promptTokens = usage?.prompt_tokens ?? totalTokens;

            return {
                vectors: response.data.map((d) => d.embedding as number[]),
                model: response.model ?? this.model,
                usage: { promptTokens, totalTokens },
            };
        } catch (error) {
            const msg = abort.signal.aborted
                ? `${this.name} embeddings timed out after ${this.timeoutMs}ms`
                : error instanceof Error ? error.message : 'unknown';
            this.recordError(msg);
            throw new Error(msg);
        } finally {
            clearTimeout(timer);
        }
    }

    private recordError(error: string): void {
        this.health.consecutiveErrors++;
        this.health.lastError = error;
        this.health.lastErrorTime = Date.now();

        if (this.health.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            this.health.available = false;
            this.logger.warn(`Embedding provider ${this.name}: marked unavailable after ${MAX_CONSECUTIVE_ERRORS} errors`);
            sendAlert(
                'Embedding Provider Unhealthy',
                `**${this.name}** marked unavailable after ${MAX_CONSECUTIVE_ERRORS} consecutive errors.\nLast error: ${error}`,
                'warning',
                `embedding_provider_unhealthy:${this.name}`,
            );
        }
    }
}

/**
 * Routes an embedding request through the configured provider list.
 * Walks providers in priority order, skipping unhealthy ones. On a transient
 * error, retries the same provider once with backoff before failing over.
 */
export class EmbeddingsRouter {
    private providers: EmbeddingProvider[] = [];
    private logger: Logger;

    constructor(config: PharosConfig, logger: Logger) {
        this.logger = logger;

        if (!config.embeddings || !config.embeddings.enabled) {
            logger.info('Embeddings: disabled');
            return;
        }

        for (const entry of config.embeddings.providers) {
            const providerCfg = config.providers[entry.name];
            if (!providerCfg) {
                logger.warn(`Embeddings: provider "${entry.name}" referenced but not in providers config — skipping`);
                continue;
            }
            const provider = new EmbeddingProvider({
                name: entry.name,
                apiKey: process.env[providerCfg.apiKeyEnv],
                baseUrl: providerCfg.baseUrl ?? 'https://api.openai.com/v1',
                model: entry.model,
                timeoutMs: providerCfg.timeoutMs ?? 30_000,
                logger,
            });
            this.providers.push(provider);

            if (provider.available) {
                logger.info(`✓ Embedding provider ${entry.name} (${entry.model}): ready`);
            }
        }

        const ready = this.providers.filter((p) => p.available).length;
        logger.info(`Embeddings: ${ready}/${this.providers.length} providers ready`);
    }

    listProviders(): Array<{ name: string; model: string; available: boolean; healthy: boolean }> {
        return this.providers.map((p) => ({
            name: p.name,
            model: p.model,
            available: p.available,
            healthy: p.isHealthy(),
        }));
    }

    /**
     * Try each healthy provider in order. On transient error, retry the same
     * provider once with backoff. On non-transient or 2nd failure, fail over.
     */
    async route(input: string | string[]): Promise<RoutedEmbeddingResult> {
        if (this.providers.length === 0) {
            throw new Error('No embedding providers configured');
        }

        const startTime = Date.now();
        let failoverAttempts = 0;
        let lastError: Error | null = null;

        for (const provider of this.providers) {
            if (!provider.isHealthy()) {
                failoverAttempts++;
                continue;
            }

            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const result = await provider.embed(input);
                    return {
                        ...result,
                        provider: provider.name,
                        latencyMs: Date.now() - startTime,
                        failoverAttempts,
                    };
                } catch (err) {
                    lastError = err instanceof Error ? err : new Error('unknown');
                    if (attempt === 0 && isTransientError(err)) {
                        const backoff = calculateBackoffMs(0);
                        this.logger.info(
                            { provider: provider.name, backoffMs: Math.round(backoff) },
                            '⟳ Transient embedding error, retrying with backoff',
                        );
                        await sleep(backoff);
                        continue;
                    }
                    failoverAttempts++;
                    this.logger.warn(
                        { provider: provider.name, error: lastError.message, attempt: failoverAttempts },
                        '⟳ Embedding provider failed, trying next',
                    );
                    break;
                }
            }
        }

        throw new Error(
            `All embedding providers failed after ${failoverAttempts} attempts. Last error: ${lastError?.message ?? 'unknown'}`,
        );
    }
}
