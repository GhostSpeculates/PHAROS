import type { FastifyInstance } from 'fastify';
import type { PharosConfig, TierName } from '../config/schema.js';
import type { QueryClassifier } from '../classifier/index.js';
import type { ModelRouter, RoutingDecision } from '../router/index.js';
import type { ProviderRegistry } from '../providers/index.js';
import type { ChatMessage, ChatResponse } from '../providers/types.js';
import type { TrackingStore } from '../tracking/store.js';
import type { Logger } from '../utils/logger.js';
import { ChatCompletionRequestSchema } from './schemas/request.js';
import { buildChatCompletionResponse, buildStreamChunk, buildErrorResponse } from './schemas/response.js';
import { calculateCost, calculateBaselineCost } from '../tracking/cost-calculator.js';
import { generateCompletionId, generateRequestId } from '../utils/id.js';
import { initSSEHeaders, sendSSEChunk, sendSSEDone, isClientConnected } from '../utils/stream.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createAgentRateLimiter } from './middleware/agent-rate-limit.js';
import { findModel } from '../registry/models.js';
import { estimateTokens, getContextWindow, isContextSizeError } from '../utils/context.js';
import { isTransientError, calculateBackoffMs, sleep } from '../utils/retry.js';
import { sendAlert } from '../utils/alerts.js';
import { ConversationTracker, applyTierFloor } from '../router/conversation-tracker.js';

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
    conversationTracker?: ConversationTracker,
): void {
    const authMiddleware = createAuthMiddleware(config);
    const agentRateLimiter = createAgentRateLimiter(config.server.agentRateLimitPerMinute, logger);

    // ─── Root — Status Dashboard ───
    app.get('/', async (_request, reply) => {
        const status = registry.getStatus();
        const providers = Object.entries(status)
            .map(([name, info]: [string, any]) => {
                const icon = info.available && info.healthy ? '&#9679;' : '&#9675;';
                const color = info.available && info.healthy ? '#22c55e' : '#6b7280';
                const lat = info.latency;
                const latencyText = lat.samples > 0
                    ? `${lat.avgMs}ms avg`
                    : 'no data';
                const degradedTag = lat.degraded
                    ? ' <span style="color:#ef4444;font-size:.7rem">&#9888; SLOW</span>'
                    : '';
                return `<span style="color:${color}">${icon} ${name} <span style="color:#737373;font-size:.75rem">(${latencyText}${degradedTag})</span></span>`;
            })
            .join('&nbsp;&nbsp;');

        const stats = tracker?.getSummary();
        const totalReqs = stats?.totalRequests ?? 0;
        const totalCost = stats?.totalCost ?? 0;
        const totalSavings = stats?.totalSavings ?? 0;
        const savingsPct = stats?.savingsPercent ?? 0;
        const totalErrors = stats?.totalErrors ?? 0;
        const errorRate = stats?.errorRate ?? 0;
        const errorRateColor = errorRate < 1 ? '#22c55e' : errorRate <= 5 ? '#eab308' : '#ef4444';

        const tierRows = stats?.byTier
            ? Object.entries(stats.byTier)
                .map(([tier, data]: [string, any]) =>
                    `<tr><td>${tier}</td><td>${data.count}</td><td>$${data.cost.toFixed(6)}</td></tr>`)
                .join('')
            : '<tr><td colspan="3">No requests yet</td></tr>';

        const recent = tracker?.getRecent(25) ?? [];
        const tierColors: Record<string, string> = {
            free: '#22c55e', economical: '#3b82f6', premium: '#a855f7', frontier: '#f59e0b',
        };
        const recentRows = recent.length > 0
            ? recent.map((r) => {
                const time = new Date(r.timestamp).toLocaleTimeString('en-US', { hour12: false });
                const tierColor = tierColors[r.tier] ?? '#737373';
                const preview = r.preview
                    ? r.preview.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    : '<span style="color:#525252">—</span>';
                const statusIcon = r.status === 'error'
                    ? '<span style="color:#ef4444" title="' + (r.errorMessage ?? '').replace(/"/g, '&quot;') + '">&#10007;</span>'
                    : '<span style="color:#22c55e">&#10003;</span>';
                return `<tr>
<td style="white-space:nowrap">${time}</td>
<td>${statusIcon}</td>
<td class="preview-cell" title="${r.preview ?? ''}">${preview}</td>
<td>${r.score}</td>
<td>${r.type}</td>
<td><span style="color:${tierColor}">${r.tier}</span></td>
<td>${r.provider}</td>
<td style="font-size:.75rem">${r.model}</td>
<td style="font-size:.75rem;color:#737373">${r.classifierProvider ?? ''}</td>
<td>${r.tokens.toLocaleString()}</td>
<td>$${r.cost.toFixed(6)}</td>
<td>${r.latencyMs.toLocaleString()}ms</td>
</tr>`;
            }).join('')
            : '<tr><td colspan="12" style="text-align:center;color:#525252">No requests yet</td></tr>';

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Pharos Gateway</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0a0a;color:#e5e5e5;min-height:100vh;padding:2rem 1rem}
.container{max-width:1100px;width:100%;margin:0 auto}
h1{font-size:2rem;font-weight:700;margin-bottom:.25rem}
h1 span{color:#facc15}
.subtitle{color:#a3a3a3;margin-bottom:2rem;font-size:.9rem}
.top-grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1rem}
.card{background:#171717;border:1px solid #262626;border-radius:12px;padding:1.5rem;margin-bottom:1rem}
.card h2{font-size:.85rem;text-transform:uppercase;letter-spacing:.05em;color:#a3a3a3;margin-bottom:1rem}
.card h2 .refresh{float:right;font-size:.7rem;color:#525252;text-transform:none;letter-spacing:0}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;text-align:center}
.stat-value{font-size:1.5rem;font-weight:700;color:#fff}
.stat-label{font-size:.75rem;color:#737373;margin-top:.15rem}
.savings .stat-value{color:#22c55e}
.providers{display:flex;gap:.75rem;flex-wrap:wrap;font-size:.9rem}
table{width:100%;border-collapse:collapse;font-size:.8rem}
th,td{text-align:left;padding:.4rem .5rem;border-bottom:1px solid #262626}
th{color:#a3a3a3;font-weight:500;white-space:nowrap}
.preview-cell{max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d4d4d4}
.recent-table{overflow-x:auto}
.endpoints{font-size:.8rem;color:#737373;line-height:1.8}
.endpoints code{background:#262626;padding:.15rem .4rem;border-radius:4px;color:#d4d4d4;font-size:.75rem}
a{color:#facc15;text-decoration:none}
a:hover{text-decoration:underline}
@media(max-width:768px){.top-grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="container">
<h1><span>&#9889;</span> Pharos</h1>
<p class="subtitle">Intelligent LLM Routing Gateway &mdash; v0.1.0</p>

<div class="top-grid">
<div>
<div class="card">
<h2>Providers</h2>
<div class="providers">${providers}</div>
</div>

<div class="card">
<h2>Usage</h2>
<div class="stats" style="grid-template-columns:repeat(4,1fr)">
<div><div class="stat-value">${totalReqs}</div><div class="stat-label">Requests</div></div>
<div><div class="stat-value">$${totalCost.toFixed(4)}</div><div class="stat-label">Total Cost</div></div>
<div class="savings"><div class="stat-value">${savingsPct.toFixed(1)}%</div><div class="stat-label">Savings</div></div>
<div><div class="stat-value" style="color:${errorRateColor}">${totalErrors}<span style="font-size:.75rem;color:#737373"> (${errorRate.toFixed(1)}%)</span></div><div class="stat-label">Errors</div></div>
</div>
</div>
</div>

<div>
<div class="card">
<h2>By Tier</h2>
<table><tr><th>Tier</th><th>Requests</th><th>Cost</th></tr>${tierRows}</table>
</div>

<div class="card">
<h2>Provider Latency</h2>
<table><tr><th>Provider</th><th>Avg</th><th>P95</th><th>Samples</th><th>Status</th></tr>
${Object.entries(status).map(([name, info]: [string, any]) => {
    const lat = info.latency;
    if (!info.available) return `<tr><td>${name}</td><td colspan="4" style="color:#525252">unavailable</td></tr>`;
    if (lat.samples === 0) return `<tr><td>${name}</td><td colspan="4" style="color:#525252">no data yet</td></tr>`;
    const statusColor = lat.degraded ? '#ef4444' : '#22c55e';
    const statusText = lat.degraded ? 'degraded' : 'healthy';
    return `<tr><td>${name}</td><td>${lat.avgMs}ms</td><td>${lat.p95Ms}ms</td><td>${lat.samples}</td><td style="color:${statusColor}">${statusText}</td></tr>`;
}).join('')}
</table>
</div>

<div class="card">
<h2>API Endpoints</h2>
<div class="endpoints">
<code>POST</code> <a href="/v1/chat/completions">/v1/chat/completions</a> &mdash; Routing endpoint<br/>
<code>GET</code> <a href="/v1/models">/v1/models</a> &mdash; List models<br/>
<code>GET</code> <a href="/v1/stats">/v1/stats</a> &mdash; Cost &amp; savings JSON<br/>
<code>GET</code> <a href="/v1/stats/recent">/v1/stats/recent</a> &mdash; Recent requests JSON<br/>
<code>GET</code> <a href="/health">/health</a> &mdash; Health check
</div>
</div>
</div>
</div>

<div class="card">
<h2>Recent Requests <span class="refresh" id="countdown">refreshing in 30s</span></h2>
<div class="recent-table">
<table>
<tr><th>Time</th><th></th><th>Message</th><th>Score</th><th>Type</th><th>Tier</th><th>Provider</th><th>Model</th><th>Classifier</th><th>Tokens</th><th>Cost</th><th>Latency</th></tr>
${recentRows}
</table>
</div>
</div>

</div>
<script>
(function(){
  var s=30,el=document.getElementById('countdown');
  setInterval(function(){s--;if(s<=0){location.reload()}else{el.textContent='refreshing in '+s+'s'}},1000);
})();
</script>
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
        const seen = new Set<string>();
        const created = Math.floor(Date.now() / 1000);

        // Add pharos-auto as the primary model
        models.push({
            id: 'pharos-auto',
            object: 'model',
            created,
            owned_by: 'pharos',
            pharos: {
                provider: 'pharos',
                displayName: 'Pharos Auto-Router',
                tier: 'auto',
                contextWindow: null,
                capabilities: ['code', 'math', 'reasoning', 'creative', 'conversation', 'multilingual'],
                pricing: null,
                speed: null,
            },
        });

        // Add virtual task-type models
        const virtualModels = [
            { id: 'pharos-code', displayName: 'Pharos Code Router', description: 'Auto-routes with code-optimized model selection' },
            { id: 'pharos-math', displayName: 'Pharos Math Router', description: 'Auto-routes with math-optimized model selection' },
            { id: 'pharos-reasoning', displayName: 'Pharos Reasoning Router', description: 'Auto-routes with reasoning-optimized model selection' },
            { id: 'pharos-creative', displayName: 'Pharos Creative Router', description: 'Auto-routes with creative-optimized model selection' },
            { id: 'pharos-analysis', displayName: 'Pharos Analysis Router', description: 'Auto-routes with analysis-optimized model selection' },
            { id: 'pharos-conversation', displayName: 'Pharos Conversation Router', description: 'Auto-routes with conversation-optimized model selection' },
        ];
        for (const vm of virtualModels) {
            models.push({
                id: vm.id,
                object: 'model',
                created,
                owned_by: 'pharos',
                pharos: {
                    provider: 'pharos',
                    displayName: vm.displayName,
                    tier: 'auto',
                    contextWindow: null,
                    capabilities: [vm.id.replace('pharos-', '')],
                    pricing: null,
                    speed: null,
                },
            });
        }

        // Add all configured models (deduplicated across tiers)
        for (const [tierName, tierConfig] of Object.entries(config.tiers)) {
            for (const modelEntry of tierConfig.models) {
                const key = `${modelEntry.provider}/${modelEntry.model}`;
                if (seen.has(key)) continue;
                seen.add(key);

                if (registry.isAvailable(modelEntry.provider)) {
                    const registryEntry = findModel(modelEntry.provider, modelEntry.model);
                    models.push({
                        id: modelEntry.model,
                        object: 'model',
                        created,
                        owned_by: `pharos-${tierName}`,
                        pharos: registryEntry
                            ? {
                                provider: registryEntry.provider,
                                displayName: registryEntry.displayName,
                                tier: tierName,
                                contextWindow: registryEntry.contextWindow,
                                capabilities: registryEntry.capabilities,
                                pricing: registryEntry.pricing,
                                speed: registryEntry.speed,
                            }
                            : {
                                provider: modelEntry.provider,
                                displayName: modelEntry.model,
                                tier: tierName,
                                contextWindow: null,
                                capabilities: [],
                                pricing: null,
                                speed: null,
                            },
                    });
                }
            }
        }

        return { object: 'list', data: models };
    });

    // ─── Chat Completions — the main route ───
    app.post('/v1/chat/completions', { preHandler: authMiddleware }, async (request, reply) => {
        const requestStartTime = Date.now();
        // Use client-provided correlation ID if present, otherwise generate UUID v4
        const clientRequestId = request.headers['x-request-id'];
        const requestId = (typeof clientRequestId === 'string' && clientRequestId.trim())
            ? clientRequestId.trim()
            : generateRequestId();
        const completionId = generateCompletionId();

        // Extract conversation ID for tier floor tracking
        const conversationId = typeof request.headers['x-conversation-id'] === 'string'
            ? request.headers['x-conversation-id'].trim() || null
            : null;

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

        // ─── Per-agent rate limiting ───
        const agentId = agentRateLimiter.extractAgent(body.model ?? '');
        if (agentId) {
            const rateLimitResult = agentRateLimiter.check(agentId);
            if (!rateLimitResult.allowed) {
                reply.header('Retry-After', String(rateLimitResult.retryAfterSeconds));
                reply.status(429).send(buildErrorResponse(
                    `Agent "${agentId}" rate limited. Retry after ${rateLimitResult.retryAfterSeconds}s.`,
                    'rate_limit_error',
                ));
                return;
            }
        }

        // ─── Spending limits ───
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
                if (dailySpend >= dailyLimit * 0.8) {
                    sendAlert('Daily spending at 80%', `$${dailySpend.toFixed(4)} / $${dailyLimit.toFixed(2)} (${((dailySpend / dailyLimit) * 100).toFixed(1)}%)`, 'warning', 'spending-daily-80');
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
                if (monthlySpend >= monthlyLimit * 0.8) {
                    sendAlert('Monthly spending at 80%', `$${monthlySpend.toFixed(4)} / $${monthlyLimit.toFixed(2)} (${((monthlySpend / monthlyLimit) * 100).toFixed(1)}%)`, 'warning', 'spending-monthly-80');
                }
            }
        }

        // Extract truncated last user message for audit logging (used by both success and error paths)
        const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
        const msgPreview = lastUserMsg
            ? (typeof lastUserMsg.content === 'string'
                ? lastUserMsg.content
                : Array.isArray(lastUserMsg.content)
                    ? lastUserMsg.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join(' ')
                    : String(lastUserMsg.content ?? ''))
            : '';
        const userMessagePreview = msgPreview.slice(0, 80);

        // Debug logging — capture first 500 chars of input when enabled
        const debugInput = config.server.debugLogging ? msgPreview.slice(0, 500) : undefined;

        // Track classification + routing for error reporting (hoisted for catch block access)
        let classification: Awaited<ReturnType<typeof classifier.classify>> | undefined;
        let routing: RoutingDecision | undefined;
        let conversationTierFloor: string | undefined;

        try {
            // 2. Classify the query
            classification = await classifier.classify(messages);

            // 3. Determine routing
            const directModel = router.resolveDirectModel(body.model);
            const taskTypeOverride = router.resolveTaskTypeOverride(body.model ?? '');

            // Apply task-type override from virtual model names (e.g. pharos-code)
            if (taskTypeOverride) {
                classification = { ...classification, type: taskTypeOverride };
                logger.info(
                    { requestId, taskTypeOverride, score: classification.score },
                    'Task type overridden by virtual model name',
                );
            }

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
                // Normal routing via classifier (with affinity)
                routing = router.route(classification);

                // Apply conversation tier floor — prevent quality drops in multi-turn conversations
                if (conversationId && conversationTracker && config.conversation?.enabled) {
                    const floor = conversationTracker.getTierFloor(conversationId);
                    if (floor) {
                        const elevatedTier = applyTierFloor(routing.tier as TierName, floor);
                        if (elevatedTier !== routing.tier) {
                            // Re-route with elevated tier by using that tier's minimum score
                            const elevatedScore = config.tiers[elevatedTier].scoreRange[0];
                            const elevatedClassification = { ...classification, score: elevatedScore };
                            routing = router.route(elevatedClassification);
                            conversationTierFloor = floor;
                            logger.info(
                                {
                                    requestId,
                                    originalTier: routing.tier,
                                    elevatedTier,
                                    floor,
                                    originalScore: classification.score,
                                    elevatedScore,
                                },
                                'Conversation tier floor applied',
                            );
                        }
                    }
                }
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

            // 4. Build request template and candidate list for retry
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
                ...(body.thinking !== undefined && { thinking: body.thinking }),
            };

            // Build candidate list: direct routes get a single candidate, auto routes get full retry chain
            const candidates = directModel
                ? [{ provider: routing.provider, model: routing.model, tier: routing.tier }]
                : router.getCandidates(classification);

            if (candidates.length === 0) {
                throw new Error('No available providers found');
            }

            // Pre-flight: estimate token count and filter out providers with insufficient context windows
            const estimatedTokens = estimateTokens(messages);
            let filteredCandidates = candidates;

            if (estimatedTokens > config.router.oversizedThresholdTokens) {
                filteredCandidates = candidates.filter(c => getContextWindow(c.model) > estimatedTokens);
                const skipped = candidates.length - filteredCandidates.length;

                logger.warn(
                    {
                        requestId,
                        estimatedTokens,
                        totalCandidates: candidates.length,
                        eligibleCandidates: filteredCandidates.length,
                        skippedModels: candidates
                            .filter(c => getContextWindow(c.model) <= estimatedTokens)
                            .map(c => `${c.provider}/${c.model} (${Math.round(getContextWindow(c.model) / 1000)}K)`)
                            .join(', '),
                    },
                    `⚠ Oversized request (~${Math.round(estimatedTokens / 1000)}K tokens), skipped ${skipped} providers with insufficient context`,
                );

                // If no candidates can handle it, fall back to full list as a last resort
                if (filteredCandidates.length === 0) {
                    logger.warn({ requestId }, 'No providers with sufficient context window — trying all as fallback');
                    filteredCandidates = candidates;
                }
            }

            let retryCount = 0;

            // ─── Streaming response with retry ───
            if (body.stream) {
                let succeeded = false;

                // Listen for client disconnect so we can abort early
                let clientDisconnected = false;
                reply.raw.on('close', () => { clientDisconnected = true; });

                for (const candidate of filteredCandidates) {
                    const p = registry.get(candidate.provider);
                    if (!p) continue;

                    // If client already gone, no point trying more providers
                    if (clientDisconnected) {
                        logger.info({ requestId }, 'Client disconnected before stream started, aborting');
                        return;
                    }

                    // Inner retry loop: attempt 0 = first try, attempt 1 = retry (transient only)
                    for (let attempt = 0; attempt < 2; attempt++) {
                        try {
                            const streamReq = { ...chatRequest, model: candidate.model };
                            let headersSent = false;
                            let finalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

                            for await (const chunk of p.chatStream(streamReq)) {
                                // Client disconnected mid-stream — stop reading from provider
                                if (clientDisconnected || !isClientConnected(reply)) {
                                    logger.info({ requestId, provider: candidate.provider, model: candidate.model }, 'Client disconnected mid-stream, aborting');
                                    const finalRouting = { ...routing, provider: candidate.provider, model: candidate.model, tier: candidate.tier };
                                    trackRequest(
                                        tracker, config, requestId, finalRouting, classification, finalUsage,
                                        Date.now() - requestStartTime, true, userMessagePreview,
                                        undefined, { debugInput },
                                    );
                                    return;
                                }

                                // Commit on first successful data — send SSE headers
                                if (!headersSent) {
                                    reply.raw.setHeader('X-Pharos-Tier', candidate.tier);
                                    reply.raw.setHeader('X-Pharos-Model', candidate.model);
                                    reply.raw.setHeader('X-Pharos-Provider', candidate.provider);
                                    reply.raw.setHeader('X-Pharos-Score', String(classification.score));
                                    reply.raw.setHeader('X-Pharos-Request-Id', requestId);
                                    if (retryCount > 0) {
                                        reply.raw.setHeader('X-Pharos-Retries', String(retryCount));
                                    }
                                    if (conversationTierFloor) {
                                        reply.raw.setHeader('X-Pharos-Conversation-Tier', conversationTierFloor);
                                    }
                                    initSSEHeaders(reply);
                                    headersSent = true;
                                }

                                if (chunk.content) {
                                    if (!sendSSEChunk(reply, buildStreamChunk({
                                        id: completionId,
                                        model: candidate.model,
                                        content: chunk.content,
                                    }))) {
                                        logger.info({ requestId }, 'Client disconnected (write failed), aborting stream');
                                        return;
                                    }
                                }

                                if (chunk.finishReason) {
                                    if (chunk.usage) finalUsage = chunk.usage;
                                    sendSSEChunk(reply, buildStreamChunk({
                                        id: completionId,
                                        model: candidate.model,
                                        content: '',
                                        finishReason: chunk.finishReason,
                                    }));
                                }
                            }

                            if (!sendSSEDone(reply)) {
                                logger.debug({ requestId }, 'sendSSEDone failed (client likely disconnected)');
                            }

                            // Record per-provider latency
                            const providerLatency = Date.now() - requestStartTime - (classification.latencyMs ?? 0);
                            p.recordLatency(Math.max(0, providerLatency));

                            // Track with the actual model that succeeded
                            const finalRouting = { ...routing, provider: candidate.provider, model: candidate.model, tier: candidate.tier };
                            trackRequest(
                                tracker, config, requestId, finalRouting, classification, finalUsage,
                                Date.now() - requestStartTime, true, userMessagePreview,
                                undefined, { debugInput },
                            );

                            // Record conversation tier for future tier floor calculations
                            if (conversationId && conversationTracker && config.conversation?.enabled) {
                                conversationTracker.recordTier(conversationId, candidate.tier as TierName);
                            }

                            const cost = calculateCost(candidate.provider, candidate.model, finalUsage.promptTokens, finalUsage.completionTokens);
                            logger.info(
                                {
                                    requestId,
                                    tier: candidate.tier,
                                    model: candidate.model,
                                    tokens: finalUsage.totalTokens,
                                    cost: `$${cost.toFixed(6)}`,
                                    latencyMs: Date.now() - requestStartTime,
                                    preview: userMessagePreview,
                                    retries: retryCount,
                                },
                                '✓ Completed (stream)',
                            );

                            succeeded = true;
                            break; // break inner retry loop
                        } catch (streamError) {
                            // If headers already sent, we can't retry — fail gracefully
                            if (reply.raw.headersSent) {
                                const errMsg = streamError instanceof Error ? streamError.message : 'Unknown stream error';

                                // If client already gone, just log and bail
                                if (clientDisconnected || !isClientConnected(reply)) {
                                    logger.warn({ requestId, error: errMsg }, 'Stream error after client disconnect, dropping');
                                    return;
                                }

                                logger.error({ requestId, error: errMsg }, 'Stream error mid-response (cannot retry)');
                                sendSSEChunk(reply, {
                                    error: {
                                        message: `Stream interrupted: ${errMsg}`,
                                        type: 'server_error',
                                        code: 'stream_error',
                                    },
                                });
                                if (!sendSSEDone(reply)) {
                                    logger.debug({ requestId }, 'sendSSEDone failed after stream error (client likely disconnected)');
                                }
                                return;
                            }

                            const errMsg = streamError instanceof Error ? streamError.message : 'unknown';

                            // Don't damage provider health for context-size errors
                            if (isContextSizeError(errMsg)) {
                                p.undoLastError();
                            }

                            // On first attempt, retry with backoff if transient
                            if (attempt === 0 && isTransientError(streamError)) {
                                const backoffMs = calculateBackoffMs(0);
                                logger.info(
                                    { requestId, provider: candidate.provider, model: candidate.model, backoffMs: Math.round(backoffMs) },
                                    '⟳ Transient stream error, retrying same provider with backoff',
                                );
                                await sleep(backoffMs);
                                continue; // retry same candidate
                            }

                            // Non-transient or retry also failed — failover to next candidate
                            retryCount++;
                            if (isContextSizeError(errMsg)) {
                                logger.warn(
                                    { requestId, provider: candidate.provider, model: candidate.model, attempt: retryCount },
                                    '⟳ Context too large for model, trying next (health preserved)',
                                );
                            } else {
                                logger.warn(
                                    { requestId, provider: candidate.provider, model: candidate.model, attempt: retryCount, error: errMsg },
                                    '⟳ Stream failed before data, trying next model',
                                );
                            }
                            break; // break inner retry loop, continue to next candidate
                        }
                    } // end inner retry loop

                    if (succeeded) break; // break outer candidate loop
                }

                if (!succeeded) {
                    throw new Error(`All providers failed after ${retryCount} retry attempts`);
                }
                return;
            }

            // ─── Non-streaming response with retry ───
            let response: ChatResponse | null = null;
            let usedProvider = routing.provider;
            let usedModel = routing.model;
            let usedTier = routing.tier;

            for (const candidate of filteredCandidates) {
                const p = registry.get(candidate.provider);
                if (!p) continue;

                let candidateSucceeded = false;

                // Inner retry loop: attempt 0 = first try, attempt 1 = retry (transient only)
                for (let attempt = 0; attempt < 2; attempt++) {
                    try {
                        const callStart = Date.now();
                        response = await p.chat({ ...chatRequest, model: candidate.model });
                        p.recordLatency(Date.now() - callStart);
                        usedProvider = candidate.provider;
                        usedModel = candidate.model;
                        usedTier = candidate.tier;
                        candidateSucceeded = true;
                        break; // break inner retry loop
                    } catch (err) {
                        const errMsg = err instanceof Error ? err.message : 'unknown';

                        // Don't damage provider health for context-size errors
                        if (isContextSizeError(errMsg)) {
                            p.undoLastError();
                        }

                        // On first attempt, retry with backoff if transient
                        if (attempt === 0 && isTransientError(err)) {
                            const backoffMs = calculateBackoffMs(0);
                            logger.info(
                                { requestId, provider: candidate.provider, model: candidate.model, backoffMs: Math.round(backoffMs) },
                                '⟳ Transient error, retrying same provider with backoff',
                            );
                            await sleep(backoffMs);
                            continue; // retry same candidate
                        }

                        // Non-transient or retry also failed — failover to next candidate
                        retryCount++;
                        if (isContextSizeError(errMsg)) {
                            logger.warn(
                                { requestId, provider: candidate.provider, model: candidate.model, attempt: retryCount },
                                '⟳ Context too large for model, trying next (health preserved)',
                            );
                        } else {
                            logger.warn(
                                { requestId, provider: candidate.provider, model: candidate.model, attempt: retryCount, error: errMsg },
                                '⟳ Provider error, trying next model',
                            );
                        }
                        break; // break inner retry loop, continue to next candidate
                    }
                } // end inner retry loop

                if (candidateSucceeded) break; // break outer candidate loop
            }

            if (!response) {
                throw new Error(`All providers failed after ${retryCount} retry attempts`);
            }

            const cost = calculateCost(usedProvider, usedModel, response.usage.promptTokens, response.usage.completionTokens);

            // Debug logging — capture first 500 chars of output when enabled
            const debugOutput = config.server.debugLogging ? response.content.slice(0, 500) : undefined;

            // Track with the actual model that succeeded
            const finalRouting = { ...routing, provider: usedProvider, model: usedModel, tier: usedTier };
            trackRequest(
                tracker, config, requestId, finalRouting, classification, response.usage,
                Date.now() - requestStartTime, false, userMessagePreview,
                undefined, { debugInput, debugOutput },
            );

            // Record conversation tier for future tier floor calculations
            if (conversationId && conversationTracker && config.conversation?.enabled) {
                conversationTracker.recordTier(conversationId, usedTier as TierName);
            }

            logger.info(
                {
                    requestId,
                    tier: usedTier,
                    model: usedModel,
                    tokens: response.usage.totalTokens,
                    cost: `$${cost.toFixed(6)}`,
                    latencyMs: Date.now() - requestStartTime,
                    preview: userMessagePreview,
                    retries: retryCount,
                },
                '✓ Completed',
            );

            // Set Pharos metadata headers
            reply.header('X-Pharos-Tier', usedTier);
            reply.header('X-Pharos-Model', usedModel);
            reply.header('X-Pharos-Provider', usedProvider);
            reply.header('X-Pharos-Score', String(classification.score));
            reply.header('X-Pharos-Cost', cost.toFixed(6));
            reply.header('X-Pharos-Request-Id', requestId);
            if (retryCount > 0) {
                reply.header('X-Pharos-Retries', String(retryCount));
            }
            if (conversationTierFloor) {
                reply.header('X-Pharos-Conversation-Tier', conversationTierFloor);
            }

            return buildChatCompletionResponse({
                id: completionId,
                model: usedModel,
                content: response.content,
                finishReason: response.finishReason,
                usage: response.usage,
            });
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : 'Unknown error';
            logger.error({ requestId, error: errMsg }, '✗ Request failed');

            // Track the failed request if we have enough context
            if (classification && routing) {
                trackRequest(
                    tracker, config, requestId, routing, classification,
                    { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                    Date.now() - requestStartTime, body.stream ?? false, userMessagePreview,
                    { status: 'error', errorMessage: errMsg },
                    { debugInput },
                );
            }

            // If reply was already hijacked (streaming started), write error to raw stream
            if (reply.raw.headersSent) {
                // Only attempt to write if client is still connected
                if (isClientConnected(reply)) {
                    sendSSEChunk(reply, {
                        error: {
                            message: `Routing failed: ${errMsg}`,
                            type: 'server_error',
                            code: 'provider_error',
                        },
                    });
                    sendSSEDone(reply);
                }
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
        const summary = tracker.getSummary();
        summary.classifier = classifier.getMetrics();
        return summary;
    });

    // ─── Recent Requests endpoint ───
    app.get('/v1/stats/recent', { preHandler: authMiddleware }, async () => {
        if (!tracker) {
            return { error: 'Tracking is disabled' };
        }
        return { requests: tracker.getRecent(25) };
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
    userMessagePreview: string,
    errorInfo?: { status: 'error'; errorMessage: string },
    debugInfo?: { debugInput?: string; debugOutput?: string },
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
        ...(debugInfo && { debugInput: debugInfo.debugInput, debugOutput: debugInfo.debugOutput }),
    });
}
