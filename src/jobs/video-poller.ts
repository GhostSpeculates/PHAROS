import type { Logger } from '../utils/logger.js';
import type { TrackingStore } from '../tracking/store.js';
import type { VideosRouter, VideoCandidate } from '../providers/video.js';
import { calculateCost } from '../tracking/cost-calculator.js';

/**
 * Video job lifecycle manager.
 *
 * In-memory map of pharosJobId -> VideoJob. Background interval (5s) walks
 * all `processing` jobs, asks the upstream provider for status, and on
 * completion fires the SQLite tracking call.
 *
 * Restart-safety: jobs are NOT persisted. A Pharos restart loses in-flight
 * job state — caller must re-submit. Acceptable Phase 4 cost; SQLite
 * persistence is a Phase 4.5 enhancement if it bites.
 *
 * Cleanup: completed/failed jobs older than COMPLETED_TTL_MS get pruned.
 * Stale processing jobs (> POLL_TIMEOUT_MS) get force-failed and pruned.
 */

export type VideoJobStatus = 'processing' | 'completed' | 'failed';

export interface VideoJob {
    /** Pharos-internal job ID exposed to the caller (e.g. "vid_<uuid>"). */
    id: string;
    /** Original request UUID (used as the SQLite row id when the job completes). */
    requestId: string;
    upstreamId: string;
    statusUrl: string;
    responseUrl?: string;
    candidate: VideoCandidate;
    /** Caller-provided fields, captured for tracking + the GET response payload. */
    prompt: string;
    durationSeconds: number;
    resolution: string;
    agentId?: string;
    promptPreview: string;
    /** ms timestamps */
    submittedAt: number;
    estimatedCompletionAt: number;
    completedAt?: number;

    status: VideoJobStatus;
    videoUrl?: string;
    thumbnailUrl?: string;
    error?: string;
    failoverAttempts: number;
    /** Whether the SQLite row has been written. Prevents double-tracking. */
    tracked: boolean;
}

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;     // 10 minutes — anything longer is a stuck job
const COMPLETED_TTL_MS = 60 * 60 * 1000;    // keep completed/failed jobs for 1 hour for caller polling

export class VideoJobStore {
    private jobs = new Map<string, VideoJob>();
    private interval: NodeJS.Timeout | null = null;
    private router: VideosRouter;
    private tracker: TrackingStore | null;
    private logger: Logger;

    constructor(router: VideosRouter, tracker: TrackingStore | null, logger: Logger) {
        this.router = router;
        this.tracker = tracker;
        this.logger = logger;
    }

    start(): void {
        if (this.interval) return;
        this.interval = setInterval(() => {
            void this.tick().catch((err) => {
                this.logger.error({ error: err instanceof Error ? err.message : 'unknown' }, 'Video poller tick failed');
            });
        }, POLL_INTERVAL_MS);
        this.interval.unref();
        this.logger.info('Video poller: started (5s interval)');
    }

    stop(): void {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }

    create(job: VideoJob): void {
        this.jobs.set(job.id, job);
    }

    get(id: string): VideoJob | undefined {
        return this.jobs.get(id);
    }

    /**
     * One pass over all jobs:
     *   - completed/failed older than TTL -> drop from memory
     *   - processing older than POLL_TIMEOUT -> force-fail and track
     *   - processing in-budget -> ask upstream
     */
    private async tick(): Promise<void> {
        const now = Date.now();

        for (const job of this.jobs.values()) {
            if (job.status !== 'processing') {
                if (job.completedAt && now - job.completedAt > COMPLETED_TTL_MS) {
                    this.jobs.delete(job.id);
                }
                continue;
            }

            // Force-fail stuck processing jobs
            if (now - job.submittedAt > POLL_TIMEOUT_MS) {
                job.status = 'failed';
                job.error = `poll timeout after ${Math.round((now - job.submittedAt) / 1000)}s`;
                job.completedAt = now;
                this.recordOnce(job);
                this.logger.warn({ jobId: job.id, requestId: job.requestId }, '✗ Video job force-failed (poll timeout)');
                continue;
            }

            const provider = this.router.getProvider(job.candidate.provider);
            if (!provider) {
                job.status = 'failed';
                job.error = `provider ${job.candidate.provider} no longer registered`;
                job.completedAt = now;
                this.recordOnce(job);
                continue;
            }

            try {
                const result = await provider.poll(job.statusUrl, job.responseUrl);
                if (result.state === 'completed' && result.videoUrl) {
                    job.status = 'completed';
                    job.videoUrl = result.videoUrl;
                    job.thumbnailUrl = result.thumbnailUrl;
                    job.completedAt = now;
                    this.recordOnce(job);
                    this.logger.info(
                        {
                            jobId: job.id,
                            requestId: job.requestId,
                            provider: job.candidate.provider,
                            model: job.candidate.model,
                            durationSeconds: job.durationSeconds,
                            elapsedSeconds: Math.round((now - job.submittedAt) / 1000),
                        },
                        '✓ Video job completed',
                    );
                } else if (result.state === 'failed') {
                    job.status = 'failed';
                    job.error = result.error ?? 'unknown';
                    job.completedAt = now;
                    this.recordOnce(job);
                    this.logger.warn(
                        { jobId: job.id, requestId: job.requestId, error: job.error },
                        '✗ Video job failed',
                    );
                }
                // 'processing' — no state change, keep polling
            } catch (err) {
                // Polling network error is transient; don't fail the job, just log.
                this.logger.debug(
                    { jobId: job.id, error: err instanceof Error ? err.message : 'unknown' },
                    'Video poll transient error, will retry',
                );
            }
        }
    }

    private recordOnce(job: VideoJob): void {
        if (job.tracked) return;
        job.tracked = true;

        if (!this.tracker) return;

        // Cost basis: pricePerSecond × durationSeconds. We encode pricePerSecond × 1e6
        // as inputCostPerMillion in pharos.yaml so calculateCost(provider, model, n_seconds, 0)
        // collapses to durationSeconds × pricePerSecond.
        const cost = job.status === 'completed'
            ? calculateCost(job.candidate.provider, job.candidate.model, job.durationSeconds, 0)
            : 0;
        const totalLatencyMs = job.completedAt ? job.completedAt - job.submittedAt : 0;
        const providerLatencyMs = totalLatencyMs;

        try {
            this.tracker.record({
                id: job.requestId,
                timestamp: new Date().toISOString(),
                tier: 'video',
                provider: job.candidate.provider,
                model: job.candidate.model,
                classificationScore: 0,
                classificationType: 'video',
                classificationLatencyMs: 0,
                classifierProvider: 'none',
                tokensIn: job.durationSeconds,
                tokensOut: 0,
                estimatedCost: cost,
                baselineCost: cost,
                savings: 0,
                totalLatencyMs,
                stream: false,
                isDirectRoute: false,
                userMessagePreview: job.promptPreview,
                status: job.status === 'completed' ? 'success' : 'error',
                errorMessage: job.error,
                agentId: job.agentId,
                retryCount: job.failoverAttempts,
                providerLatencyMs,
            });
        } catch (err) {
            this.logger.error(
                { jobId: job.id, requestId: job.requestId, error: err instanceof Error ? err.message : 'unknown' },
                'Failed to record video job in SQLite',
            );
        }
    }
}
