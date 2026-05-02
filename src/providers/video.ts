import type { PharosConfig } from '../config/schema.js';
import type { Logger } from '../utils/logger.js';
import { sendAlert } from '../utils/alerts.js';

/**
 * Video generation modality.
 *
 * Async by design — every provider returns a job ID, Pharos stores it, and a
 * background poller (`src/jobs/video-poller.ts`) walks the in-memory job map
 * every 5 seconds asking each upstream "is it done yet?". When a job
 * completes, the poller fires the SQLite tracking call and updates the job
 * record with the final video URL.
 *
 * Three providers, three different submit shapes:
 *  - fal.ai: same `Authorization: Key <api>` pattern as Phase 3 image. Submits
 *    to `https://queue.fal.run/<model>` (always queue mode for video — no sync).
 *    Returns `{ request_id, status_url, response_url }`.
 *  - Kling direct (Kuaishou): JWT-signed requests, $0.029/sec for v1.6 standard.
 *    Submits to `https://api.klingai.com/v1/videos/text2video`. Returns task_id
 *    and a separate GET endpoint for status.
 *  - KIE AI: API for Veo (Google) + Sora-style models. Custom shape, but
 *    similar submit-and-poll pattern.
 *
 * Sora intentionally NOT integrated — OpenAI shut down the Sora API in
 * September 2026 per the strategic plan.
 *
 * This module is provider adapters + dispatch. The job lifecycle (creation,
 * polling, completion-tracking, cleanup) lives in `src/jobs/video-poller.ts`.
 */

export interface VideoSubmitRequest {
    prompt: string;
    durationSeconds: number;
    /** "720p" | "1080p" — coerced per-provider. */
    resolution: string;
    /** Optional starting frame (image-to-video). */
    imageUrl?: string;
    seed?: number;
}

export interface UpstreamSubmitResult {
    /** Provider's job ID — opaque to Pharos. */
    upstreamId: string;
    /**
     * URL Pharos polls to check status. May be a full URL (fal.ai returns one)
     * or a relative path (Kling). Stored verbatim and used by the poller.
     */
    statusUrl: string;
    /** Optional second URL for retrieving the result once status=completed. */
    responseUrl?: string;
}

export interface UpstreamPollResult {
    state: 'processing' | 'completed' | 'failed';
    videoUrl?: string;
    thumbnailUrl?: string;
    error?: string;
}

interface ProviderHealth {
    available: boolean;
    consecutiveErrors: number;
    lastErrorTime: number;
    lastError?: string;
}

const COOLDOWN_MS = 60_000;
const MAX_CONSECUTIVE_ERRORS = 3;

abstract class VideoProvider {
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
        if (!opts.apiKey) opts.logger.debug(`Video provider ${opts.name}: no API key, skipping`);
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
            this.logger.info(`Video provider ${this.name}: cooldown expired, marking available`);
        }
        return this.health.available;
    }

    abstract submit(model: string, req: VideoSubmitRequest): Promise<UpstreamSubmitResult>;
    abstract poll(statusUrl: string, responseUrl?: string): Promise<UpstreamPollResult>;

    protected recordError(error: string): void {
        this.health.consecutiveErrors++;
        this.health.lastError = error;
        this.health.lastErrorTime = Date.now();
        if (this.health.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            this.health.available = false;
            this.logger.warn(`Video provider ${this.name}: marked unavailable after ${MAX_CONSECUTIVE_ERRORS} errors`);
            sendAlert(
                'Video Provider Unhealthy',
                `**${this.name}** marked unavailable after ${MAX_CONSECUTIVE_ERRORS} consecutive errors.\nLast error: ${error}`,
                'warning',
                `video_provider_unhealthy:${this.name}`,
            );
        }
    }

    protected recordSuccess(): void {
        this.health.consecutiveErrors = 0;
        this.health.available = true;
    }
}

class FalVideoProvider extends VideoProvider {
    private apiKey: string | undefined;

    constructor(opts: { apiKey: string | undefined; timeoutMs: number; logger: Logger }) {
        super({ name: 'fal', apiKey: opts.apiKey, timeoutMs: opts.timeoutMs, logger: opts.logger });
        this.apiKey = opts.apiKey;
    }

    async submit(model: string, req: VideoSubmitRequest): Promise<UpstreamSubmitResult> {
        if (!this.apiKey) throw new Error('fal not configured');

        const body: Record<string, unknown> = {
            prompt: req.prompt,
            duration: String(req.durationSeconds),
            ...(req.imageUrl ? { image_url: req.imageUrl } : {}),
            ...(req.seed !== undefined ? { seed: req.seed } : {}),
        };
        // fal kling models accept aspect_ratio; map our resolution loosely.
        if (req.resolution === '1080p' || req.resolution === '720p') {
            body.aspect_ratio = '16:9';
        }

        try {
            const resp = await fetch(`https://queue.fal.run/${model}`, {
                method: 'POST',
                headers: { Authorization: `Key ${this.apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!resp.ok) {
                const text = await resp.text().catch(() => '<unreadable>');
                throw new Error(`fal video submit ${resp.status}: ${text.slice(0, 300)}`);
            }
            const json = await resp.json() as { request_id?: string; status_url?: string; response_url?: string };
            if (!json.status_url || !json.response_url) {
                throw new Error('fal video submit returned no status_url/response_url');
            }
            this.recordSuccess();
            return {
                upstreamId: json.request_id ?? '',
                statusUrl: json.status_url,
                responseUrl: json.response_url,
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : 'unknown';
            this.recordError(msg);
            throw new Error(msg);
        }
    }

    async poll(statusUrl: string, responseUrl?: string): Promise<UpstreamPollResult> {
        if (!this.apiKey) return { state: 'failed', error: 'fal not configured' };

        try {
            const status = await fetch(statusUrl, { headers: { Authorization: `Key ${this.apiKey}` } });
            if (!status.ok) return { state: 'processing' };  // transient, try again next tick
            const sj = await status.json() as { status?: string };
            if (sj.status === 'COMPLETED') {
                if (!responseUrl) return { state: 'failed', error: 'fal completion without response_url' };
                const result = await fetch(responseUrl, { headers: { Authorization: `Key ${this.apiKey}` } });
                if (!result.ok) return { state: 'failed', error: `fal result fetch ${result.status}` };
                const rj = await result.json() as { video?: { url?: string }; videos?: Array<{ url?: string }> };
                const url = rj.video?.url ?? rj.videos?.[0]?.url;
                if (!url) return { state: 'failed', error: 'fal completion: no video url in result' };
                return { state: 'completed', videoUrl: url };
            }
            if (sj.status === 'FAILED' || sj.status === 'ERROR') {
                return { state: 'failed', error: `fal status: ${sj.status}` };
            }
            return { state: 'processing' };
        } catch (error) {
            const msg = error instanceof Error ? error.message : 'unknown';
            return { state: 'processing', error: msg };  // assume transient; the poller will keep trying within budget
        }
    }
}

class KlingVideoProvider extends VideoProvider {
    private apiKey: string | undefined;

    constructor(opts: { apiKey: string | undefined; timeoutMs: number; logger: Logger }) {
        super({ name: 'kling', apiKey: opts.apiKey, timeoutMs: opts.timeoutMs, logger: opts.logger });
        this.apiKey = opts.apiKey;
    }

    async submit(model: string, req: VideoSubmitRequest): Promise<UpstreamSubmitResult> {
        if (!this.apiKey) throw new Error('kling not configured');

        // model encodes both family and tier (e.g. "kling-v1.6-standard", "kling-v1.6-pro").
        // Kling's API accepts model_name + mode + duration; we split here.
        const isPro = model.includes('pro');
        const modelFamily = model.startsWith('kling-v2') ? 'kling-v2-master' : 'kling-v1-6';

        const body: Record<string, unknown> = {
            model_name: modelFamily,
            mode: isPro ? 'pro' : 'std',
            duration: String(req.durationSeconds),
            prompt: req.prompt,
            ...(req.imageUrl ? { image: req.imageUrl } : {}),
        };

        try {
            // Kling API gateway uses Bearer JWT (the API key IS the JWT for production keys).
            const endpoint = req.imageUrl
                ? 'https://api.klingai.com/v1/videos/image2video'
                : 'https://api.klingai.com/v1/videos/text2video';

            const resp = await fetch(endpoint, {
                method: 'POST',
                headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!resp.ok) {
                const text = await resp.text().catch(() => '<unreadable>');
                throw new Error(`kling submit ${resp.status}: ${text.slice(0, 300)}`);
            }
            const json = await resp.json() as { code?: number; data?: { task_id?: string } };
            if (json.code !== 0 || !json.data?.task_id) {
                throw new Error(`kling submit returned code=${json.code}, no task_id`);
            }
            this.recordSuccess();
            const taskId = json.data.task_id;
            const submitType = req.imageUrl ? 'image2video' : 'text2video';
            return {
                upstreamId: taskId,
                statusUrl: `https://api.klingai.com/v1/videos/${submitType}/${taskId}`,
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : 'unknown';
            this.recordError(msg);
            throw new Error(msg);
        }
    }

    async poll(statusUrl: string): Promise<UpstreamPollResult> {
        if (!this.apiKey) return { state: 'failed', error: 'kling not configured' };

        try {
            const resp = await fetch(statusUrl, { headers: { Authorization: `Bearer ${this.apiKey}` } });
            if (!resp.ok) return { state: 'processing' };
            const json = await resp.json() as {
                code?: number;
                data?: { task_status?: string; task_status_msg?: string; task_result?: { videos?: Array<{ url?: string }> } };
            };
            if (json.code !== 0 || !json.data) return { state: 'processing' };
            const status = json.data.task_status;
            if (status === 'succeed') {
                const url = json.data.task_result?.videos?.[0]?.url;
                if (!url) return { state: 'failed', error: 'kling: no video url in result' };
                return { state: 'completed', videoUrl: url };
            }
            if (status === 'failed') {
                return { state: 'failed', error: json.data.task_status_msg ?? 'kling task failed' };
            }
            return { state: 'processing' };
        } catch (error) {
            const msg = error instanceof Error ? error.message : 'unknown';
            return { state: 'processing', error: msg };
        }
    }
}

/**
 * KIE provider using the UNIFIED `/api/v1/jobs/createTask` endpoint (not the
 * per-model endpoints). This single adapter supports every video model KIE
 * exposes (Veo, Veo Fast, Sora 2, Kling, Wan, Hailuo, Seedance, etc.) by
 * passing the model identifier in the request body.
 *
 * Submit: POST /api/v1/jobs/createTask  with { model, input: {...} }
 *   -> { code: 200, data: { taskId } }
 * Poll:   GET  /api/v1/jobs/recordInfo?taskId=...
 *   -> { code: 200, data: { state: "success"|"pending"|"failed", resultJson, failMsg } }
 *
 * `data.resultJson` is a stringified JSON containing { resultUrls: [...] }.
 * For video, resultUrls[0] is the video URL.
 */
class KIEVideoProvider extends VideoProvider {
    private apiKey: string | undefined;

    constructor(opts: { apiKey: string | undefined; timeoutMs: number; logger: Logger }) {
        super({ name: 'kie', apiKey: opts.apiKey, timeoutMs: opts.timeoutMs, logger: opts.logger });
        this.apiKey = opts.apiKey;
    }

    async submit(model: string, req: VideoSubmitRequest): Promise<UpstreamSubmitResult> {
        if (!this.apiKey) throw new Error('kie not configured');

        // KIE accepts both `aspectRatio` and `aspect_ratio` for some models — use the camelCase
        // form which is more universally supported.
        const input: Record<string, unknown> = {
            prompt: req.prompt,
            duration: req.durationSeconds,
            aspectRatio: '16:9',
            ...(req.imageUrl ? { imageUrl: req.imageUrl } : {}),
            ...(req.seed !== undefined ? { seed: req.seed } : {}),
        };

        try {
            const resp = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
                method: 'POST',
                headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, input }),
            });
            if (!resp.ok) {
                const text = await resp.text().catch(() => '<unreadable>');
                throw new Error(`kie submit ${resp.status}: ${text.slice(0, 300)}`);
            }
            const json = await resp.json() as { code?: number; data?: { taskId?: string } };
            if (json.code !== 200 || !json.data?.taskId) {
                throw new Error(`kie submit code=${json.code}, no taskId`);
            }
            this.recordSuccess();
            const taskId = json.data.taskId;
            return {
                upstreamId: taskId,
                statusUrl: `https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : 'unknown';
            this.recordError(msg);
            throw new Error(msg);
        }
    }

    async poll(statusUrl: string): Promise<UpstreamPollResult> {
        if (!this.apiKey) return { state: 'failed', error: 'kie not configured' };

        try {
            const resp = await fetch(statusUrl, { headers: { Authorization: `Bearer ${this.apiKey}` } });
            if (!resp.ok) return { state: 'processing' };
            const json = await resp.json() as {
                code?: number;
                data?: { state?: string; resultJson?: string; failMsg?: string; failCode?: number };
            };
            if (json.code !== 200 || !json.data) return { state: 'processing' };
            const data = json.data;

            if (data.state === 'success' && data.resultJson) {
                try {
                    const result = JSON.parse(data.resultJson) as { resultUrls?: string[] };
                    const url = result.resultUrls?.[0];
                    if (!url) return { state: 'failed', error: 'kie: success but no resultUrls' };
                    return { state: 'completed', videoUrl: url };
                } catch {
                    return { state: 'failed', error: 'kie: malformed resultJson' };
                }
            }
            if (data.state === 'failed' || data.state === 'fail') {
                return { state: 'failed', error: data.failMsg ?? `kie failure (code=${data.failCode ?? 'unknown'})` };
            }
            return { state: 'processing' };
        } catch (error) {
            const msg = error instanceof Error ? error.message : 'unknown';
            return { state: 'processing', error: msg };
        }
    }
}

export interface VideoCandidate {
    provider: 'fal' | 'kling' | 'kie';
    model: string;
    pricePerSecond: number;
}

const DEFAULT_TIERS: Record<'cheapest' | 'balanced' | 'best', VideoCandidate[]> = {
    cheapest: [
        { provider: 'fal', model: 'fal-ai/kling-video/v1.6/standard/text-to-video', pricePerSecond: 0.029 },
        { provider: 'kling', model: 'kling-v1.6-standard', pricePerSecond: 0.029 },
    ],
    balanced: [
        { provider: 'fal', model: 'fal-ai/kling-video/v1.6/pro/text-to-video', pricePerSecond: 0.058 },
        { provider: 'kling', model: 'kling-v1.6-pro', pricePerSecond: 0.058 },
    ],
    best: [
        { provider: 'fal', model: 'fal-ai/kling-video/v2-master/text-to-video', pricePerSecond: 0.16 },
        { provider: 'kie', model: 'veo-3', pricePerSecond: 0.10 },
    ],
};

export function resolveVideoCandidates(
    tier: 'cheapest' | 'balanced' | 'best',
    config: PharosConfig,
): VideoCandidate[] {
    const cfgTiers = (config as any).videos?.qualityTiers as Partial<Record<'cheapest' | 'balanced' | 'best', VideoCandidate[]>> | undefined;
    const tiers = {
        cheapest: cfgTiers?.cheapest ?? DEFAULT_TIERS.cheapest,
        balanced: cfgTiers?.balanced ?? DEFAULT_TIERS.balanced,
        best: cfgTiers?.best ?? DEFAULT_TIERS.best,
    };

    const result: VideoCandidate[] = [];
    if (tier === 'best') result.push(...tiers.best, ...tiers.balanced, ...tiers.cheapest);
    else if (tier === 'balanced') result.push(...tiers.balanced, ...tiers.cheapest);
    else result.push(...tiers.cheapest);
    return result;
}

export class VideosRouter {
    private fal: FalVideoProvider;
    private kling: KlingVideoProvider;
    private kie: KIEVideoProvider;
    private enabled: boolean;
    private logger: Logger;

    constructor(config: PharosConfig, logger: Logger) {
        this.logger = logger;
        this.enabled = (config as any).videos?.enabled !== false;

        const falCfg = config.providers.fal;
        const klingCfg = config.providers.kling;
        const kieCfg = config.providers.kie;

        this.fal = new FalVideoProvider({
            apiKey: falCfg ? process.env[falCfg.apiKeyEnv] : undefined,
            timeoutMs: falCfg?.timeoutMs ?? 60_000,
            logger,
        });
        this.kling = new KlingVideoProvider({
            apiKey: klingCfg ? process.env[klingCfg.apiKeyEnv] : undefined,
            timeoutMs: klingCfg?.timeoutMs ?? 60_000,
            logger,
        });
        this.kie = new KIEVideoProvider({
            apiKey: kieCfg ? process.env[kieCfg.apiKeyEnv] : undefined,
            timeoutMs: kieCfg?.timeoutMs ?? 60_000,
            logger,
        });

        if (!this.enabled) {
            logger.info('Videos: disabled');
            return;
        }
        const ready = [this.fal, this.kling, this.kie].filter((p) => p.available).length;
        logger.info(`Videos: ${ready}/3 providers ready (fal/kling/kie)`);
    }

    listProviders(): Array<{ name: string; available: boolean; healthy: boolean }> {
        return [this.fal, this.kling, this.kie].map((p) => ({
            name: p.name,
            available: p.available,
            healthy: p.isHealthy(),
        }));
    }

    getProvider(name: string): VideoProvider | undefined {
        if (name === 'fal') return this.fal;
        if (name === 'kling') return this.kling;
        if (name === 'kie') return this.kie;
        return undefined;
    }

    /**
     * Walk candidates and submit to the first healthy one. Returns the
     * candidate used + the upstream submit result. Failover semantics: skip
     * unhealthy providers; on submit error, move to next candidate.
     *
     * NOTE: there is no retry within a candidate here (unlike chat/image)
     * because video submits are cheap to retry but we don't want to
     * accidentally double-submit and double-bill. Single attempt per
     * candidate; rely on the candidate fallback for resilience.
     */
    async submit(
        candidates: VideoCandidate[],
        req: VideoSubmitRequest,
    ): Promise<{ candidate: VideoCandidate; upstream: UpstreamSubmitResult; failoverAttempts: number }> {
        if (!this.enabled) throw new Error('Video routing is disabled in config');
        if (candidates.length === 0) throw new Error('No video candidates configured');

        let failoverAttempts = 0;
        let lastError: Error | null = null;

        for (const candidate of candidates) {
            const provider = this.getProvider(candidate.provider);
            if (!provider) {
                this.logger.warn({ candidate }, 'Video candidate references unknown provider, skipping');
                failoverAttempts++;
                continue;
            }
            if (!provider.isHealthy()) {
                failoverAttempts++;
                continue;
            }
            try {
                const upstream = await provider.submit(candidate.model, req);
                return { candidate, upstream, failoverAttempts };
            } catch (err) {
                lastError = err instanceof Error ? err : new Error('unknown');
                failoverAttempts++;
                this.logger.warn(
                    { provider: candidate.provider, model: candidate.model, error: lastError.message },
                    '⟳ Video submit failed, trying next candidate',
                );
            }
        }

        throw new Error(
            `All video providers failed to submit after ${failoverAttempts} attempts. Last error: ${lastError?.message ?? 'unknown'}`,
        );
    }
}
