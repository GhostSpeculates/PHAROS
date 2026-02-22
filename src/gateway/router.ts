import type { FastifyInstance } from 'fastify';
import type { PharosConfig } from '../config/schema.js';
import type { QueryClassifier } from '../classifier/index.js';
import type { ModelRouter, RoutingDecision } from '../router/index.js';
import type { ProviderRegistry } from '../providers/index.js';
import type { TrackingStore } from '../tracking/store.js';
import type { Logger } from '../utils/logger.js';
import { ChatCompletionRequestSchema } from './schemas/request.js';
import { buildChatCompletionResponse, buildStreamChunk, buildErrorResponse } from './schemas/response.js';
import { calculateCost, calculateBaselineCost } from '../tracking/cost-calculator.js';
import { generateCompletionId, generateRequestId } from '../utils/id.js';
import { initSSEHeaders, sendSSEChunk, sendSSEDone } from '../utils/stream.js';
import { createAuthMiddleware } from './middleware/auth.js';

/**
 * Register all API routes on the Fastify server.
 *
 * This is where the magic happens — each request flows through:
 * Validate → Classify → Route → Execute → Respond
 */
export function registerRoutes(
    app: FastifyInstance,
    config: PharosConfig,
    classifier: QueryClassifier,
    router: ModelRouter,
    registry: ProviderRegistry,
    tracker: TrackingStore | null,
    logger: Logger,
): void {
    const authMiddleware = createAuthMiddleware(config);

    // ─── Health Check ───
    app.get('/health', async () => {
        return {
            status: 'ok',
            service: 'pharos',
            version: '0.1.0',
            providers: registry.getStatus(),
        };
    });

    // ─── List Models ───
    app.get('/v1/models', { preHandler: authMiddleware }, async () => {
        const models: object[] = [];

        // Add pharos-auto as the primary model
        models.push({
            id: 'pharos-auto',
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'pharos',
        });

        // Add all configured models
        for (const [tierName, tierConfig] of Object.entries(config.tiers)) {
            for (const modelEntry of tierConfig.models) {
                if (registry.isAvailable(modelEntry.provider)) {
                    models.push({
                        id: modelEntry.model,
                        object: 'model',
                        created: Math.floor(Date.now() / 1000),
                        owned_by: `pharos-${tierName}`,
                    });
                }
            }
        }

        return { object: 'list', data: models };
    });

    // ─── Chat Completions — the main route ───
    app.post('/v1/chat/completions', { preHandler: authMiddleware }, async (request, reply) => {
        const requestStartTime = Date.now();
        const requestId = generateRequestId();
        const completionId = generateCompletionId();

        // 1. Validate the request
        const parseResult = ChatCompletionRequestSchema.safeParse(request.body);
        if (!parseResult.success) {
            const errors = parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
            reply
                .status(400)
                .send(buildErrorResponse(`Invalid request: ${errors.join('; ')}`, 'invalid_request_error'));
            return;
        }

        const body = parseResult.data;
        const messages = body.messages.map((m) => ({ role: m.role, content: m.content }));

        logger.info({ requestId, model: body.model, messageCount: messages.length }, 'Request received');

        try {
            // 2. Classify the query
            const classification = await classifier.classify(messages);

            // 3. Determine routing
            let routing: RoutingDecision;
            const directModel = router.resolveDirectModel(body.model);

            if (directModel) {
                // Client requested a specific model — bypass classification routing
                routing = router.routeDirect(directModel.provider, directModel.model, classification);
                logger.info(
                    {
                        requestId,
                        directModel: directModel.model,
                        classificationScore: classification.score,
                    },
                    'Direct route (classification bypassed for routing)',
                );
            } else {
                // Normal routing via classifier
                routing = router.route(classification);
            }

            logger.info(
                {
                    requestId,
                    tier: routing.tier,
                    provider: routing.provider,
                    model: routing.model,
                    score: classification.score,
                    type: classification.type,
                    classifierMs: classification.latencyMs,
                    failoverAttempts: routing.failoverAttempts,
                },
                '→ Routed',
            );

            // 4. Get the provider and execute
            const provider = registry.get(routing.provider);
            if (!provider) {
                throw new Error(`Provider ${routing.provider} not found in registry`);
            }

            const chatRequest = {
                model: routing.model,
                messages,
                temperature: body.temperature,
                maxTokens: body.max_tokens,
                topP: body.top_p,
                stream: body.stream,
                stop: body.stop ? (Array.isArray(body.stop) ? body.stop : [body.stop]) : undefined,
                ...(body.presence_penalty !== undefined && { presencePenalty: body.presence_penalty }),
                ...(body.frequency_penalty !== undefined && { frequencyPenalty: body.frequency_penalty }),
            };

            // ─── Streaming response ───
            if (body.stream) {
                initSSEHeaders(reply);

                // Add Pharos metadata headers
                reply.raw.setHeader('X-Pharos-Tier', routing.tier);
                reply.raw.setHeader('X-Pharos-Model', routing.model);
                reply.raw.setHeader('X-Pharos-Provider', routing.provider);
                reply.raw.setHeader('X-Pharos-Score', String(classification.score));
                reply.raw.setHeader('X-Pharos-Request-Id', requestId);

                let totalContent = '';
                let finalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

                try {
                    for await (const chunk of provider.chatStream(chatRequest)) {
                        if (chunk.content) {
                            totalContent += chunk.content;
                            sendSSEChunk(reply, buildStreamChunk({
                                id: completionId,
                                model: routing.model,
                                content: chunk.content,
                            }));
                        }

                        if (chunk.finishReason) {
                            if (chunk.usage) finalUsage = chunk.usage;
                            sendSSEChunk(reply, buildStreamChunk({
                                id: completionId,
                                model: routing.model,
                                content: '',
                                finishReason: chunk.finishReason,
                            }));
                        }
                    }
                } catch (streamError) {
                    const errMsg = streamError instanceof Error ? streamError.message : 'Unknown stream error';
                    logger.error({ requestId, error: errMsg }, 'Stream error during response');

                    // Send an SSE error event so the client knows something went wrong
                    sendSSEChunk(reply, {
                        error: {
                            message: `Stream interrupted: ${errMsg}`,
                            type: 'server_error',
                            code: 'stream_error',
                        },
                    });
                    sendSSEDone(reply);
                    return;
                }

                sendSSEDone(reply);

                // Track the request
                trackRequest(
                    tracker, config, requestId, routing, classification, finalUsage,
                    Date.now() - requestStartTime, true,
                );

                const cost = calculateCost(routing.provider, routing.model, finalUsage.promptTokens, finalUsage.completionTokens);
                logger.info(
                    {
                        requestId,
                        tier: routing.tier,
                        model: routing.model,
                        tokens: finalUsage.totalTokens,
                        cost: `$${cost.toFixed(6)}`,
                        latencyMs: Date.now() - requestStartTime,
                    },
                    '✓ Completed (stream)',
                );

                return;
            }

            // ─── Non-streaming response ───
            const response = await provider.chat(chatRequest);

            const cost = calculateCost(routing.provider, routing.model, response.usage.promptTokens, response.usage.completionTokens);

            // Track the request
            trackRequest(
                tracker, config, requestId, routing, classification, response.usage,
                Date.now() - requestStartTime, false,
            );

            logger.info(
                {
                    requestId,
                    tier: routing.tier,
                    model: routing.model,
                    tokens: response.usage.totalTokens,
                    cost: `$${cost.toFixed(6)}`,
                    latencyMs: Date.now() - requestStartTime,
                },
                '✓ Completed',
            );

            // Set Pharos metadata headers
            reply.header('X-Pharos-Tier', routing.tier);
            reply.header('X-Pharos-Model', routing.model);
            reply.header('X-Pharos-Provider', routing.provider);
            reply.header('X-Pharos-Score', String(classification.score));
            reply.header('X-Pharos-Cost', cost.toFixed(6));
            reply.header('X-Pharos-Request-Id', requestId);

            return buildChatCompletionResponse({
                id: completionId,
                model: routing.model,
                content: response.content,
                finishReason: response.finishReason,
                usage: response.usage,
            });
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : 'Unknown error';
            logger.error({ requestId, error: errMsg }, '✗ Request failed');

            reply.status(502).send(
                buildErrorResponse(
                    `Routing failed: ${errMsg}`,
                    'server_error',
                    'provider_error',
                ),
            );
        }
    });

    // ─── Cost/Stats endpoint ───
    app.get('/v1/stats', { preHandler: authMiddleware }, async () => {
        if (!tracker) {
            return { error: 'Tracking is disabled' };
        }
        return tracker.getSummary();
    });
}

/**
 * Record a request in the tracking store.
 */
function trackRequest(
    tracker: TrackingStore | null,
    config: PharosConfig,
    requestId: string,
    routing: RoutingDecision,
    classification: RoutingDecision['classification'],
    usage: { promptTokens: number; completionTokens: number; totalTokens: number },
    totalLatencyMs: number,
    stream: boolean,
): void {
    if (!tracker) return;

    const cost = calculateCost(routing.provider, routing.model, usage.promptTokens, usage.completionTokens);
    const baseline = calculateBaselineCost(
        usage.promptTokens,
        usage.completionTokens,
        config.tracking.baselineCostPerMillionInput,
        config.tracking.baselineCostPerMillionOutput,
    );

    tracker.record({
        id: requestId,
        timestamp: new Date().toISOString(),
        tier: routing.tier,
        provider: routing.provider,
        model: routing.model,
        classificationScore: classification.score,
        classificationType: classification.type,
        classificationLatencyMs: classification.latencyMs,
        tokensIn: usage.promptTokens,
        tokensOut: usage.completionTokens,
        estimatedCost: cost,
        baselineCost: baseline,
        savings: baseline - cost,
        totalLatencyMs,
        stream,
        isDirectRoute: routing.isDirectRoute,
    });
}
