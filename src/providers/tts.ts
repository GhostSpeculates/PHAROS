import OpenAI from 'openai';
import type { PharosConfig } from '../config/schema.js';
import type { Logger } from '../utils/logger.js';
import { sendAlert } from '../utils/alerts.js';
import { isTransientError, calculateBackoffMs, sleep } from '../utils/retry.js';

/**
 * TTS modality — separate from chat (LLMProvider) and embeddings.
 *
 * Three providers, three different request shapes:
 * - OpenAI tts-1 (cheap default): OpenAI-compat /v1/audio/speech, SDK works
 * - ElevenLabs Turbo v2.5 (voice cloning): xi-api-key header, voice_id in URL path
 * - Cartesia Sonic 2 (real-time, <100ms): X-API-Key + Cartesia-Version header
 *
 * NOTE on "Grok TTS" from strategic plan: xAI has no TTS API as of 2026-05.
 * Substituted OpenAI tts-1 as the cheap default. Documented in handoff.
 *
 * Smart routing in TTSRouter:
 *   voice_clone_id present → ElevenLabs
 *   realtime: true         → Cartesia
 *   else                   → OpenAI tts-1
 */

export interface TTSResult {
    audio: Buffer;
    contentType: string;
    model: string;
    /** Character count of input — TTS providers bill on character count, not LLM tokens. */
    characters: number;
}

export interface RoutedTTSResult extends TTSResult {
    provider: string;
    latencyMs: number;
    failoverAttempts: number;
}

export interface TTSRequest {
    input: string;
    voice: string;
    response_format?: 'mp3' | 'wav' | 'opus' | 'flac' | 'pcm' | 'aac';
    speed?: number;
    voice_clone_id?: string;
    realtime?: boolean;
}

interface ProviderHealth {
    available: boolean;
    consecutiveErrors: number;
    lastErrorTime: number;
    lastError?: string;
}

const COOLDOWN_MS = 60_000;
const MAX_CONSECUTIVE_ERRORS = 3;

abstract class TTSProvider {
    readonly name: string;
    readonly model: string;
    readonly available: boolean;
    protected logger: Logger;
    protected timeoutMs: number;
    protected health: ProviderHealth;

    constructor(opts: { name: string; model: string; apiKey: string | undefined; timeoutMs: number; logger: Logger }) {
        this.name = opts.name;
        this.model = opts.model;
        this.available = !!opts.apiKey;
        this.timeoutMs = opts.timeoutMs;
        this.logger = opts.logger;
        this.health = { available: this.available, consecutiveErrors: 0, lastErrorTime: 0 };

        if (!opts.apiKey) opts.logger.debug(`TTS provider ${opts.name}: no API key, skipping`);
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
            this.logger.info(`TTS provider ${this.name}: cooldown expired, marking available`);
        }
        return this.health.available;
    }

    abstract synthesize(req: TTSRequest): Promise<TTSResult>;

    protected recordError(error: string): void {
        this.health.consecutiveErrors++;
        this.health.lastError = error;
        this.health.lastErrorTime = Date.now();

        if (this.health.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            this.health.available = false;
            this.logger.warn(`TTS provider ${this.name}: marked unavailable after ${MAX_CONSECUTIVE_ERRORS} errors`);
            sendAlert(
                'TTS Provider Unhealthy',
                `**${this.name}** marked unavailable after ${MAX_CONSECUTIVE_ERRORS} consecutive errors.\nLast error: ${error}`,
                'warning',
                `tts_provider_unhealthy:${this.name}`,
            );
        }
    }

    protected recordSuccess(): void {
        this.health.consecutiveErrors = 0;
        this.health.available = true;
    }
}

const FORMAT_TO_MIME: Record<string, string> = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    opus: 'audio/opus',
    flac: 'audio/flac',
    pcm: 'audio/pcm',
    aac: 'audio/aac',
};

class OpenAITTSProvider extends TTSProvider {
    private client: OpenAI | null = null;

    constructor(opts: { apiKey: string | undefined; model: string; timeoutMs: number; logger: Logger }) {
        super({ name: 'openai', model: opts.model, apiKey: opts.apiKey, timeoutMs: opts.timeoutMs, logger: opts.logger });
        if (opts.apiKey) {
            this.client = new OpenAI({ apiKey: opts.apiKey });
        }
    }

    async synthesize(req: TTSRequest): Promise<TTSResult> {
        if (!this.client) throw new Error('OpenAI TTS not configured');

        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), this.timeoutMs);

        try {
            const response = await this.client.audio.speech.create(
                {
                    model: this.model,
                    voice: req.voice as 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer',
                    input: req.input,
                    response_format: req.response_format ?? 'mp3',
                    ...(req.speed !== undefined ? { speed: req.speed } : {}),
                },
                { signal: abort.signal },
            );

            const buffer = Buffer.from(await response.arrayBuffer());
            this.recordSuccess();

            return {
                audio: buffer,
                contentType: FORMAT_TO_MIME[req.response_format ?? 'mp3'] ?? 'audio/mpeg',
                model: this.model,
                characters: req.input.length,
            };
        } catch (error) {
            const msg = abort.signal.aborted
                ? `OpenAI TTS timed out after ${this.timeoutMs}ms`
                : error instanceof Error ? error.message : 'unknown';
            this.recordError(msg);
            throw new Error(msg);
        } finally {
            clearTimeout(timer);
        }
    }
}

class ElevenLabsTTSProvider extends TTSProvider {
    private apiKey: string | undefined;

    constructor(opts: { apiKey: string | undefined; model: string; timeoutMs: number; logger: Logger }) {
        super({ name: 'elevenlabs', model: opts.model, apiKey: opts.apiKey, timeoutMs: opts.timeoutMs, logger: opts.logger });
        this.apiKey = opts.apiKey;
    }

    async synthesize(req: TTSRequest): Promise<TTSResult> {
        if (!this.apiKey) throw new Error('ElevenLabs TTS not configured');

        // voice_clone_id (Pharos extension) takes precedence over the OpenAI-style `voice` field.
        // ElevenLabs requires a voice_id in the URL path. If neither given, error early.
        const voiceId = req.voice_clone_id ?? req.voice;
        if (!voiceId) throw new Error('ElevenLabs requires voice_clone_id or voice (a voice_id)');

        const fmt = req.response_format ?? 'mp3';
        // ElevenLabs output_format values are richer (mp3_44100_128, pcm_16000, etc).
        // For Phase 2 we map basic OpenAI-style formats to a sensible ElevenLabs equivalent.
        const elFormat = fmt === 'mp3' ? 'mp3_44100_128'
            : fmt === 'pcm' ? 'pcm_16000'
            : fmt === 'opus' ? 'opus_48000_64'
            : 'mp3_44100_128';

        const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${elFormat}`;

        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), this.timeoutMs);

        try {
            const resp = await fetch(url, {
                method: 'POST',
                headers: {
                    'xi-api-key': this.apiKey,
                    'Content-Type': 'application/json',
                    Accept: FORMAT_TO_MIME[fmt] ?? 'audio/mpeg',
                },
                body: JSON.stringify({
                    text: req.input,
                    model_id: this.model,
                }),
                signal: abort.signal,
            });

            if (!resp.ok) {
                const errText = await resp.text().catch(() => '<unreadable>');
                throw new Error(`ElevenLabs ${resp.status}: ${errText.slice(0, 300)}`);
            }

            const buffer = Buffer.from(await resp.arrayBuffer());
            this.recordSuccess();

            return {
                audio: buffer,
                contentType: FORMAT_TO_MIME[fmt] ?? 'audio/mpeg',
                model: this.model,
                characters: req.input.length,
            };
        } catch (error) {
            const msg = abort.signal.aborted
                ? `ElevenLabs TTS timed out after ${this.timeoutMs}ms`
                : error instanceof Error ? error.message : 'unknown';
            this.recordError(msg);
            throw new Error(msg);
        } finally {
            clearTimeout(timer);
        }
    }
}

class CartesiaTTSProvider extends TTSProvider {
    private apiKey: string | undefined;
    private static readonly VERSION = '2026-03-01';

    constructor(opts: { apiKey: string | undefined; model: string; timeoutMs: number; logger: Logger }) {
        super({ name: 'cartesia', model: opts.model, apiKey: opts.apiKey, timeoutMs: opts.timeoutMs, logger: opts.logger });
        this.apiKey = opts.apiKey;
    }

    async synthesize(req: TTSRequest): Promise<TTSResult> {
        if (!this.apiKey) throw new Error('Cartesia TTS not configured');

        // Cartesia voice is { mode: 'id', id: '<uuid>' } — we accept the OpenAI-style `voice` string as the ID.
        const voiceId = req.voice_clone_id ?? req.voice;
        if (!voiceId) throw new Error('Cartesia requires voice (a Cartesia voice_id)');

        const fmt = req.response_format ?? 'mp3';
        // Cartesia output_format is a structured object.
        const cartesiaFormat = fmt === 'wav' ? { container: 'wav', encoding: 'pcm_s16le', sample_rate: 44100 }
            : fmt === 'pcm' ? { container: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 }
            : { container: 'mp3', sample_rate: 44100, bit_rate: 128_000 };

        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), this.timeoutMs);

        try {
            const resp = await fetch('https://api.cartesia.ai/tts/bytes', {
                method: 'POST',
                headers: {
                    'X-API-Key': this.apiKey,
                    'Cartesia-Version': CartesiaTTSProvider.VERSION,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model_id: this.model,
                    transcript: req.input,
                    voice: { mode: 'id', id: voiceId },
                    output_format: cartesiaFormat,
                    language: 'en',
                }),
                signal: abort.signal,
            });

            if (!resp.ok) {
                const errText = await resp.text().catch(() => '<unreadable>');
                throw new Error(`Cartesia ${resp.status}: ${errText.slice(0, 300)}`);
            }

            const buffer = Buffer.from(await resp.arrayBuffer());
            this.recordSuccess();

            return {
                audio: buffer,
                contentType: FORMAT_TO_MIME[fmt] ?? 'audio/mpeg',
                model: this.model,
                characters: req.input.length,
            };
        } catch (error) {
            const msg = abort.signal.aborted
                ? `Cartesia TTS timed out after ${this.timeoutMs}ms`
                : error instanceof Error ? error.message : 'unknown';
            this.recordError(msg);
            throw new Error(msg);
        } finally {
            clearTimeout(timer);
        }
    }
}

/**
 * Smart-routes TTS requests across the three providers.
 *
 * Selection rules:
 *  - voice_clone_id present → ElevenLabs (its wedge)
 *  - realtime: true         → Cartesia (latency wedge)
 *  - else                   → OpenAI tts-1 (cheapest default)
 *
 * Within the chosen primary, falls over to the others in cost-priority order
 * if the primary is unhealthy or errors out.
 */
export class TTSRouter {
    private openai: OpenAITTSProvider;
    private elevenlabs: ElevenLabsTTSProvider;
    private cartesia: CartesiaTTSProvider;
    private logger: Logger;
    private enabled: boolean;

    constructor(config: PharosConfig, logger: Logger) {
        this.logger = logger;
        this.enabled = (config as any).tts?.enabled !== false;

        const openaiCfg = config.providers.openai;
        const cartesiaCfg = config.providers.cartesia;
        // ElevenLabs gets its own provider entry — verify it exists in config.providers,
        // otherwise we still construct a stub provider that's marked unavailable.
        const elevenCfg = config.providers.elevenlabs;

        this.openai = new OpenAITTSProvider({
            apiKey: openaiCfg ? process.env[openaiCfg.apiKeyEnv] : undefined,
            model: 'tts-1',
            timeoutMs: openaiCfg?.timeoutMs ?? 30_000,
            logger,
        });

        this.elevenlabs = new ElevenLabsTTSProvider({
            apiKey: elevenCfg ? process.env[elevenCfg.apiKeyEnv] : undefined,
            model: 'eleven_turbo_v2_5',
            timeoutMs: elevenCfg?.timeoutMs ?? 30_000,
            logger,
        });

        this.cartesia = new CartesiaTTSProvider({
            apiKey: cartesiaCfg ? process.env[cartesiaCfg.apiKeyEnv] : undefined,
            model: 'sonic-2',
            timeoutMs: cartesiaCfg?.timeoutMs ?? 30_000,
            logger,
        });

        if (!this.enabled) {
            logger.info('TTS: disabled');
            return;
        }

        const ready = [this.openai, this.elevenlabs, this.cartesia].filter((p) => p.available).length;
        logger.info(`TTS: ${ready}/3 providers ready (openai/elevenlabs/cartesia)`);
    }

    listProviders(): Array<{ name: string; model: string; available: boolean; healthy: boolean }> {
        return [this.openai, this.elevenlabs, this.cartesia].map((p) => ({
            name: p.name,
            model: p.model,
            available: p.available,
            healthy: p.isHealthy(),
        }));
    }

    private buildOrder(req: TTSRequest): TTSProvider[] {
        if (req.voice_clone_id) {
            return [this.elevenlabs, this.openai, this.cartesia];
        }
        if (req.realtime) {
            return [this.cartesia, this.openai, this.elevenlabs];
        }
        return [this.openai, this.cartesia, this.elevenlabs];
    }

    async route(req: TTSRequest): Promise<RoutedTTSResult> {
        if (!this.enabled) throw new Error('TTS routing is disabled in config');

        const startTime = Date.now();
        const order = this.buildOrder(req);
        let failoverAttempts = 0;
        let lastError: Error | null = null;

        for (const provider of order) {
            if (!provider.isHealthy()) {
                failoverAttempts++;
                continue;
            }

            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const result = await provider.synthesize(req);
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
                            '⟳ Transient TTS error, retrying with backoff',
                        );
                        await sleep(backoff);
                        continue;
                    }
                    failoverAttempts++;
                    this.logger.warn(
                        { provider: provider.name, error: lastError.message, attempt: failoverAttempts },
                        '⟳ TTS provider failed, trying next',
                    );
                    break;
                }
            }
        }

        throw new Error(
            `All TTS providers failed after ${failoverAttempts} attempts. Last error: ${lastError?.message ?? 'unknown'}`,
        );
    }
}
