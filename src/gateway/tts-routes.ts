import type { FastifyInstance } from 'fastify';
import type { PharosConfig } from '../config/schema.js';
import type { TTSRouter } from '../providers/tts.js';
import type { TrackingStore } from '../tracking/store.js';
import type { Logger } from '../utils/logger.js';
import { TTSRequestSchema } from './schemas/tts-request.js';
import { buildErrorResponse } from './schemas/response.js';
import { calculateCost } from '../tracking/cost-calculator.js';
import { generateRequestId } from '../utils/id.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createAgentRateLimiter } from './middleware/agent-rate-limit.js';
import { sendAlert } from '../utils/alerts.js';

/**
 * Register the /v1/audio/speech endpoint.
 *
 * Pipeline: validate → auth → agent rate-limit → spending guard → route → track → respond.
 * Response is binary audio bytes (not JSON).
 */
export function registerTTSRoutes(
    app: FastifyInstance,
    config: PharosConfig,
    ttsRouter: TTSRouter,
    tracker: TrackingStore | null,
    logger: Logger,
): void {
    const authMiddleware = createAuthMiddleware(config);
    const agentRateLimiter = createAgentRateLimiter(config.server.agentRateLimitPerMinute, logger);

    app.post('/v1/audio/speech', { preHandler: authMiddleware }, async (request, reply) => {
        const requestStartTime = Date.now();
        const clientRequestId = request.headers['x-request-id'];
        const requestId = (typeof clientRequestId === 'string' && clientRequestId.trim())
            ? clientRequestId.trim()
            : generateRequestId();

        // 1. Validate
        const parseResult = TTSRequestSchema.safeParse(request.body);
        if (!parseResult.success) {
            const errors = parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
            reply.status(400).send(buildErrorResponse(`Invalid request: ${errors.join('; ')}`, 'invalid_request_error'));
            return;
        }
        const body = parseResult.data;

        // 2. Per-agent rate limiting (colon-suffix syntax: "pharos-tts:nex-labs" → agentId="nex-labs")
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

        // 3. Spending limit guard (pooled with chat + embeddings)
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

        const inputPreview = body.input.slice(0, 80);
        logger.info(
            { requestId, model: body.model, agentId, voice: body.voice, realtime: body.realtime, hasClone: !!body.voice_clone_id, chars: body.input.length },
            'TTS request received',
        );

        try {
            // 4. Route through configured providers
            const result = await ttsRouter.route({
                input: body.input,
                voice: body.voice,
                response_format: body.response_format,
                speed: body.speed,
                voice_clone_id: body.voice_clone_id,
                realtime: body.realtime,
            });

            const cost = calculateCost(result.provider, result.model, result.characters, 0);

            // 5. Track in SQLite (tier='tts', characters stored in tokens_in)
            if (tracker) {
                tracker.record({
                    id: requestId,
                    timestamp: new Date().toISOString(),
                    tier: 'tts',
                    provider: result.provider,
                    model: result.model,
                    classificationScore: 0,
                    classificationType: 'tts',
                    classificationLatencyMs: 0,
                    classifierProvider: 'none',
                    tokensIn: result.characters,
                    tokensOut: 0,
                    estimatedCost: cost,
                    baselineCost: cost,
                    savings: 0,
                    totalLatencyMs: Date.now() - requestStartTime,
                    stream: false,
                    isDirectRoute: false,
                    userMessagePreview: inputPreview,
                    status: 'success',
                    agentId: agentId ?? undefined,
                    retryCount: result.failoverAttempts,
                    providerLatencyMs: result.latencyMs,
                });
            }

            // 6. Pharos metadata headers
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
                    chars: result.characters,
                    audioBytes: result.audio.length,
                    cost: `$${cost.toFixed(8)}`,
                    latencyMs: Date.now() - requestStartTime,
                    preview: inputPreview,
                    retries: result.failoverAttempts,
                },
                '✓ TTS completed',
            );

            return reply.type(result.contentType).send(result.audio);
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : 'Unknown error';
            logger.error({ requestId, error: errMsg }, '✗ TTS request failed');

            if (tracker) {
                tracker.record({
                    id: requestId,
                    timestamp: new Date().toISOString(),
                    tier: 'tts',
                    provider: 'none',
                    model: body.model,
                    classificationScore: 0,
                    classificationType: 'tts',
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
                    userMessagePreview: inputPreview,
                    status: 'error',
                    errorMessage: errMsg,
                    agentId: agentId ?? undefined,
                });
            }

            reply.status(502).send(buildErrorResponse(
                `TTS routing failed: ${errMsg}`,
                'server_error',
                'provider_error',
            ));
        }
    });
}
