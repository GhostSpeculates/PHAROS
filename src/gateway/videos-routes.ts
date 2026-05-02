import type { FastifyInstance } from 'fastify';
import type { PharosConfig } from '../config/schema.js';
import type { VideosRouter } from '../providers/video.js';
import type { TrackingStore } from '../tracking/store.js';
import type { Logger } from '../utils/logger.js';
import type { VideoJobStore } from '../jobs/video-poller.js';
import { VideosRequestSchema } from './schemas/videos-request.js';
import { buildErrorResponse } from './schemas/response.js';
import { generateRequestId } from '../utils/id.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createAgentRateLimiter } from './middleware/agent-rate-limit.js';
import { sendAlert } from '../utils/alerts.js';
import { resolveVideoCandidates } from '../providers/video.js';

/**
 * Register POST /v1/videos/generations + GET /v1/videos/generations/:id.
 *
 * Asymmetric design: POST returns 202 immediately with a poll URL. GET
 * returns the current state. The actual upstream polling happens in
 * VideoJobStore's background loop, NOT in the GET handler — GET is just
 * a snapshot read of the in-memory job map.
 */
export function registerVideosRoutes(
    app: FastifyInstance,
    config: PharosConfig,
    videosRouter: VideosRouter,
    jobStore: VideoJobStore,
    tracker: TrackingStore | null,
    logger: Logger,
): void {
    const authMiddleware = createAuthMiddleware(config);
    const agentRateLimiter = createAgentRateLimiter(config.server.agentRateLimitPerMinute, logger);

    // ─── POST /v1/videos/generations — submit a job ───────────────────────
    app.post('/v1/videos/generations', { preHandler: authMiddleware }, async (request, reply) => {
        const submittedAt = Date.now();
        const clientRequestId = request.headers['x-request-id'];
        const requestId = (typeof clientRequestId === 'string' && clientRequestId.trim())
            ? clientRequestId.trim()
            : generateRequestId();

        // 1. Validate
        const parseResult = VideosRequestSchema.safeParse(request.body);
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

        // 3. Spending limit guard (pooled with all other modalities)
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

        const quality = body.quality ?? 'balanced';
        const promptPreview = body.prompt.slice(0, 80);

        logger.info(
            {
                requestId,
                model: body.model,
                agentId,
                quality,
                durationSeconds: body.duration_seconds,
                resolution: body.resolution,
                hasImage: !!body.image_url,
                promptPreview,
            },
            'Video request received',
        );

        try {
            const candidates = resolveVideoCandidates(quality, config);
            const { candidate, upstream, failoverAttempts } = await videosRouter.submit(candidates, {
                prompt: body.prompt,
                durationSeconds: body.duration_seconds,
                resolution: body.resolution,
                imageUrl: body.image_url,
                seed: body.seed,
            });

            // Allocate the public job ID and seed the in-memory job map.
            const jobId = `vid_${requestId}`;
            // Most providers complete in 60-180s; estimate 120s as a midpoint.
            const estimatedCompletionSeconds = 120;

            jobStore.create({
                id: jobId,
                requestId,
                upstreamId: upstream.upstreamId,
                statusUrl: upstream.statusUrl,
                responseUrl: upstream.responseUrl,
                candidate,
                prompt: body.prompt,
                durationSeconds: body.duration_seconds,
                resolution: body.resolution,
                agentId: agentId ?? undefined,
                promptPreview,
                submittedAt,
                estimatedCompletionAt: submittedAt + estimatedCompletionSeconds * 1000,
                status: 'processing',
                failoverAttempts,
                tracked: false,
            });

            reply.header('X-Pharos-Provider', candidate.provider);
            reply.header('X-Pharos-Model', candidate.model);
            reply.header('X-Pharos-Quality', quality);
            reply.header('X-Pharos-Request-Id', requestId);
            if (failoverAttempts > 0) {
                reply.header('X-Pharos-Retries', String(failoverAttempts));
            }

            reply.status(202).send({
                id: jobId,
                status: 'processing',
                poll_url: `/v1/videos/generations/${jobId}`,
                estimated_completion_seconds: estimatedCompletionSeconds,
                model: candidate.model,
                provider: candidate.provider,
                duration_seconds: body.duration_seconds,
                quality,
            });
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : 'Unknown error';
            logger.error({ requestId, error: errMsg }, '✗ Video submit failed');

            // Submit failures track immediately (no job exists to poll).
            if (tracker) {
                tracker.record({
                    id: requestId,
                    timestamp: new Date().toISOString(),
                    tier: 'video',
                    provider: 'none',
                    model: body.model,
                    classificationScore: 0,
                    classificationType: 'video',
                    classificationLatencyMs: 0,
                    classifierProvider: 'none',
                    tokensIn: 0,
                    tokensOut: 0,
                    estimatedCost: 0,
                    baselineCost: 0,
                    savings: 0,
                    totalLatencyMs: Date.now() - submittedAt,
                    stream: false,
                    isDirectRoute: false,
                    userMessagePreview: promptPreview,
                    status: 'error',
                    errorMessage: errMsg,
                    agentId: agentId ?? undefined,
                });
            }

            reply.status(502).send(buildErrorResponse(
                `Video submit failed: ${errMsg}`,
                'server_error',
                'provider_error',
            ));
        }
    });

    // ─── GET /v1/videos/generations/:id — poll a job ──────────────────────
    app.get('/v1/videos/generations/:id', { preHandler: authMiddleware }, async (request, reply) => {
        const { id } = request.params as { id: string };
        const job = jobStore.get(id);

        if (!job) {
            reply.status(404).send(buildErrorResponse(
                `Job "${id}" not found. Jobs older than 1 hour are pruned; in-flight jobs are lost on Pharos restart.`,
                'not_found_error',
            ));
            return;
        }

        // Headers the caller may want regardless of state
        reply.header('X-Pharos-Provider', job.candidate.provider);
        reply.header('X-Pharos-Model', job.candidate.model);
        reply.header('X-Pharos-Request-Id', job.requestId);

        const elapsedSeconds = Math.round((Date.now() - job.submittedAt) / 1000);

        return {
            id: job.id,
            status: job.status,
            model: job.candidate.model,
            provider: job.candidate.provider,
            duration_seconds: job.durationSeconds,
            elapsed_seconds: elapsedSeconds,
            ...(job.status === 'completed' ? {
                video_url: job.videoUrl,
                ...(job.thumbnailUrl ? { thumbnail_url: job.thumbnailUrl } : {}),
            } : {}),
            ...(job.status === 'failed' ? { error: job.error } : {}),
            ...(job.status === 'processing' ? {
                poll_url: `/v1/videos/generations/${job.id}`,
                estimated_completion_seconds: Math.max(
                    0,
                    Math.round((job.estimatedCompletionAt - Date.now()) / 1000),
                ),
            } : {}),
        };
    });
}
