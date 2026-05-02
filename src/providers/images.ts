import OpenAI from 'openai';
import type { PharosConfig } from '../config/schema.js';
import type { Logger } from '../utils/logger.js';
import { sendAlert } from '../utils/alerts.js';
import { isTransientError, calculateBackoffMs, sleep } from '../utils/retry.js';
import { resolveCandidates, type QualityTier, type QualityCandidate } from '../router/quality-tier.js';

/**
 * Image generation modality.
 *
 * Three providers, three different request shapes:
 *  - fal.ai (primary aggregator): sync via fal.run/<model> for fast models,
 *    queue + poll via queue.fal.run/<model> for ultra. Auth: `Authorization: Key <api-key>`.
 *  - BFL (Black Forest Labs direct): always async, returns polling_url, poll until status=Ready.
 *    Auth: `x-key` header.
 *  - OpenAI gpt-image-1 / dall-e-3: sync via OpenAI SDK, returns URL or b64. Resilience backstop.
 *
 * Routing is quality-tier-driven (the actual product wedge):
 *   quality: "cheapest" → flux/schnell ($0.003)
 *   quality: "balanced" → flux-pro/v1.1 ($0.040)
 *   quality: "best"     → flux-pro/v1.1-ultra ($0.060)
 *
 * Each tier falls back to lower tiers if its primary is unhealthy, so a
 * `best` request never fails completely while `cheapest` is up.
 *
 * Pharos endpoint stays synchronous from caller perspective — async polling
 * happens internally with a 60s budget.
 */

export interface ImageRequest {
    prompt: string;
    n?: number;
    /** "1024x1024" | "1024x1792" | "1792x1024" — translated per provider. */
    size?: string;
    /** "url" | "b64_json" — most providers return URL only. */
    response_format?: 'url' | 'b64_json';
    /** Pharos extension — drives quality-tier routing. Required for routed model selection. */
    quality?: QualityTier;
    /** Optional seed for reproducibility (not all providers honor it). */
    seed?: number;
}

export interface ImageGenerationResult {
    /** One entry per generated image. URL or b64. */
    images: Array<{ url?: string; b64_json?: string }>;
    /** Effective model used (e.g. "fal-ai/flux/schnell"). */
    model: string;
    /** Number of images returned. */
    count: number;
}

export interface RoutedImageResult extends ImageGenerationResult {
    provider: string;
    /** The candidate that was used — exposes pricePerImage for cost calculation. */
    candidate: QualityCandidate;
    latencyMs: number;
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
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 60_000;

abstract class ImageProvider {
    readonly name: string;
    readonly available: boolean;
    protected logger: Logger;
    protected timeoutMs: number;
    protected health: ProviderHealth;

    constructor(opts: { name: string; apiKey: string | undefined; timeoutMs: number; logger: Logger }) {
        this.name = opts.name;
        this.available = !!opts.apiKey;
        this.timeoutMs = opts.timeoutMs;
        this.logger = opts.logger;
        this.health = { available: this.available, consecutiveErrors: 0, lastErrorTime: 0 };

        if (!opts.apiKey) opts.logger.debug(`Image provider ${opts.name}: no API key, skipping`);
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
            this.logger.info(`Image provider ${this.name}: cooldown expired, marking available`);
        }
        return this.health.available;
    }

    abstract generate(model: string, req: ImageRequest): Promise<ImageGenerationResult>;

    protected recordError(error: string): void {
        this.health.consecutiveErrors++;
        this.health.lastError = error;
        this.health.lastErrorTime = Date.now();

        if (this.health.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            this.health.available = false;
            this.logger.warn(`Image provider ${this.name}: marked unavailable after ${MAX_CONSECUTIVE_ERRORS} errors`);
            sendAlert(
                'Image Provider Unhealthy',
                `**${this.name}** marked unavailable after ${MAX_CONSECUTIVE_ERRORS} consecutive errors.\nLast error: ${error}`,
                'warning',
                `image_provider_unhealthy:${this.name}`,
            );
        }
    }

    protected recordSuccess(): void {
        this.health.consecutiveErrors = 0;
        this.health.available = true;
    }
}

/**
 * fal.ai provider — sync mode (fal.run) for fast models, queue mode + poll
 * (queue.fal.run) for slower ultra models that don't fit in a single HTTP request.
 *
 * Most fal models return JSON with `images: [{ url }]`. Some use `image: { url }`.
 * We accept both.
 */
class FalImageProvider extends ImageProvider {
    private apiKey: string | undefined;

    constructor(opts: { apiKey: string | undefined; timeoutMs: number; logger: Logger }) {
        super({ name: 'fal', apiKey: opts.apiKey, timeoutMs: opts.timeoutMs, logger: opts.logger });
        this.apiKey = opts.apiKey;
    }

    async generate(model: string, req: ImageRequest): Promise<ImageGenerationResult> {
        if (!this.apiKey) throw new Error('fal not configured');

        // Translate "1024x1024" → fal's image_size convention.
        const imageSize = mapSizeToFal(req.size);
        const body: Record<string, unknown> = {
            prompt: req.prompt,
            num_images: req.n ?? 1,
            ...(imageSize ? { image_size: imageSize } : {}),
            ...(req.seed !== undefined ? { seed: req.seed } : {}),
        };

        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), this.timeoutMs);

        try {
            // Try sync (fal.run) first — works for fast models like Schnell.
            // Falls through to queue mode on 408/payload-too-large or sync rejection.
            const syncUrl = `https://fal.run/${model}`;
            const resp = await fetch(syncUrl, {
                method: 'POST',
                headers: {
                    Authorization: `Key ${this.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
                signal: abort.signal,
            });

            if (resp.ok) {
                const json = await resp.json();
                this.recordSuccess();
                return {
                    images: extractFalImages(json),
                    model,
                    count: req.n ?? 1,
                };
            }

            // Sync rejected — fall to queue mode.
            // 408 / 504 means it's a slow model; other 4xx is a real error.
            if (resp.status !== 408 && resp.status < 500) {
                const errText = await resp.text().catch(() => '<unreadable>');
                throw new Error(`fal sync ${resp.status}: ${errText.slice(0, 300)}`);
            }

            return await this.queueAndPoll(model, body, abort.signal);
        } catch (error) {
            const msg = abort.signal.aborted
                ? `fal request timed out after ${this.timeoutMs}ms`
                : error instanceof Error ? error.message : 'unknown';
            this.recordError(msg);
            throw new Error(msg);
        } finally {
            clearTimeout(timer);
        }
    }

    private async queueAndPoll(
        model: string,
        body: Record<string, unknown>,
        signal: AbortSignal,
    ): Promise<ImageGenerationResult> {
        const submitUrl = `https://queue.fal.run/${model}`;
        const submit = await fetch(submitUrl, {
            method: 'POST',
            headers: { Authorization: `Key ${this.apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal,
        });
        if (!submit.ok) {
            const errText = await submit.text().catch(() => '<unreadable>');
            throw new Error(`fal queue submit ${submit.status}: ${errText.slice(0, 300)}`);
        }
        const submitJson = await submit.json() as { request_id?: string; status_url?: string; response_url?: string };
        if (!submitJson.status_url || !submitJson.response_url) {
            throw new Error('fal queue submit returned no status_url/response_url');
        }

        const start = Date.now();
        while (Date.now() - start < POLL_TIMEOUT_MS) {
            await sleep(POLL_INTERVAL_MS);
            const status = await fetch(submitJson.status_url, {
                headers: { Authorization: `Key ${this.apiKey}` },
                signal,
            });
            if (!status.ok) continue;
            const sj = await status.json() as { status?: string };
            if (sj.status === 'COMPLETED') {
                const result = await fetch(submitJson.response_url, {
                    headers: { Authorization: `Key ${this.apiKey}` },
                    signal,
                });
                if (!result.ok) throw new Error(`fal queue result fetch ${result.status}`);
                const rj = await result.json();
                this.recordSuccess();
                return {
                    images: extractFalImages(rj),
                    model,
                    count: (body.num_images as number) ?? 1,
                };
            }
            if (sj.status === 'FAILED' || sj.status === 'ERROR') {
                throw new Error(`fal queue job ${sj.status}`);
            }
        }
        throw new Error(`fal queue poll timed out after ${POLL_TIMEOUT_MS}ms`);
    }
}

/**
 * BFL (Black Forest Labs) provider — always async. Submit returns `{ id, polling_url }`,
 * poll until `{ status: "Ready", result: { sample: <url> } }`.
 */
class BFLImageProvider extends ImageProvider {
    private apiKey: string | undefined;

    constructor(opts: { apiKey: string | undefined; timeoutMs: number; logger: Logger }) {
        super({ name: 'bfl', apiKey: opts.apiKey, timeoutMs: opts.timeoutMs, logger: opts.logger });
        this.apiKey = opts.apiKey;
    }

    async generate(model: string, req: ImageRequest): Promise<ImageGenerationResult> {
        if (!this.apiKey) throw new Error('BFL not configured');

        const [width, height] = parseSize(req.size);
        const body: Record<string, unknown> = {
            prompt: req.prompt,
            width,
            height,
            ...(req.seed !== undefined ? { seed: req.seed } : {}),
            prompt_upsampling: false,
            safety_tolerance: 2,
        };

        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), this.timeoutMs);

        try {
            const submit = await fetch(`https://api.bfl.ai/v1/${model}`, {
                method: 'POST',
                headers: { 'x-key': this.apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: abort.signal,
            });
            if (!submit.ok) {
                const errText = await submit.text().catch(() => '<unreadable>');
                throw new Error(`BFL submit ${submit.status}: ${errText.slice(0, 300)}`);
            }
            const submitJson = await submit.json() as { id?: string; polling_url?: string };
            if (!submitJson.polling_url) {
                throw new Error('BFL submit returned no polling_url');
            }

            const images: Array<{ url: string }> = [];
            const start = Date.now();
            while (Date.now() - start < POLL_TIMEOUT_MS) {
                await sleep(POLL_INTERVAL_MS);
                const poll = await fetch(submitJson.polling_url, {
                    headers: { 'x-key': this.apiKey },
                    signal: abort.signal,
                });
                if (!poll.ok) continue;
                const pj = await poll.json() as { status?: string; result?: { sample?: string } };
                if (pj.status === 'Ready' && pj.result?.sample) {
                    images.push({ url: pj.result.sample });
                    break;
                }
                if (pj.status && pj.status !== 'Pending' && pj.status !== 'Ready' && pj.status !== 'Queued') {
                    throw new Error(`BFL poll status: ${pj.status}`);
                }
            }
            if (images.length === 0) {
                throw new Error(`BFL poll timed out after ${POLL_TIMEOUT_MS}ms`);
            }

            this.recordSuccess();
            return { images, model, count: images.length };
        } catch (error) {
            const msg = abort.signal.aborted
                ? `BFL request timed out after ${this.timeoutMs}ms`
                : error instanceof Error ? error.message : 'unknown';
            this.recordError(msg);
            throw new Error(msg);
        } finally {
            clearTimeout(timer);
        }
    }
}

/**
 * OpenAI image gen — sync via SDK. Resilience backstop for `best` tier when
 * fal/BFL are both unhealthy. Default model is gpt-image-1; falls back to
 * dall-e-3 if invoked with that ID.
 */
class OpenAIImageProvider extends ImageProvider {
    private client: OpenAI | null = null;

    constructor(opts: { apiKey: string | undefined; timeoutMs: number; logger: Logger }) {
        super({ name: 'openai', apiKey: opts.apiKey, timeoutMs: opts.timeoutMs, logger: opts.logger });
        if (opts.apiKey) {
            this.client = new OpenAI({ apiKey: opts.apiKey });
        }
    }

    async generate(model: string, req: ImageRequest): Promise<ImageGenerationResult> {
        if (!this.client) throw new Error('OpenAI not configured');

        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), this.timeoutMs);

        try {
            const resp = await this.client.images.generate(
                {
                    model,
                    prompt: req.prompt,
                    n: req.n ?? 1,
                    size: (req.size ?? '1024x1024') as '1024x1024' | '1024x1792' | '1792x1024',
                    response_format: req.response_format ?? 'url',
                } as any,
                { signal: abort.signal },
            );

            this.recordSuccess();
            const data = (resp.data ?? []) as Array<{ url?: string; b64_json?: string }>;
            return {
                images: data.map((d) => ({ url: d.url, b64_json: d.b64_json })),
                model,
                count: data.length,
            };
        } catch (error) {
            const msg = abort.signal.aborted
                ? `OpenAI image timed out after ${this.timeoutMs}ms`
                : error instanceof Error ? error.message : 'unknown';
            this.recordError(msg);
            throw new Error(msg);
        } finally {
            clearTimeout(timer);
        }
    }
}

function mapSizeToFal(size: string | undefined): string | undefined {
    if (!size) return 'square_hd';
    if (size === '1024x1024') return 'square_hd';
    if (size === '1024x1792') return 'portrait_16_9';
    if (size === '1792x1024') return 'landscape_16_9';
    return 'square_hd';
}

function parseSize(size: string | undefined): [number, number] {
    if (!size) return [1024, 1024];
    const m = /^(\d+)x(\d+)$/.exec(size);
    if (!m) return [1024, 1024];
    return [parseInt(m[1], 10), parseInt(m[2], 10)];
}

function extractFalImages(json: any): Array<{ url?: string; b64_json?: string }> {
    if (Array.isArray(json?.images)) {
        return json.images.map((i: any) => ({ url: i.url, b64_json: i.b64_json }));
    }
    if (json?.image?.url) return [{ url: json.image.url }];
    return [];
}

/**
 * Routes image requests by quality tier with per-tier fallback chains.
 *
 * Walk: resolve (tier → candidate list with fallback) → for each candidate,
 * skip unhealthy provider → on transient error, retry once with backoff →
 * else fail over to next candidate.
 */
export class ImagesRouter {
    private fal: FalImageProvider;
    private bfl: BFLImageProvider;
    private openai: OpenAIImageProvider;
    private config: PharosConfig;
    private logger: Logger;
    private enabled: boolean;

    constructor(config: PharosConfig, logger: Logger) {
        this.config = config;
        this.logger = logger;
        this.enabled = (config as any).images?.enabled !== false;

        const falCfg = config.providers.fal;
        const bflCfg = config.providers.bfl;
        const openaiCfg = config.providers.openai;

        this.fal = new FalImageProvider({
            apiKey: falCfg ? process.env[falCfg.apiKeyEnv] : undefined,
            timeoutMs: falCfg?.timeoutMs ?? 60_000,
            logger,
        });
        this.bfl = new BFLImageProvider({
            apiKey: bflCfg ? process.env[bflCfg.apiKeyEnv] : undefined,
            timeoutMs: bflCfg?.timeoutMs ?? 60_000,
            logger,
        });
        this.openai = new OpenAIImageProvider({
            apiKey: openaiCfg ? process.env[openaiCfg.apiKeyEnv] : undefined,
            timeoutMs: openaiCfg?.timeoutMs ?? 60_000,
            logger,
        });

        if (!this.enabled) {
            logger.info('Images: disabled');
            return;
        }
        const ready = [this.fal, this.bfl, this.openai].filter((p) => p.available).length;
        logger.info(`Images: ${ready}/3 providers ready (fal/bfl/openai)`);
    }

    listProviders(): Array<{ name: string; available: boolean; healthy: boolean }> {
        return [this.fal, this.bfl, this.openai].map((p) => ({
            name: p.name,
            available: p.available,
            healthy: p.isHealthy(),
        }));
    }

    private getProvider(name: string): ImageProvider | undefined {
        if (name === 'fal') return this.fal;
        if (name === 'bfl') return this.bfl;
        if (name === 'openai') return this.openai;
        return undefined;
    }

    async route(tier: QualityTier, req: ImageRequest): Promise<RoutedImageResult> {
        if (!this.enabled) throw new Error('Images routing is disabled in config');

        const candidates = resolveCandidates(tier, this.config);
        if (candidates.length === 0) {
            throw new Error(`No image candidates configured for quality tier "${tier}"`);
        }

        const startTime = Date.now();
        let failoverAttempts = 0;
        let lastError: Error | null = null;

        for (const candidate of candidates) {
            const provider = this.getProvider(candidate.provider);
            if (!provider) {
                this.logger.warn({ candidate }, 'Image candidate references unknown provider, skipping');
                failoverAttempts++;
                continue;
            }
            if (!provider.isHealthy()) {
                failoverAttempts++;
                continue;
            }

            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const result = await provider.generate(candidate.model, req);
                    if (result.images.length === 0) {
                        throw new Error('provider returned no images');
                    }
                    return {
                        ...result,
                        provider: provider.name,
                        candidate,
                        latencyMs: Date.now() - startTime,
                        failoverAttempts,
                    };
                } catch (err) {
                    lastError = err instanceof Error ? err : new Error('unknown');
                    if (attempt === 0 && isTransientError(err)) {
                        const backoff = calculateBackoffMs(0);
                        this.logger.info(
                            { provider: provider.name, model: candidate.model, backoffMs: Math.round(backoff) },
                            '⟳ Transient image error, retrying with backoff',
                        );
                        await sleep(backoff);
                        continue;
                    }
                    failoverAttempts++;
                    this.logger.warn(
                        { provider: provider.name, model: candidate.model, error: lastError.message, attempt: failoverAttempts },
                        '⟳ Image provider failed, trying next candidate',
                    );
                    break;
                }
            }
        }

        throw new Error(
            `All image providers failed after ${failoverAttempts} attempts. Last error: ${lastError?.message ?? 'unknown'}`,
        );
    }
}
