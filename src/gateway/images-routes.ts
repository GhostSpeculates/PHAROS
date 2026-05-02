import type { FastifyInstance } from 'fastify';
import type { PharosConfig } from '../config/schema.js';
import type { ImagesRouter } from '../providers/images.js';
import type { TrackingStore } from '../tracking/store.js';
import type { WalletStore } from '../tracking/wallet-store.js';
import type { Logger } from '../utils/logger.js';
import { ImagesRequestSchema } from './schemas/images-request.js';
import { buildErrorResponse } from './schemas/response.js';
import { calculateCost } from '../tracking/cost-calculator.js';
import { generateRequestId } from '../utils/id.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createAgentRateLimiter } from './middleware/agent-rate-limit.js';
import { sendAlert } from '../utils/alerts.js';

/**
 * Register POST /v1/images/generations.
 *
 * Pipeline: validate → auth → agent rate-limit → spending guard →
 *   resolve quality tier → ImagesRouter.route → track → respond.
 *
 * Response is OpenAI-compatible: { created, data: [{ url? | b64_json? }] }.
 * The `quality` field defaults to "balanced" if absent — caller pays mid-tier
 * by default rather than getting unpredictable cost from "best".
 */
export function registerImagesRoutes(
    app: FastifyInstance,
    config: PharosConfig,
    imagesRouter: ImagesRouter,
    tracker: TrackingStore | null,
    logger: Logger,
    wallet?: WalletStore | null,
): void {
    const authMiddleware = createAuthMiddleware(config, wallet);
    const agentRateLimiter = createAgentRateLimiter(config.server.agentRateLimitPerMinute, logger);

    app.post('/v1/images/generations', { preHandler: authMiddleware }, async (request, reply) => {
        const requestStartTime = Date.now();
        const clientRequestId = request.headers['x-request-id'];
        const requestId = (typeof clientRequestId === 'string' && clientRequestId.trim())
            ? clientRequestId.trim()
            : generateRequestId();

        // 1. Validate
        const parseResult = ImagesRequestSchema.safeParse(request.body);
        if (!parseResult.success) {
            const errors = parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
            reply.status(400).send(buildErrorResponse(`Invalid request: ${errors.join('; ')}`, 'invalid_request_error'));
            return;
        }
        const body = parseResult.data;

        // 2. Per-agent rate limiting
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

        // 3. Spending limit guard (pooled with chat + embeddings + tts + stt)
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

        // Default to "balanced" — mid-cost, predictable. Callers pay for "best" deliberately.
        const quality = body.quality ?? 'balanced';
        const promptPreview = body.prompt.slice(0, 80);
        const n = body.n ?? 1;

        logger.info(
            { requestId, model: body.model, agentId, quality, n, size: body.size, promptPreview },
            'Image request received',
        );

        try {
            // 4. Route through quality tier → fallback chain
            const result = await imagesRouter.route(quality, {
                prompt: body.prompt,
                n,
                size: body.size,
                response_format: body.response_format,
                seed: body.seed,
            });

            const cost = calculateCost(result.provider, result.candidate.model, result.count, 0);

            // Stamp wallet billing — onResponse hook reads this and debits the user.
            if (cost > 0) {
                request.pharosBilling = {
                    upstream_usd: cost,
                    model: result.candidate.model,
                    provider: result.provider,
                    modality: 'image',
                    request_id: requestId,
                };
            }

            // 5. Track in SQLite (tier='image', tokens_in = image count)
            if (tracker) {
                tracker.record({
                    id: requestId,
                    timestamp: new Date().toISOString(),
                    tier: 'image',
                    provider: result.provider,
                    model: result.candidate.model,
                    classificationScore: 0,
                    classificationType: `image:${quality}`,
                    classificationLatencyMs: 0,
                    classifierProvider: 'none',
                    tokensIn: result.count,
                    tokensOut: 0,
                    estimatedCost: cost,
                    baselineCost: cost,
                    savings: 0,
                    totalLatencyMs: Date.now() - requestStartTime,
                    stream: false,
                    isDirectRoute: false,
                    userMessagePreview: promptPreview,
                    status: 'success',
                    agentId: agentId ?? undefined,
                    retryCount: result.failoverAttempts,
                    providerLatencyMs: result.latencyMs,
                });
            }

            // 6. Pharos metadata headers
            reply.header('X-Pharos-Provider', result.provider);
            reply.header('X-Pharos-Model', result.candidate.model);
            reply.header('X-Pharos-Quality', quality);
            reply.header('X-Pharos-Cost', cost.toFixed(6));
            reply.header('X-Pharos-Request-Id', requestId);
            if (result.failoverAttempts > 0) {
                reply.header('X-Pharos-Retries', String(result.failoverAttempts));
            }

            logger.info(
                {
                    requestId,
                    provider: result.provider,
                    model: result.candidate.model,
                    quality,
                    n: result.count,
                    cost: `$${cost.toFixed(6)}`,
                    latencyMs: Date.now() - requestStartTime,
                    retries: result.failoverAttempts,
                    pricePerImage: result.candidate.pricePerImage,
                },
                '✓ Image generation completed',
            );

            // 7. OpenAI-compatible response shape
            return {
                created: Math.floor(Date.now() / 1000),
                data: result.images.map((img) => ({
                    url: img.url,
                    b64_json: img.b64_json,
                })),
            };
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : 'Unknown error';
            logger.error({ requestId, error: errMsg }, '✗ Image generation failed');

            if (tracker) {
                tracker.record({
                    id: requestId,
                    timestamp: new Date().toISOString(),
                    tier: 'image',
                    provider: 'none',
                    model: body.model,
                    classificationScore: 0,
                    classificationType: `image:${quality}`,
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
                    userMessagePreview: promptPreview,
                    status: 'error',
                    errorMessage: errMsg,
                    agentId: agentId ?? undefined,
                });
            }

            reply.status(502).send(buildErrorResponse(
                `Image generation failed: ${errMsg}`,
                'server_error',
                'provider_error',
            ));
        }
    });
}
