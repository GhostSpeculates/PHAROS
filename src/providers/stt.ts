import OpenAI from 'openai';
import type { PharosConfig } from '../config/schema.js';
import type { Logger } from '../utils/logger.js';
import { sendAlert } from '../utils/alerts.js';
import { isTransientError, calculateBackoffMs, sleep } from '../utils/retry.js';

/**
 * STT (Speech-to-Text) modality — separate from chat and embeddings.
 *
 * Three providers with distinct routing:
 *
 *   Groq   (whisper-large-v3-turbo)  — OpenAI-compat multipart, $0.04/hr batch
 *   Deepgram (nova-3)                — Custom POST: raw binary body + query params
 *   Cartesia (ink-whisper)           — Multipart-compat, requires Cartesia-Version header
 *
 * Routing rules (evaluated in order):
 *   realtime: true  → Deepgram (latency tier-1)
 *   streaming: true → Cartesia
 *   else            → Groq (cheap batch default)
 *
 * Cost encoding: STT bills per-minute-of-audio, NOT per token.
 * We encode this in pharos.yaml pricing as:
 *   inputCostPerMillion = cost per 1,000,000 seconds of audio × 60
 * Concretely: Groq $0.04/hr → $0.04/3600s → $0.04/3600 * 1e6 = $11.11/M-seconds
 * So tokensIn = audio_duration_seconds, and the cost formula is identical to chat:
 *   cost = (tokensIn * inputCostPerMillion) / 1_000_000
 *
 * For requests where we cannot determine duration (no file stat), we fall back
 * to estimating duration as fileByteCount / 16000 (rough 128kbps heuristic).
 */

export interface STTResult {
    text: string;
    /** Provider model ID actually used (may differ from requested). */
    model: string;
    /** Estimated audio duration in seconds. Used for cost calculation. */
    durationSeconds: number;
    /** Response language if provider returned it (verbose_json only). */
    language?: string;
}

export interface RoutedSTTResult extends STTResult {
    provider: string;
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

// ─── Groq Provider (OpenAI-compat) ──────────────────────────────────────────

export class GroqSTTProvider {
    readonly name = 'groq';
    readonly model = 'whisper-large-v3-turbo';
    readonly available: boolean;
    private client: OpenAI | null = null;
    private logger: Logger;
    private timeoutMs: number;
    private health: ProviderHealth;

    constructor(opts: { apiKey: string | undefined; baseUrl: string; timeoutMs: number; logger: Logger }) {
        this.available = !!opts.apiKey;
        this.logger = opts.logger;
        this.timeoutMs = opts.timeoutMs;
        this.health = { available: this.available, consecutiveErrors: 0, lastErrorTime: 0 };

        if (opts.apiKey) {
            this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseUrl });
        } else {
            opts.logger.debug('STT Groq provider: no API key, skipping');
        }
    }

    isHealthy(): boolean {
        if (!this.available) return false;
        if (
            !this.health.available &&
            this.health.lastErrorTime > 0 &&
            Date.now() - this.health.lastErrorTime > COOLDOWN_MS
        ) {
            this.health.available = true;
            this.health.consecutiveErrors = 0;
            this.logger.info('STT Groq: cooldown expired, marking available');
        }
        return this.health.available;
    }

    async transcribe(fileBuffer: Buffer, filename: string, language?: string, prompt?: string): Promise<STTResult> {
        if (!this.client) throw new Error('STT Groq provider not configured');

        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), this.timeoutMs);

        try {
            // OpenAI SDK accepts a File-like object — construct via toFile helper
            const { toFile } = await import('openai');
            const audioFile = await toFile(fileBuffer, filename, { type: 'audio/wav' });

            const response = await this.client.audio.transcriptions.create(
                {
                    model: this.model,
                    file: audioFile,
                    response_format: 'verbose_json',
                    ...(language ? { language } : {}),
                    ...(prompt ? { prompt } : {}),
                },
                { signal: abort.signal },
            );

            this.health.consecutiveErrors = 0;
            this.health.available = true;

            // verbose_json has duration; fall back to byte-size estimate
            const duration = (response as any).duration ?? estimateDurationFromBytes(fileBuffer.length);

            return {
                text: response.text,
                model: this.model,
                durationSeconds: duration,
                language: (response as any).language ?? language,
            };
        } catch (error) {
            const msg = abort.signal.aborted
                ? `Groq STT timed out after ${this.timeoutMs}ms`
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
            this.logger.warn(`STT Groq: marked unavailable after ${MAX_CONSECUTIVE_ERRORS} errors`);
            sendAlert(
                'STT Provider Unhealthy',
                `**groq** marked unavailable after ${MAX_CONSECUTIVE_ERRORS} errors.\nLast: ${error}`,
                'warning',
                'stt_provider_unhealthy:groq',
            );
        }
    }
}

// ─── Deepgram Provider (custom REST: raw binary body + query params) ─────────

export class DeepgramSTTProvider {
    readonly name = 'deepgram';
    readonly model = 'nova-3';
    readonly available: boolean;
    private apiKey: string;
    private logger: Logger;
    private timeoutMs: number;
    private health: ProviderHealth;

    constructor(opts: { apiKey: string | undefined; timeoutMs: number; logger: Logger }) {
        this.available = !!opts.apiKey;
        this.apiKey = opts.apiKey ?? '';
        this.logger = opts.logger;
        this.timeoutMs = opts.timeoutMs;
        this.health = { available: this.available, consecutiveErrors: 0, lastErrorTime: 0 };

        if (!opts.apiKey) {
            opts.logger.debug('STT Deepgram provider: no API key, skipping');
        }
    }

    isHealthy(): boolean {
        if (!this.available) return false;
        if (
            !this.health.available &&
            this.health.lastErrorTime > 0 &&
            Date.now() - this.health.lastErrorTime > COOLDOWN_MS
        ) {
            this.health.available = true;
            this.health.consecutiveErrors = 0;
            this.logger.info('STT Deepgram: cooldown expired, marking available');
        }
        return this.health.available;
    }

    /**
     * Deepgram pre-recorded transcription:
     *   POST https://api.deepgram.com/v1/listen?model=nova-3&...
     *   Content-Type: audio/wav  (or appropriate mime type)
     *   Body: raw audio bytes
     *
     * NOT OpenAI-compat multipart — completely custom shape.
     */
    async transcribe(fileBuffer: Buffer, mimeType: string, language?: string): Promise<STTResult> {
        if (!this.available) throw new Error('STT Deepgram provider not configured');

        const params = new URLSearchParams({ model: this.model, smart_format: 'true' });
        if (language) params.set('language', language);

        const url = `https://api.deepgram.com/v1/listen?${params.toString()}`;
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), this.timeoutMs);

        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    Authorization: `Token ${this.apiKey}`,
                    'Content-Type': mimeType,
                },
                body: fileBuffer,
                signal: abort.signal,
            });

            if (!res.ok) {
                const body = await res.text().catch(() => '(no body)');
                throw new Error(`Deepgram HTTP ${res.status}: ${body}`);
            }

            const json = await res.json() as any;

            this.health.consecutiveErrors = 0;
            this.health.available = true;

            const transcript = json?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
            const duration = json?.metadata?.duration ?? estimateDurationFromBytes(fileBuffer.length);
            const detectedLanguage = json?.results?.channels?.[0]?.detected_language ?? language;

            return {
                text: transcript,
                model: this.model,
                durationSeconds: duration,
                language: detectedLanguage,
            };
        } catch (error) {
            const msg = abort.signal.aborted
                ? `Deepgram STT timed out after ${this.timeoutMs}ms`
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
            this.logger.warn(`STT Deepgram: marked unavailable after ${MAX_CONSECUTIVE_ERRORS} errors`);
            sendAlert(
                'STT Provider Unhealthy',
                `**deepgram** marked unavailable after ${MAX_CONSECUTIVE_ERRORS} errors.\nLast: ${error}`,
                'warning',
                'stt_provider_unhealthy:deepgram',
            );
        }
    }
}

// ─── Cartesia Provider (multipart, requires Cartesia-Version header) ──────────

export class CartesiaSTTProvider {
    readonly name = 'cartesia';
    readonly model = 'ink-whisper';
    readonly available: boolean;
    private apiKey: string;
    private logger: Logger;
    private timeoutMs: number;
    private health: ProviderHealth;

    // Cartesia requires this header on every request
    private static readonly CARTESIA_VERSION = '2026-03-01';

    constructor(opts: { apiKey: string | undefined; timeoutMs: number; logger: Logger }) {
        this.available = !!opts.apiKey;
        this.apiKey = opts.apiKey ?? '';
        this.logger = opts.logger;
        this.timeoutMs = opts.timeoutMs;
        this.health = { available: this.available, consecutiveErrors: 0, lastErrorTime: 0 };

        if (!opts.apiKey) {
            opts.logger.debug('STT Cartesia provider: no API key, skipping');
        }
    }

    isHealthy(): boolean {
        if (!this.available) return false;
        if (
            !this.health.available &&
            this.health.lastErrorTime > 0 &&
            Date.now() - this.health.lastErrorTime > COOLDOWN_MS
        ) {
            this.health.available = true;
            this.health.consecutiveErrors = 0;
            this.logger.info('STT Cartesia: cooldown expired, marking available');
        }
        return this.health.available;
    }

    /**
     * Cartesia STT:
     *   POST https://api.cartesia.ai/stt
     *   Cartesia-Version: 2026-03-01
     *   Authorization: Bearer sk_car_...
     *   Content-Type: multipart/form-data
     *   Fields: file (binary), model (string), language? (string)
     *
     * Pricing: $0.13/hr on Scale plan → ~$0.002167/min → ~$0.0000361/second
     * Encoding as per-second: inputCostPerMillion = $0.13/3600 * 1e6 ≈ $36.11/M-seconds
     */
    async transcribe(fileBuffer: Buffer, filename: string, language?: string): Promise<STTResult> {
        if (!this.available) throw new Error('STT Cartesia provider not configured');

        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), this.timeoutMs);

        try {
            const formData = new FormData();
            const blob = new Blob([fileBuffer], { type: 'audio/wav' });
            formData.append('file', blob, filename);
            formData.append('model', this.model);
            if (language) formData.append('language', language);

            const res = await fetch('https://api.cartesia.ai/stt', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Cartesia-Version': CartesiaSTTProvider.CARTESIA_VERSION,
                },
                body: formData,
                signal: abort.signal,
            });

            if (!res.ok) {
                const body = await res.text().catch(() => '(no body)');
                throw new Error(`Cartesia STT HTTP ${res.status}: ${body}`);
            }

            const json = await res.json() as any;

            this.health.consecutiveErrors = 0;
            this.health.available = true;

            // Cartesia returns { text: "...", ... }
            const text = json?.text ?? '';
            const duration = json?.duration ?? estimateDurationFromBytes(fileBuffer.length);

            return {
                text,
                model: this.model,
                durationSeconds: duration,
                language: json?.language ?? language,
            };
        } catch (error) {
            const msg = abort.signal.aborted
                ? `Cartesia STT timed out after ${this.timeoutMs}ms`
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
            this.logger.warn(`STT Cartesia: marked unavailable after ${MAX_CONSECUTIVE_ERRORS} errors`);
            sendAlert(
                'STT Provider Unhealthy',
                `**cartesia** marked unavailable after ${MAX_CONSECUTIVE_ERRORS} errors.\nLast: ${error}`,
                'warning',
                'stt_provider_unhealthy:cartesia',
            );
        }
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Rough duration estimate from file size when no provider-returned duration
 * is available. Assumes ~128 kbps compressed audio (typical for MP3/AAC/WAV
 * at common sample rates). Minimum: 1 second.
 */
function estimateDurationFromBytes(byteCount: number): number {
    const bitsPerSecond = 128_000;
    return Math.max(1, Math.round((byteCount * 8) / bitsPerSecond));
}

/**
 * Detect MIME type from common audio file extensions / magic bytes.
 * Falls back to 'audio/wav' if unknown.
 */
export function detectMimeType(filename: string, buffer?: Buffer): string {
    const ext = filename.toLowerCase().split('.').pop() ?? '';
    const extMap: Record<string, string> = {
        wav: 'audio/wav',
        mp3: 'audio/mpeg',
        mp4: 'audio/mp4',
        m4a: 'audio/mp4',
        ogg: 'audio/ogg',
        oga: 'audio/ogg',
        flac: 'audio/flac',
        webm: 'audio/webm',
        mpga: 'audio/mpeg',
        mpeg: 'audio/mpeg',
    };
    if (extMap[ext]) return extMap[ext];

    // Magic byte sniff for WAV and OGG
    if (buffer && buffer.length >= 4) {
        if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return 'audio/wav'; // RIFF
        if (buffer[0] === 0x4f && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) return 'audio/ogg'; // OggS
    }

    return 'audio/wav';
}

// ─── STT Router ──────────────────────────────────────────────────────────────

/**
 * Smart STT routing:
 *   realtime: true  → Deepgram  (lowest latency, $0.0048/min)
 *   streaming: true → Cartesia  (streaming-optimised, $0.13/hr)
 *   default         → Groq      (cheapest batch, $0.04/hr)
 *
 * Falls back across providers if the primary is unhealthy.
 * On transient error: retry once with backoff; then fail over.
 */
export class STTRouter {
    private groq: GroqSTTProvider;
    private deepgram: DeepgramSTTProvider;
    private cartesia: CartesiaSTTProvider;
    private logger: Logger;

    constructor(config: PharosConfig, logger: Logger) {
        this.logger = logger;

        // config.stt is added to PharosConfigSchema by the orchestrator.
        // Access via optional chaining so this file compiles before that schema update lands.
        const sttConfig = (config as any).stt as { enabled?: boolean } | undefined;
        if (!sttConfig || sttConfig.enabled === false) {
            logger.info('STT: disabled');
        }

        // Groq reuses the existing `groq` provider entry (GROQ_API_KEY already set).
        const groqCfg = config.providers['groq'];
        this.groq = new GroqSTTProvider({
            apiKey: groqCfg ? process.env[groqCfg.apiKeyEnv] : undefined,
            baseUrl: groqCfg?.baseUrl ?? 'https://api.groq.com/openai/v1',
            timeoutMs: groqCfg?.timeoutMs ?? 60_000,
            logger,
        });

        // Deepgram — separate provider entry in pharos.yaml
        const deepgramCfg = config.providers['deepgram'];
        this.deepgram = new DeepgramSTTProvider({
            apiKey: deepgramCfg ? process.env[deepgramCfg.apiKeyEnv] : undefined,
            timeoutMs: deepgramCfg?.timeoutMs ?? 30_000,
            logger,
        });

        // Cartesia — separate provider entry in pharos.yaml
        const cartesiaCfg = config.providers['cartesia'];
        this.cartesia = new CartesiaSTTProvider({
            apiKey: cartesiaCfg ? process.env[cartesiaCfg.apiKeyEnv] : undefined,
            timeoutMs: cartesiaCfg?.timeoutMs ?? 30_000,
            logger,
        });

        const readyList = [
            this.groq.available && 'groq',
            this.deepgram.available && 'deepgram',
            this.cartesia.available && 'cartesia',
        ].filter(Boolean).join(', ');

        logger.info(`STT providers ready: ${readyList || 'none (check API keys)'}`);
    }

    listProviders(): Array<{ name: string; model: string; available: boolean; healthy: boolean }> {
        return [
            { name: this.groq.name, model: this.groq.model, available: this.groq.available, healthy: this.groq.isHealthy() },
            { name: this.deepgram.name, model: this.deepgram.model, available: this.deepgram.available, healthy: this.deepgram.isHealthy() },
            { name: this.cartesia.name, model: this.cartesia.model, available: this.cartesia.available, healthy: this.cartesia.isHealthy() },
        ];
    }

    async route(opts: {
        fileBuffer: Buffer;
        filename: string;
        language?: string;
        prompt?: string;
        realtime?: boolean;
        streaming?: boolean;
    }): Promise<RoutedSTTResult> {
        const startTime = Date.now();
        const mimeType = detectMimeType(opts.filename, opts.fileBuffer);

        // Determine preferred routing order based on flags
        const ordered = this.buildProviderOrder(opts.realtime, opts.streaming);

        let failoverAttempts = 0;
        let lastError: Error | null = null;

        for (const provider of ordered) {
            if (!provider.isHealthy()) {
                failoverAttempts++;
                continue;
            }

            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const result = await this.callProvider(provider, opts, mimeType);
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
                            '⟳ Transient STT error, retrying with backoff',
                        );
                        await sleep(backoff);
                        continue;
                    }
                    failoverAttempts++;
                    this.logger.warn(
                        { provider: provider.name, error: lastError.message, attempt: failoverAttempts },
                        '⟳ STT provider failed, trying next',
                    );
                    break;
                }
            }
        }

        throw new Error(
            `All STT providers failed after ${failoverAttempts} attempts. Last error: ${lastError?.message ?? 'unknown'}`,
        );
    }

    private buildProviderOrder(
        realtime?: boolean,
        streaming?: boolean,
    ): Array<GroqSTTProvider | DeepgramSTTProvider | CartesiaSTTProvider> {
        if (realtime) {
            // Latency tier-1: Deepgram → Groq fallback
            return [this.deepgram, this.groq, this.cartesia];
        }
        if (streaming) {
            // Streaming: Cartesia → Groq fallback
            return [this.cartesia, this.groq, this.deepgram];
        }
        // Default batch: Groq (cheapest) → Deepgram → Cartesia
        return [this.groq, this.deepgram, this.cartesia];
    }

    private async callProvider(
        provider: GroqSTTProvider | DeepgramSTTProvider | CartesiaSTTProvider,
        opts: { fileBuffer: Buffer; filename: string; language?: string; prompt?: string },
        mimeType: string,
    ): Promise<STTResult> {
        if (provider instanceof GroqSTTProvider) {
            return provider.transcribe(opts.fileBuffer, opts.filename, opts.language, opts.prompt);
        }
        if (provider instanceof DeepgramSTTProvider) {
            return provider.transcribe(opts.fileBuffer, mimeType, opts.language);
        }
        if (provider instanceof CartesiaSTTProvider) {
            return provider.transcribe(opts.fileBuffer, opts.filename, opts.language);
        }
        throw new Error('Unknown STT provider type');
    }
}
