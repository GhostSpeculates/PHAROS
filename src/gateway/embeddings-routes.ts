import type { FastifyInstance } from 'fastify';
import type { PharosConfig } from '../config/schema.js';
import type { EmbeddingsRouter } from '../providers/embeddings.js';
import type { TrackingStore } from '../tracking/store.js';
import type { WalletStore } from '../tracking/wallet-store.js';
import type { Logger } from '../utils/logger.js';
import { EmbeddingsRequestSchema } from './schemas/embeddings-request.js';
import { buildErrorResponse } from './schemas/response.js';
import { calculateCost } from '../tracking/cost-calculator.js';
import { generateRequestId } from '../utils/id.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createAgentRateLimiter } from './middleware/agent-rate-limit.js';
import { sendAlert } from '../utils/alerts.js';

/**
 * Register the /v1/embeddings endpoint.
 *
 * Pipeline: validate → auth → agent rate-limit → spending guard → route → track → respond.
 * No classifier, no tier-floor, no conversation tracking — embeddings have no
 * semantic-tier concept. Cost-priority routing via EmbeddingsRouter.
 */
export function registerEmbeddingsRoutes(
    app: FastifyInstance,
    config: PharosConfig,
    embeddingsRouter: EmbeddingsRouter,
    tracker: TrackingStore | null,
    logger: Logger,
    wallet?: WalletStore | null,
): void {
    const authMiddleware = createAuthMiddleware(config, wallet);
    const agentRateLimiter = createAgentRateLimiter(config.server.agentRateLimitPerMinute, logger);

    app.post('/v1/embeddings', { preHandler: authMiddleware }, async (request, reply) => {
        const requestStartTime = Date.now();
        const clientRequestId = request.headers['x-request-id'];
        const requestId = (typeof clientRequestId === 'string' && clientRequestId.trim())
            ? clientRequestId.trim()
            : generateRequestId();

        // 1. Validate
        const parseResult = EmbeddingsRequestSchema.safeParse(request.body);
        if (!parseResult.success) {
            const errors = parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
            reply.status(400).send(buildErrorResponse(`Invalid request: ${errors.join('; ')}`, 'invalid_request_error'));
            return;
        }
        const body = parseResult.data;

        // 2. Per-agent rate limiting (colon-suffix syntax: "pharos-embed:nex-labs" → agentId="nex-labs")
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

        // 3. Spending limit guard (pooled with chat — same daily/monthly cap)
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

        // Build a preview from the input string(s) for the dashboard audit log
        const inputPreview = (Array.isArray(body.input) ? body.input[0] ?? '' : body.input).slice(0, 80);
        logger.info({ requestId, model: body.model, agentId, inputCount: Array.isArray(body.input) ? body.input.length : 1 }, 'Embeddings request received');

        try {
            // 4. Route through configured providers
            const result = await embeddingsRouter.route(body.input);

            // 5. Build OpenAI-compatible response
            const responseBody = {
                object: 'list' as const,
                data: result.vectors.map((embedding, index) => ({
                    object: 'embedding' as const,
                    index,
                    embedding,
                })),
                model: result.model,
                usage: {
                    prompt_tokens: result.usage.promptTokens,
                    total_tokens: result.usage.totalTokens,
                },
            };

            const cost = calculateCost(result.provider, result.model, result.usage.promptTokens, 0);

            // 5b. Stamp wallet billing — onResponse hook reads this and debits the user.
            // No-op for operator requests (the hook checks isOperator). Skipped if cost=0.
            if (cost > 0) {
                request.pharosBilling = {
                    upstream_usd: cost,
                    model: result.model,
                    provider: result.provider,
                    modality: 'embedding',
                    request_id: requestId,
                };
            }

            // 6. Track in SQLite (reuses requests table — tier='embeddings' marks it as non-chat)
            if (tracker) {
                tracker.record({
                    id: requestId,
                    timestamp: new Date().toISOString(),
                    tier: 'embeddings',
                    provider: result.provider,
                    model: result.model,
                    classificationScore: 0,
                    classificationType: 'embedding',
                    classificationLatencyMs: 0,
                    classifierProvider: 'none',
                    tokensIn: result.usage.promptTokens,
                    tokensOut: 0,
                    estimatedCost: cost,
                    // Don't compare against chat baseline — embeddings have no chat-equivalent. Zero claimed savings.
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

            // 7. Pharos metadata headers
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
                    tokens: result.usage.totalTokens,
                    cost: `$${cost.toFixed(8)}`,
                    latencyMs: Date.now() - requestStartTime,
                    preview: inputPreview,
                    retries: result.failoverAttempts,
                },
                '✓ Embeddings completed',
            );

            return responseBody;
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : 'Unknown error';
            logger.error({ requestId, error: errMsg }, '✗ Embeddings request failed');

            if (tracker) {
                tracker.record({
                    id: requestId,
                    timestamp: new Date().toISOString(),
                    tier: 'embeddings',
                    provider: 'none',
                    model: body.model,
                    classificationScore: 0,
                    classificationType: 'embedding',
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
                `Embeddings routing failed: ${errMsg}`,
                'server_error',
                'provider_error',
            ));
        }
    });
}
