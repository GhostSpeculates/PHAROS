import type { FastifyInstance } from 'fastify';
import type { PharosConfig } from '../config/schema.js';
import type { STTRouter } from '../providers/stt.js';
import type { TrackingStore } from '../tracking/store.js';
import type { WalletStore } from '../tracking/wallet-store.js';
import type { Logger } from '../utils/logger.js';
import { STTRequestSchema } from './schemas/stt-request.js';
import { buildErrorResponse } from './schemas/response.js';
import { calculateCost } from '../tracking/cost-calculator.js';
import { generateRequestId } from '../utils/id.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createAgentRateLimiter } from './middleware/agent-rate-limit.js';
import { sendAlert } from '../utils/alerts.js';

/**
 * Register the /v1/audio/transcriptions endpoint.
 *
 * Pipeline: parse multipart → validate form fields → auth → agent rate-limit
 *           → spending guard → route → track → respond.
 *
 * REQUIRES: @fastify/multipart registered on the Fastify instance BEFORE this
 * function is called (see orchestrator action items in handoff).
 *
 * Multipart handling: we use request.parts() to iterate all parts, collecting
 * the file buffer first, then form fields. This avoids loading @fastify/multipart
 * types at compile time — the plugin augments the request object at runtime.
 *
 * Cost tracking:
 *   tier:             'stt'
 *   tokens_in:        audio duration in seconds (from provider response or estimate)
 *   tokens_out:       transcribed text character count
 *   estimated_cost:   calculateCost(provider, model, durationSeconds, 0)
 *                     (STT pricing encoded in pharos.yaml as $/M-seconds — see handoff)
 *   baseline_cost:    equal to estimated_cost (no chat baseline for STT)
 *   savings:          0  (no savings concept for STT)
 */
export function registerSTTRoutes(
    app: FastifyInstance,
    config: PharosConfig,
    sttRouter: STTRouter,
    tracker: TrackingStore | null,
    logger: Logger,
    wallet?: WalletStore | null,
): void {
    const authMiddleware = createAuthMiddleware(config, wallet);
    const agentRateLimiter = createAgentRateLimiter(config.server.agentRateLimitPerMinute, logger);

    app.post('/v1/audio/transcriptions', { preHandler: authMiddleware }, async (request, reply) => {
        const requestStartTime = Date.now();
        const clientRequestId = request.headers['x-request-id'];
        const requestId = (typeof clientRequestId === 'string' && clientRequestId.trim())
            ? clientRequestId.trim()
            : generateRequestId();

        // 1. Parse multipart form ────────────────────────────────────────────
        // @fastify/multipart augments request with .parts() at runtime.
        // We cast to any to avoid importing the plugin's augmented types here
        // (the plugin must be registered in server.ts before this route).
        const req = request as any;
        if (typeof req.parts !== 'function') {
            reply.status(500).send(buildErrorResponse(
                'Multipart plugin not registered. Contact the server administrator.',
                'server_error',
            ));
            return;
        }

        let fileBuffer: Buffer | null = null;
        let filename = 'audio.wav';
        const fields: Record<string, string> = {};

        try {
            for await (const part of req.parts()) {
                if (part.type === 'file' && part.fieldname === 'file') {
                    const chunks: Buffer[] = [];
                    for await (const chunk of part.file) {
                        chunks.push(chunk);
                    }
                    fileBuffer = Buffer.concat(chunks);
                    filename = part.filename || filename;
                } else if (part.type === 'field') {
                    fields[part.fieldname] = part.value;
                }
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'multipart parse error';
            reply.status(400).send(buildErrorResponse(`Failed to parse multipart body: ${msg}`, 'invalid_request_error'));
            return;
        }

        if (!fileBuffer || fileBuffer.length === 0) {
            reply.status(400).send(buildErrorResponse('Missing required field: file (audio binary)', 'invalid_request_error'));
            return;
        }

        // 2. Validate form fields via Zod ───────────────────────────────────
        const parseResult = STTRequestSchema.safeParse(fields);
        if (!parseResult.success) {
            const errors = parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
            reply.status(400).send(buildErrorResponse(`Invalid request: ${errors.join('; ')}`, 'invalid_request_error'));
            return;
        }
        const body = parseResult.data;

        // 3. Per-agent rate limiting ─────────────────────────────────────────
        // Agent ID parsed from model field colon-suffix: "pharos-stt:my-agent" → "my-agent"
        const agentId = agentRateLimiter.extractAgent(body.model);
        if (agentId) {
            const rl = agentRateLimiter.check(agentId);
            if (!rl.allowed) {
                reply.header('Retry-After', String(rl.retryAfterSeconds));
                reply.status(429).send(buildErrorResponse(
                    `Agent "${agentId}" rate limited. Retry after ${rl.retryAfterSeconds}s.`,
                    'rate_limit_error',
                ));
                return;
            }
        }

        // 4. Spending limit guard ────────────────────────────────────────────
        if (tracker) {
            const { dailyLimit, monthlyLimit } = config.spending;
            if (dailyLimit !== null) {
                const dailySpend = tracker.getDailySpend();
                if (dailySpend >= dailyLimit) {
                    sendAlert('Daily spending limit reached', `Spent $${dailySpend.toFixed(4)} / $${dailyLimit.toFixed(2)} daily limit`, 'critical', 'spending-daily-100');
                    reply.status(429).send(buildErrorResponse(
                        `Daily spending limit ($${dailyLimit.toFixed(2)}) reached. Current: $${dailySpend.toFixed(4)}`,
                        'rate_limit_error',
                    ));
                    return;
                }
            }
            if (monthlyLimit !== null) {
                const monthlySpend = tracker.getMonthlySpend();
                if (monthlySpend >= monthlyLimit) {
                    sendAlert('Monthly spending limit reached', `Spent $${monthlySpend.toFixed(4)} / $${monthlyLimit.toFixed(2)} monthly limit`, 'critical', 'spending-monthly-100');
                    reply.status(429).send(buildErrorResponse(
                        `Monthly spending limit ($${monthlyLimit.toFixed(2)}) reached. Current: $${monthlySpend.toFixed(4)}`,
                        'rate_limit_error',
                    ));
                    return;
                }
            }
        }

        logger.info(
            {
                requestId,
                model: body.model,
                agentId,
                fileSizeBytes: fileBuffer.length,
                filename,
                realtime: body.realtime,
                streaming: body.streaming,
            },
            'STT request received',
        );

        try {
            // 5. Route through configured providers ─────────────────────────
            const result = await sttRouter.route({
                fileBuffer,
                filename,
                language: body.language,
                prompt: body.prompt,
                realtime: body.realtime,
                streaming: body.streaming,
            });

            // 6. Cost calculation ────────────────────────────────────────────
            // tokensIn = audio duration in seconds
            // tokensOut = 0 (STT has no output tokens — we track text length separately)
            // calculateCost uses pharos.yaml pricing where inputCostPerMillion encodes
            // cost per 1,000,000 seconds of audio (see handoff for encoding details).
            const cost = calculateCost(result.provider, result.model, result.durationSeconds, 0);
            const textLength = result.text.length;

            // Stamp wallet billing — onResponse hook reads this and debits the user.
            if (cost > 0) {
                request.pharosBilling = {
                    upstream_usd: cost,
                    model: result.model,
                    provider: result.provider,
                    modality: 'voice',
                    request_id: requestId,
                };
            }

            // 7. Build response ──────────────────────────────────────────────
            // Phase 2 supports 'json' (default). SRT/VTT/verbose_json noted below.
            let responseBody: unknown;
            if (body.response_format === 'text') {
                // Plain text — return raw string, no JSON wrapper
                reply.header('Content-Type', 'text/plain; charset=utf-8');
                responseBody = result.text;
            } else if (body.response_format === 'verbose_json') {
                responseBody = {
                    task: 'transcribe',
                    language: result.language ?? body.language ?? 'en',
                    duration: result.durationSeconds,
                    text: result.text,
                    // Segments not available from all providers in Phase 2 — return empty
                    segments: [],
                };
            } else {
                // json (default), srt, vtt — all return { text } for Phase 2
                // SRT/VTT word-level timestamps require provider-specific segment data
                // not uniformly available across Groq/Deepgram/Cartesia. Documented
                // in handoff as a Phase 2 v2 enhancement.
                responseBody = { text: result.text };
            }

            // 8. Track in SQLite ─────────────────────────────────────────────
            if (tracker) {
                tracker.record({
                    id: requestId,
                    timestamp: new Date().toISOString(),
                    tier: 'stt',
                    provider: result.provider,
                    model: result.model,
                    classificationScore: 0,
                    classificationType: 'stt',
                    classificationLatencyMs: 0,
                    classifierProvider: 'none',
                    tokensIn: result.durationSeconds,         // audio seconds
                    tokensOut: textLength,                    // character count (rough proxy)
                    estimatedCost: cost,
                    baselineCost: cost,                       // no chat baseline for STT
                    savings: 0,
                    totalLatencyMs: Date.now() - requestStartTime,
                    stream: false,
                    isDirectRoute: false,
                    userMessagePreview: result.text.slice(0, 80),
                    status: 'success',
                    agentId: agentId ?? undefined,
                    retryCount: result.failoverAttempts,
                    providerLatencyMs: result.latencyMs,
                });
            }

            // 9. Response headers ────────────────────────────────────────────
            reply.header('X-Pharos-Provider', result.provider);
            reply.header('X-Pharos-Model', result.model);
            reply.header('X-Pharos-Cost', cost.toFixed(8));
            reply.header('X-Pharos-Request-Id', requestId);
            if (result.failoverAttempts > 0) {
                reply.header('X-Pharos-Retries', String(result.failoverAttempts));
            }

            logger.info(
                {
                    requestId,
                    provider: result.provider,
                    model: result.model,
                    durationSeconds: result.durationSeconds,
                    cost: `$${cost.toFixed(8)}`,
                    latencyMs: Date.now() - requestStartTime,
                    textLength,
                    retries: result.failoverAttempts,
                },
                '✓ STT transcription completed',
            );

            return responseBody;

        } catch (error) {
            const errMsg = error instanceof Error ? error.message : 'Unknown error';
            logger.error({ requestId, error: errMsg }, '✗ STT request failed');

            if (tracker) {
                tracker.record({
                    id: requestId,
                    timestamp: new Date().toISOString(),
                    tier: 'stt',
                    provider: 'none',
                    model: body.model,
                    classificationScore: 0,
                    classificationType: 'stt',
                    classificationLatencyMs: 0,
                    classifierProvider: 'none',
                    tokensIn: 0,
                    tokensOut: 0,
                    estimatedCost: 0,
                    baselineCost: 0,
                    savings: 0,
                    totalLatencyMs: Date.now() - requestStartTime,
                    stream: false,
                    isDirectRoute: false,
                    userMessagePreview: undefined,
                    status: 'error',
                    errorMessage: errMsg,
                    agentId: agentId ?? undefined,
                });
            }

            reply.status(502).send(buildErrorResponse(
                `STT routing failed: ${errMsg}`,
                'server_error',
                'provider_error',
            ));
        }
    });
}
