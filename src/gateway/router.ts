import type { FastifyInstance } from 'fastify';
import type { PharosConfig } from '../config/schema.js';
import type { QueryClassifier } from '../classifier/index.js';
import type { ModelRouter, RoutingDecision } from '../router/index.js';
import type { ProviderRegistry } from '../providers/index.js';
import type { ChatMessage } from '../providers/types.js';
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

    // ─── Root — Status Dashboard ───
    app.get('/', async (_request, reply) => {
        const status = registry.getStatus();
        const providers = Object.entries(status)
            .map(([name, info]: [string, any]) => {
                const icon = info.available && info.healthy ? '&#9679;' : '&#9675;';
                const color = info.available && info.healthy ? '#22c55e' : '#6b7280';
                return `<span style="color:${color}">${icon} ${name}</span>`;
            })
            .join('&nbsp;&nbsp;');

        const stats = tracker?.getSummary();
        const totalReqs = stats?.totalRequests ?? 0;
        const totalCost = stats?.totalCost ?? 0;
        const totalSavings = stats?.totalSavings ?? 0;
        const savingsPct = stats?.savingsPercent ?? 0;

        const tierRows = stats?.byTier
            ? Object.entries(stats.byTier)
                .map(([tier, data]: [string, any]) =>
                    `<tr><td>${tier}</td><td>${data.count}</td><td>$${data.cost.toFixed(6)}</td></tr>`)
                .join('')
            : '<tr><td colspan="3">No requests yet</td></tr>';

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Pharos Gateway</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0a0a;color:#e5e5e5;min-height:100vh;display:flex;align-items:center;justify-content:center}
.container{max-width:640px;width:100%;padding:2rem}
h1{font-size:2rem;font-weight:700;margin-bottom:.25rem}
h1 span{color:#facc15}
.subtitle{color:#a3a3a3;margin-bottom:2rem;font-size:.9rem}
.card{background:#171717;border:1px solid #262626;border-radius:12px;padding:1.5rem;margin-bottom:1rem}
.card h2{font-size:.85rem;text-transform:uppercase;letter-spacing:.05em;color:#a3a3a3;margin-bottom:1rem}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;text-align:center}
.stat-value{font-size:1.5rem;font-weight:700;color:#fff}
.stat-label{font-size:.75rem;color:#737373;margin-top:.15rem}
.savings .stat-value{color:#22c55e}
.providers{display:flex;gap:.75rem;flex-wrap:wrap;font-size:.9rem}
table{width:100%;border-collapse:collapse;font-size:.85rem}
th,td{text-align:left;padding:.5rem .75rem;border-bottom:1px solid #262626}
th{color:#a3a3a3;font-weight:500}
.endpoints{font-size:.8rem;color:#737373;line-height:1.8}
.endpoints code{background:#262626;padding:.15rem .4rem;border-radius:4px;color:#d4d4d4;font-size:.75rem}
a{color:#facc15;text-decoration:none}
a:hover{text-decoration:underline}
</style>
</head>
<body>
<div class="container">
<h1><span>&#9889;</span> Pharos</h1>
<p class="subtitle">Intelligent LLM Routing Gateway &mdash; v0.1.0</p>

<div class="card">
<h2>Providers</h2>
<div class="providers">${providers}</div>
</div>

<div class="card">
<h2>Usage</h2>
<div class="stats">
<div><div class="stat-value">${totalReqs}</div><div class="stat-label">Requests</div></div>
<div><div class="stat-value">$${totalCost.toFixed(4)}</div><div class="stat-label">Total Cost</div></div>
<div class="savings"><div class="stat-value">${savingsPct.toFixed(1)}%</div><div class="stat-label">Savings</div></div>
</div>
</div>

<div class="card">
<h2>By Tier</h2>
<table><tr><th>Tier</th><th>Requests</th><th>Cost</th></tr>${tierRows}</table>
</div>

<div class="card">
<h2>API Endpoints</h2>
<div class="endpoints">
<code>POST</code> <a href="/v1/chat/completions">/v1/chat/completions</a> &mdash; Routing endpoint<br/>
<code>GET</code> <a href="/v1/models">/v1/models</a> &mdash; List models<br/>
<code>GET</code> <a href="/v1/stats">/v1/stats</a> &mdash; Cost &amp; savings JSON<br/>
<code>GET</code> <a href="/health">/health</a> &mdash; Health check
</div>
</div>

</div>
</body>
</html>`;

        reply.type('text/html').send(html);
    });

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
        // Pass messages through as-is — providers handle both string and array content
        const messages = body.messages as ChatMessage[];

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
                // Set Pharos metadata headers BEFORE initSSEHeaders writes them out
                reply.raw.setHeader('X-Pharos-Tier', routing.tier);
                reply.raw.setHeader('X-Pharos-Model', routing.model);
                reply.raw.setHeader('X-Pharos-Provider', routing.provider);
                reply.raw.setHeader('X-Pharos-Score', String(classification.score));
                reply.raw.setHeader('X-Pharos-Request-Id', requestId);

                initSSEHeaders(reply);

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

            // If reply was already hijacked (streaming started), write error to raw stream
            if (reply.raw.headersSent) {
                sendSSEChunk(reply, {
                    error: {
                        message: `Routing failed: ${errMsg}`,
                        type: 'server_error',
                        code: 'provider_error',
                    },
                });
                sendSSEDone(reply);
            } else {
                reply.status(502).send(
                    buildErrorResponse(
                        `Routing failed: ${errMsg}`,
                        'server_error',
                        'provider_error',
                    ),
                );
            }
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
