import type { FastifyInstance } from 'fastify';
import type { PharosConfig, TierName } from '../config/schema.js';
import type { QueryClassifier } from '../classifier/index.js';
import type { ModelRouter, RoutingDecision } from '../router/index.js';
import type { ProviderRegistry } from '../providers/index.js';
import type { ChatResponse } from '../providers/types.js';
import type { TrackingStore } from '../tracking/store.js';
import type { WalletStore } from '../tracking/wallet-store.js';
import type { Logger } from '../utils/logger.js';
import type { ConversationTracker } from '../router/conversation-tracker.js';
import type { PerformanceLearningStore } from '../learning/performance-store.js';
import type { Phase2Metrics } from '../tracking/phase2-metrics.js';

import { AnthropicMessagesRequestSchema } from '../translation/types.js';
import { anthropicToOpenAI, openAIToAnthropic } from '../translation/anthropic-openai.js';
import { AnthropicStreamTranslator } from '../translation/anthropic-stream.js';
import { buildErrorResponse } from './schemas/response.js';
import { calculateCost, calculateBaselineCost } from '../tracking/cost-calculator.js';
import { generateRequestId } from '../utils/id.js';
import { initSSEHeaders, sendSSEChunk, isClientConnected } from '../utils/stream.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createAgentRateLimiter } from './middleware/agent-rate-limit.js';
import { estimateTokens, getContextWindow, isContextSizeError } from '../utils/context.js';
import { isTransientError, calculateBackoffMs, sleep } from '../utils/retry.js';
import { sendAlert } from '../utils/alerts.js';
import { isMemoryFlush } from '../utils/flush-detector.js';
import { applyAgentProfile } from '../router/agent-profile.js';
import { applyTierFloor } from '../router/conversation-tracker.js';

/**
 * Register the Anthropic-shape /v1/messages endpoint.
 *
 * Translation at the edge: incoming Anthropic body → OpenAI shape, then run
 * the same orchestration the chat path runs (auth, agent rate limit, classify,
 * route, retry/failover, billing stamp), then translate the response back.
 *
 * Why duplicated orchestration vs reusing the chat handler? See
 * docs/superpowers/plans/2026-05-02-anthropic-messages-endpoint.md — extraction
 * (Option A) is scheduled as a follow-up; this is intentional bounded
 * scaffolding to ship the translator without regressing /v1/chat/completions.
 */
export function registerMessagesRoutes(
    app: FastifyInstance,
    config: PharosConfig,
    classifier: QueryClassifier,
    router: ModelRouter,
    registry: ProviderRegistry,
    tracker: TrackingStore | null,
    logger: Logger,
    conversationTracker?: ConversationTracker,
    learningStore?: PerformanceLearningStore | null,
    phase2Metrics?: Phase2Metrics,
    wallet?: WalletStore | null,
): void {
    const authMiddleware = createAuthMiddleware(config, wallet);
    const agentRateLimiter = createAgentRateLimiter(config.server.agentRateLimitPerMinute, logger);

    app.post('/v1/messages', { preHandler: authMiddleware }, async (request, reply) => {
        const requestStartTime = Date.now();
        const clientRequestId = request.headers['x-request-id'];
        const requestId =
            typeof clientRequestId === 'string' && clientRequestId.trim()
                ? clientRequestId.trim()
                : generateRequestId();

        const conversationId =
            typeof request.headers['x-conversation-id'] === 'string'
                ? request.headers['x-conversation-id'].trim() || null
                : null;

        // 1. Validate Anthropic-shape body
        const parseResult = AnthropicMessagesRequestSchema.safeParse(request.body);
        if (!parseResult.success) {
            const errors = parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
            reply
                .status(400)
                .send(buildErrorResponse(`Invalid request: ${errors.join('; ')}`, 'invalid_request_error'));
            return;
        }

        const anthropicBody = parseResult.data;

        // 2. Translate to OpenAI shape (preserves agent-id, system, tools, etc.)
        const openAIBody = anthropicToOpenAI(anthropicBody);
        const messages = openAIBody.messages;

        logger.info(
            {
                requestId,
                model: anthropicBody.model,
                messageCount: messages.length,
                shape: 'anthropic',
            },
            'Request received',
        );

        // 3. Per-agent rate limiting (same logic as chat path)
        const agentId = agentRateLimiter.extractAgent(anthropicBody.model);
        if (agentId) {
            const r = agentRateLimiter.check(agentId);
            if (!r.allowed) {
                reply.header('Retry-After', String(r.retryAfterSeconds));
                reply
                    .status(429)
                    .send(buildErrorResponse(
                        `Agent "${agentId}" rate limited. Retry after ${r.retryAfterSeconds}s.`,
                        'rate_limit_error',
                    ));
                return;
            }
        }

        // Spending limits — same logic as chat path
        if (tracker) {
            const { dailyLimit, monthlyLimit } = config.spending;
            if (dailyLimit !== null) {
                const dailySpend = tracker.getDailySpend();
                if (dailySpend >= dailyLimit) {
                    sendAlert(
                        'Daily spending limit reached',
                        `Spent $${dailySpend.toFixed(4)} / $${dailyLimit.toFixed(2)} daily limit`,
                        'critical',
                        'spending-daily-100',
                    );
                    reply.status(429).send(
                        buildErrorResponse(
                            `Daily spending limit ($${dailyLimit.toFixed(2)}) reached. Current: $${dailySpend.toFixed(4)}`,
                            'rate_limit_error',
                        ),
                    );
                    return;
                }
                if (dailySpend >= dailyLimit * 0.8) {
                    sendAlert(
                        'Daily spending at 80%',
                        `$${dailySpend.toFixed(4)} / $${dailyLimit.toFixed(2)} (${((dailySpend / dailyLimit) * 100).toFixed(1)}%)`,
                        'warning',
                        'spending-daily-80',
                    );
                }
            }
            if (monthlyLimit !== null) {
                const monthlySpend = tracker.getMonthlySpend();
                if (monthlySpend >= monthlyLimit) {
                    sendAlert(
                        'Monthly spending limit reached',
                        `Spent $${monthlySpend.toFixed(4)} / $${monthlyLimit.toFixed(2)} monthly limit`,
                        'critical',
                        'spending-monthly-100',
                    );
                    reply.status(429).send(
                        buildErrorResponse(
                            `Monthly spending limit ($${monthlyLimit.toFixed(2)}) reached. Current: $${monthlySpend.toFixed(4)}`,
                            'rate_limit_error',
                        ),
                    );
                    return;
                }
                if (monthlySpend >= monthlyLimit * 0.8) {
                    sendAlert(
                        'Monthly spending at 80%',
                        `$${monthlySpend.toFixed(4)} / $${monthlyLimit.toFixed(2)} (${((monthlySpend / monthlyLimit) * 100).toFixed(1)}%)`,
                        'warning',
                        'spending-monthly-80',
                    );
                }
            }
        }

        let classification: Awaited<ReturnType<typeof classifier.classify>> | undefined;
        let routing: RoutingDecision | undefined;
        let conversationTierFloor: string | undefined;

        try {
            // 4. Classify
            if (isMemoryFlush(messages)) {
                classification = {
                    score: 2,
                    type: 'conversation',
                    classifierProvider: 'flush-detector',
                    latencyMs: 0,
                    isFallback: false,
                };
            } else {
                classification = await classifier.classify(messages);
            }

            // 5. Agent profile clamp
            const adjusted = applyAgentProfile(classification.score, agentId ?? undefined, config);
            if (adjusted.adjustedScore !== classification.score) {
                classification = { ...classification, score: adjusted.adjustedScore };
            }

            // 6. Route
            const directModel = router.resolveDirectModel(anthropicBody.model);
            const taskTypeOverride = router.resolveTaskTypeOverride(anthropicBody.model);
            if (taskTypeOverride) {
                classification = { ...classification, type: taskTypeOverride };
            }

            if (directModel) {
                routing = router.routeDirect(directModel.provider, directModel.model, classification);
            } else {
                routing = router.route(classification);
                if (conversationId && conversationTracker && config.conversation?.enabled) {
                    const floor = conversationTracker.getTierFloor(conversationId);
                    if (floor) {
                        const elevatedTier = applyTierFloor(routing.tier as TierName, floor);
                        if (elevatedTier !== routing.tier) {
                            const elevatedScore = config.tiers[elevatedTier].scoreRange[0];
                            routing = router.route({ ...classification, score: elevatedScore });
                            conversationTierFloor = floor;
                        }
                    }
                    phase2Metrics?.recordConversationFloor(!!conversationTierFloor);
                }
            }

            logger.info(
                {
                    requestId,
                    tier: routing.tier,
                    provider: routing.provider,
                    model: routing.model,
                    score: classification.score,
                },
                '→ Routed',
            );

            // 7. Build provider chat request
            const chatRequest = {
                model: routing.model,
                messages,
                temperature: openAIBody.temperature,
                maxTokens: openAIBody.max_tokens,
                topP: openAIBody.top_p,
                stream: openAIBody.stream,
                stop: openAIBody.stop,
                ...(openAIBody.thinking !== undefined && { thinking: openAIBody.thinking }),
            };

            const candidates = directModel
                ? [{ provider: routing.provider, model: routing.model, tier: routing.tier }]
                : router.getCandidates(classification);

            if (candidates.length === 0) {
                throw new Error('No available providers found');
            }

            // Filter by context window for oversized requests
            const estimatedTokens = estimateTokens(messages);
            let filteredCandidates = candidates;
            if (estimatedTokens > config.router.oversizedThresholdTokens) {
                filteredCandidates = candidates.filter((c) => getContextWindow(c.model) > estimatedTokens);
                if (filteredCandidates.length === 0) filteredCandidates = candidates;
            }

            let retryCount = 0;

            // ─── Streaming path ───
            if (openAIBody.stream) {
                let succeeded = false;
                let clientDisconnected = false;
                reply.raw.on('close', () => {
                    clientDisconnected = true;
                });

                for (const candidate of filteredCandidates) {
                    const p = registry.get(candidate.provider);
                    if (!p) continue;
                    if (clientDisconnected) return;

                    for (let attempt = 0; attempt < 2; attempt++) {
                        try {
                            const streamReq = { ...chatRequest, model: candidate.model };
                            let headersSent = false;
                            const streamTranslator = new AnthropicStreamTranslator({
                                messageId: requestId,
                                model: anthropicBody.model,
                                inputTokens: estimatedTokens,
                            });
                            let finalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

                            // Known limitation: ChatStreamChunk (src/providers/types.ts) only
                            // carries `content: string`; tool_calls aren't surfaced through the
                            // streaming interface. Streaming `/v1/messages` calls that result in
                            // tool use will produce a valid event sequence with zero tool_use
                            // content blocks. Address when the first customer needs streaming
                            // tool calls — non-streaming tool_use already works.
                            for await (const chunk of p.chatStream(streamReq)) {
                                if (clientDisconnected || !isClientConnected(reply)) return;

                                if (!headersSent) {
                                    reply.raw.setHeader('X-Pharos-Tier', candidate.tier);
                                    reply.raw.setHeader('X-Pharos-Model', candidate.model);
                                    reply.raw.setHeader('X-Pharos-Provider', candidate.provider);
                                    reply.raw.setHeader('X-Pharos-Score', String(classification.score));
                                    reply.raw.setHeader('X-Pharos-Request-Id', requestId);
                                    reply.raw.setHeader('X-Pharos-Shape', 'anthropic');
                                    initSSEHeaders(reply);
                                    headersSent = true;
                                }

                                // Translate this OpenAI chunk into Anthropic events
                                const openaiChunk = {
                                    choices: [
                                        {
                                            delta: chunk.content ? { content: chunk.content } : {},
                                            ...(chunk.finishReason ? { finish_reason: chunk.finishReason } : {}),
                                        },
                                    ],
                                };
                                if (chunk.content) {
                                    const events = streamTranslator.handleDelta(openaiChunk);
                                    for (const ev of events) {
                                        sendSSEChunk(reply, ev, ev.type);
                                    }
                                }
                                if (chunk.finishReason) {
                                    if (chunk.usage) finalUsage = chunk.usage;
                                    const events = streamTranslator.handleFinish(chunk.finishReason, finalUsage);
                                    for (const ev of events) {
                                        sendSSEChunk(reply, ev, ev.type);
                                    }
                                }
                            }

                            // Anthropic protocol doesn't use [DONE], but we still must
                            // end the socket — otherwise the Agent SDK client hangs.
                            reply.raw.end();

                            // Latency + tracking
                            const providerLatency = Date.now() - requestStartTime - (classification.latencyMs ?? 0);
                            p.recordLatency(Math.max(0, providerLatency));

                            const cost = calculateCost(
                                candidate.provider,
                                candidate.model,
                                finalUsage.promptTokens,
                                finalUsage.completionTokens,
                            );
                            if (cost > 0) {
                                request.pharosBilling = {
                                    upstream_usd: cost,
                                    model: candidate.model,
                                    provider: candidate.provider,
                                    modality: 'chat',
                                    request_id: requestId,
                                };
                            }

                            const finalRouting = {
                                ...routing,
                                provider: candidate.provider,
                                model: candidate.model,
                                tier: candidate.tier,
                            };
                            recordRequest(
                                tracker,
                                config,
                                requestId,
                                finalRouting,
                                classification,
                                finalUsage,
                                Date.now() - requestStartTime,
                                true,
                                getMessagePreview(anthropicBody),
                                undefined,
                                { agentId: agentId ?? undefined, conversationId: conversationId ?? undefined, retryCount },
                            );
                            learningStore?.recordOutcome(
                                candidate.provider,
                                candidate.model,
                                classification.type,
                                true,
                                Math.max(0, providerLatency),
                            );
                            if (conversationId && conversationTracker && config.conversation?.enabled) {
                                conversationTracker.recordTier(conversationId, candidate.tier as TierName);
                            }

                            logger.info(
                                {
                                    requestId,
                                    tier: candidate.tier,
                                    model: candidate.model,
                                    cost: `$${cost.toFixed(6)}`,
                                    latencyMs: Date.now() - requestStartTime,
                                    shape: 'anthropic',
                                },
                                '✓ Completed (stream)',
                            );

                            succeeded = true;
                            break;
                        } catch (streamError) {
                            if (reply.raw.headersSent) {
                                logger.error({ requestId, error: errMsg(streamError) }, 'Stream error mid-response');
                                reply.raw.end();  // close hanging socket
                                return;
                            }
                            const eMsg = errMsg(streamError);
                            if (isContextSizeError(eMsg)) p.undoLastError();
                            if (attempt === 0 && isTransientError(streamError)) {
                                await sleep(calculateBackoffMs(0));
                                continue;
                            }
                            retryCount++;
                            learningStore?.recordOutcome(candidate.provider, candidate.model, classification.type, false, 0);
                            break;
                        }
                    }
                    if (succeeded) break;
                }

                if (!succeeded) throw new Error(`All providers failed after ${retryCount} retry attempts`);
                return;
            }

            // ─── Non-streaming path ───
            let response: ChatResponse | null = null;
            let usedProvider = routing.provider;
            let usedModel = routing.model;
            let usedTier = routing.tier;

            for (const candidate of filteredCandidates) {
                const p = registry.get(candidate.provider);
                if (!p) continue;

                let candidateSucceeded = false;
                for (let attempt = 0; attempt < 2; attempt++) {
                    try {
                        const callStart = Date.now();
                        response = await p.chat({ ...chatRequest, model: candidate.model });
                        p.recordLatency(Date.now() - callStart);
                        usedProvider = candidate.provider;
                        usedModel = candidate.model;
                        usedTier = candidate.tier;
                        candidateSucceeded = true;
                        break;
                    } catch (err) {
                        const eMsg = errMsg(err);
                        if (isContextSizeError(eMsg)) p.undoLastError();
                        if (attempt === 0 && isTransientError(err)) {
                            await sleep(calculateBackoffMs(0));
                            continue;
                        }
                        retryCount++;
                        learningStore?.recordOutcome(candidate.provider, candidate.model, classification.type, false, 0);
                        break;
                    }
                }
                if (candidateSucceeded) break;
            }

            if (!response) {
                throw new Error(`All providers failed after ${retryCount} retry attempts`);
            }

            const cost = calculateCost(
                usedProvider,
                usedModel,
                response.usage.promptTokens,
                response.usage.completionTokens,
            );
            if (cost > 0) {
                request.pharosBilling = {
                    upstream_usd: cost,
                    model: usedModel,
                    provider: usedProvider,
                    modality: 'chat',
                    request_id: requestId,
                };
            }

            const finalRouting = { ...routing, provider: usedProvider, model: usedModel, tier: usedTier };
            recordRequest(
                tracker,
                config,
                requestId,
                finalRouting,
                classification,
                response.usage,
                Date.now() - requestStartTime,
                false,
                getMessagePreview(anthropicBody),
                undefined,
                { agentId: agentId ?? undefined, conversationId: conversationId ?? undefined, retryCount },
            );
            const providerLatencyMs = Date.now() - requestStartTime - (classification.latencyMs ?? 0);
            learningStore?.recordOutcome(usedProvider, usedModel, classification.type, true, Math.max(0, providerLatencyMs));
            if (conversationId && conversationTracker && config.conversation?.enabled) {
                conversationTracker.recordTier(conversationId, usedTier as TierName);
            }

            logger.info(
                {
                    requestId,
                    tier: usedTier,
                    model: usedModel,
                    cost: `$${cost.toFixed(6)}`,
                    latencyMs: Date.now() - requestStartTime,
                    shape: 'anthropic',
                },
                '✓ Completed',
            );

            // Translate response to Anthropic shape
            // openAIToAnthropic expects OpenAI snake_case usage fields
            const anthropicResponse = openAIToAnthropic(
                {
                    id: requestId,
                    choices: [
                        {
                            index: 0,
                            message: {
                                role: 'assistant',
                                content: response.content,
                            },
                            finish_reason: response.finishReason,
                        },
                    ],
                    usage: {
                        prompt_tokens: response.usage.promptTokens,
                        completion_tokens: response.usage.completionTokens,
                        total_tokens: response.usage.totalTokens,
                    },
                    model: usedModel,
                },
                anthropicBody.model,
            );

            reply.header('X-Pharos-Tier', usedTier);
            reply.header('X-Pharos-Model', usedModel);
            reply.header('X-Pharos-Provider', usedProvider);
            reply.header('X-Pharos-Score', String(classification.score));
            reply.header('X-Pharos-Cost', cost.toFixed(6));
            reply.header('X-Pharos-Request-Id', requestId);
            reply.header('X-Pharos-Shape', 'anthropic');
            return anthropicResponse;
        } catch (error) {
            const eMsg = errMsg(error);
            logger.error({ requestId, error: eMsg }, '✗ Request failed');

            // Track the failed request if we have enough context
            if (classification && routing) {
                recordRequest(
                    tracker,
                    config,
                    requestId,
                    routing,
                    classification,
                    { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                    Date.now() - requestStartTime,
                    parseResult.success ? parseResult.data.stream : false,
                    getMessagePreview(anthropicBody),
                    { status: 'error', errorMessage: eMsg },
                    { agentId: agentId ?? undefined, conversationId: conversationId ?? undefined, retryCount: 0 },
                );
            }

            if (!reply.raw.headersSent) {
                reply.status(502).send(buildErrorResponse(`Routing failed: ${eMsg}`, 'server_error', 'provider_error'));
            }
        }
    });
}

function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

function getMessagePreview(req: { messages: Array<{ role: string; content: unknown }> }): string {
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return '';
    if (typeof lastUser.content === 'string') return lastUser.content.slice(0, 80);
    if (Array.isArray(lastUser.content)) {
        const text = lastUser.content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join(' ');
        return text.slice(0, 80);
    }
    return '';
}

function recordRequest(
    tracker: TrackingStore | null,
    config: PharosConfig,
    requestId: string,
    routing: RoutingDecision,
    classification: RoutingDecision['classification'],
    usage: { promptTokens: number; completionTokens: number; totalTokens: number },
    totalLatencyMs: number,
    stream: boolean,
    userMessagePreview: string,
    errorInfo?: { status: 'error'; errorMessage: string },
    extra?: { agentId?: string; conversationId?: string; retryCount?: number },
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
        classifierProvider: classification.classifierProvider ?? 'unknown',
        tokensIn: usage.promptTokens,
        tokensOut: usage.completionTokens,
        estimatedCost: cost,
        baselineCost: baseline,
        savings: baseline - cost,
        totalLatencyMs,
        stream,
        isDirectRoute: routing.isDirectRoute,
        userMessagePreview,
        ...(errorInfo && { status: errorInfo.status, errorMessage: errorInfo.errorMessage }),
        ...(extra && { agentId: extra.agentId, conversationId: extra.conversationId, retryCount: extra.retryCount }),
    });
}
