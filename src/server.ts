import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import type { PharosConfig } from './config/schema.js';
import { QueryClassifier } from './classifier/index.js';
import { ModelRouter } from './router/index.js';
import { ProviderRegistry } from './providers/index.js';
import { TrackingStore } from './tracking/store.js';
import { WalletStore } from './tracking/wallet-store.js';
import { registerRoutes } from './gateway/router.js';
import { registerWalletRoutes } from './gateway/wallet-routes.js';
import { registerFilterRoutes } from './gateway/filter-routes.js';
import { registerEmbeddingsRoutes } from './gateway/embeddings-routes.js';
import { EmbeddingsRouter } from './providers/embeddings.js';
import { registerTTSRoutes } from './gateway/tts-routes.js';
import { TTSRouter } from './providers/tts.js';
import { registerSTTRoutes } from './gateway/stt-routes.js';
import { STTRouter } from './providers/stt.js';
import { registerImagesRoutes } from './gateway/images-routes.js';
import { ImagesRouter } from './providers/images.js';
import { registerVideosRoutes } from './gateway/videos-routes.js';
import { VideosRouter } from './providers/video.js';
import { VideoJobStore } from './jobs/video-poller.js';
import { createErrorHandler } from './gateway/middleware/error-handler.js';
import { registerWalletDebitHook } from './gateway/middleware/wallet-debit.js';
import { createLogger, type Logger } from './utils/logger.js';
import { initPricing } from './tracking/cost-calculator.js';
import { initAlerts, sendAlert } from './utils/alerts.js';
import { providerSelfTest } from './utils/self-test.js';
import { ConversationTracker } from './router/conversation-tracker.js';
import { PerformanceLearningStore } from './learning/index.js';
import { Phase2Metrics } from './tracking/phase2-metrics.js';

/**
 * Create and configure the Pharos server.
 *
 * This is the top-level assembly point that wires together all the pieces:
 * Config → Logger → Providers → Classifier → Router → Gateway → Server
 */
export async function createServer(config: PharosConfig): Promise<{
    start: () => Promise<void>;
    stop: () => Promise<void>;
    logger: Logger;
}> {
    // ─── Initialize Logger ───
    const logger = createLogger(config.logging.level, config.logging.pretty);

    logger.info('⚡ Pharos — Intelligent LLM Routing Gateway');
    logger.info('────────────────────────────────────────────');

    // ─── Initialize Alerts ───
    initAlerts(config.alerts?.discordWebhookUrl, logger, config.alerts?.ntfyTopic);

    // ─── Initialize Pricing ───
    initPricing(config.pricing, logger);

    // ─── Initialize Providers ───
    const registry = new ProviderRegistry(config, logger);
    const availableProviders = registry.listAvailable();
    logger.info(`Providers ready: ${availableProviders.length > 0 ? availableProviders.join(', ') : 'none (check API keys)'}`);

    // ─── Initialize Classifier ───
    const classifier = new QueryClassifier(config, logger);

    // ─── Initialize Conversation Tracker ───
    const conversationTracker = config.conversation?.enabled
        ? new ConversationTracker({
            maxSize: config.conversation.maxConversations,
            ttlMs: config.conversation.conversationTtlMs,
        })
        : undefined;
    if (conversationTracker) {
        logger.info('Conversation tracking: enabled');
    }

    // ─── Initialize Tracking ───
    let tracker: TrackingStore | null = null;
    if (config.tracking.enabled) {
        tracker = new TrackingStore(config.tracking.dbPath, logger, config.tracking.retentionDays);
        logger.info(`Cost tracking: enabled (${config.tracking.dbPath})`);
    }

    // ─── Initialize Wallet (Wave 5 / Phase 8.2) ───
    // Reuses the same DB file as tracking — `users` + `wallet_ledger` tables
    // coexist with `requests` table. Additive; existing schema untouched.
    // R1-refined schema (INTEGER cents, idempotent stripe events, multi-tenant placeholders).
    let wallet: WalletStore | null = null;
    if (config.tracking.enabled) {
        wallet = new WalletStore(config.tracking.dbPath, logger);
        logger.info(`Wallet: enabled (Phase 8.2 — schema initialized at ${config.tracking.dbPath})`);
    }

    // ─── Initialize Performance Learning ───
    let learningStore: PerformanceLearningStore | null = null;
    if (config.performanceLearning?.enabled && tracker) {
        const Database = (await import('better-sqlite3')).default;
        const learningDb = new Database(config.tracking.dbPath);
        learningDb.pragma('journal_mode = WAL');
        learningStore = new PerformanceLearningStore(learningDb, logger, config.performanceLearning);
        learningStore.applyDecay();
        logger.info(`Performance learning: enabled (${learningStore.getTrackedCount()} models tracked)`);
    }

    // ─── Initialize Phase 2 Metrics ───
    const phase2Metrics = new Phase2Metrics();

    // ─── Initialize Router ───
    const router = new ModelRouter(config, registry, logger, learningStore);

    // ─── Create Fastify Server ───
    const app = Fastify({
        logger: false, // We use our own pino logger
        bodyLimit: config.server.bodyLimitMb * 1024 * 1024,
    });

    // Register CORS — configurable via PHAROS_CORS_ORIGINS env var (comma-separated)
    // Defaults to common dev ports when not set (secure by default)
    const corsOrigins = process.env.PHAROS_CORS_ORIGINS
        ? process.env.PHAROS_CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
        : ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000'];
    await app.register(cors, {
        origin: corsOrigins,
        methods: ['GET', 'POST', 'OPTIONS'],
    });

    // Register rate limiting — configurable requests per minute per IP
    await app.register(rateLimit, {
        max: config.server.rateLimitPerMinute,
        timeWindow: '1 minute',
    });

    // Multipart — required for STT file uploads (Phase 2)
    await app.register(multipart, {
        limits: {
            fileSize: config.server.bodyLimitMb * 1024 * 1024,
            files: 1,
            fields: 10,
        },
    });

    // Register error handler
    app.setErrorHandler(createErrorHandler(logger));

    // ─── Wave 5 Wallet — global onResponse debit hook ───
    // Must register BEFORE routes so it fires for every billed endpoint.
    // No-ops for operator requests (config.auth.apiKey holders) and unstamped ones.
    if (wallet) {
        registerWalletDebitHook(app, wallet, logger);
    }

    // Register routes
    registerRoutes(app, config, classifier, router, registry, tracker, logger, conversationTracker, learningStore, phase2Metrics, wallet);

    // ─── Embeddings (Phase 1 multi-modal) ───
    if (config.embeddings?.enabled !== false) {
        const embeddingsRouter = new EmbeddingsRouter(config, logger);
        registerEmbeddingsRoutes(app, config, embeddingsRouter, tracker, logger, wallet);
    }

    // ─── TTS (Phase 2 multi-modal) ───
    if (config.tts?.enabled !== false) {
        const ttsRouter = new TTSRouter(config, logger);
        registerTTSRoutes(app, config, ttsRouter, tracker, logger, wallet);
    }

    // ─── STT (Phase 2 multi-modal) ───
    if (config.stt?.enabled !== false) {
        const sttRouter = new STTRouter(config, logger);
        registerSTTRoutes(app, config, sttRouter, tracker, logger, wallet);
    }

    // ─── Images (Phase 3 multi-modal) ───
    if (config.images?.enabled !== false) {
        const imagesRouter = new ImagesRouter(config, logger);
        registerImagesRoutes(app, config, imagesRouter, tracker, logger, wallet);
    }

    // ─── Videos (Phase 4 multi-modal — async with background poller) ───
    let videoJobStore: VideoJobStore | null = null;
    if (config.videos?.enabled !== false) {
        const videosRouter = new VideosRouter(config, logger);
        videoJobStore = new VideoJobStore(videosRouter, tracker, logger);
        videoJobStore.start();
        registerVideosRoutes(app, config, videosRouter, videoJobStore, tracker, logger, wallet);
    }

    // Wave 5 — wallet routes (only if wallet store initialized)
    if (wallet) {
        registerWalletRoutes({ fastify: app, wallet, logger });
    }

    // Wave 4 — filter advisor routes (uses existing classifier; safe even if classifier is null)
    registerFilterRoutes({
        fastify: app,
        classifier: classifier
            ? { classify: async (messages) => classifier.classify(messages) }
            : undefined,
        logger,
    });

    // ─── Server lifecycle ───
    return {
        start: async () => {
            // Run provider self-test before listening (skip in test environment)
            let selfTestResults: { passed: string[]; failed: string[] } | undefined;
            if (config.server.selfTest && !process.env.VITEST) {
                selfTestResults = await providerSelfTest(config, registry, logger);
            }

            await app.listen({ port: config.server.port, host: config.server.host });
            logger.info('────────────────────────────────────────────');
            logger.info(`🚀 Pharos is live on http://localhost:${config.server.port}`);
            logger.info(`   POST /v1/chat/completions      →  Chat routing endpoint`);
            logger.info(`   POST /v1/embeddings            →  Embeddings routing endpoint`);
            logger.info(`   POST /v1/audio/speech          →  TTS routing endpoint`);
            logger.info(`   POST /v1/audio/transcriptions  →  STT transcription endpoint`);
            logger.info(`   POST /v1/images/generations    →  Image generation endpoint (quality-tier)`);
            logger.info(`   POST /v1/videos/generations    →  Video gen submit (async, returns job ID)`);
            logger.info(`   GET  /v1/videos/generations/:id → Video gen poll endpoint`);
            logger.info(`   GET  /v1/models                →  List models`);
            logger.info(`   GET  /v1/stats                 →  Cost & savings`);
            logger.info(`   GET  /health                   →  Health check`);
            logger.info('────────────────────────────────────────────');

            // Startup alert — include self-test results if available
            if (selfTestResults && selfTestResults.failed.length > 0) {
                sendAlert(
                    'Startup Self-Test Warning',
                    `**${selfTestResults.passed.length}/${selfTestResults.passed.length + selfTestResults.failed.length} providers passed**\n\n` +
                    (selfTestResults.passed.length > 0 ? `✓ ${selfTestResults.passed.join(', ')}\n` : '') +
                    `✗ ${selfTestResults.failed.join('\n✗ ')}`,
                    'warning',
                );
            } else if (selfTestResults && selfTestResults.passed.length > 0) {
                sendAlert(
                    'Pharos Started',
                    `Server is live on port ${config.server.port}\nAll ${selfTestResults.passed.length} providers verified: ${selfTestResults.passed.join(', ')}`,
                    'info',
                );
            } else {
                sendAlert(
                    'Pharos Started',
                    `Server is live on port ${config.server.port}\nProviders: ${availableProviders.join(', ') || 'none'}`,
                    'info',
                );
            }
        },
        stop: async () => {
            logger.info('Shutting down Pharos...');

            // Close Fastify first — this drains in-flight requests
            // (Fastify's close() stops accepting new connections and waits
            //  for existing ones to finish before resolving.)
            const SHUTDOWN_TIMEOUT_MS = 15_000;
            try {
                await Promise.race([
                    app.close(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Shutdown timeout')), SHUTDOWN_TIMEOUT_MS),
                    ),
                ]);
            } catch (err) {
                logger.warn(
                    { error: err instanceof Error ? err.message : String(err) },
                    'Forceful shutdown after timeout',
                );
            }

            // Stop video poller before closing tracking DB (poller writes records on completion)
            videoJobStore?.stop();

            // Now safe to close the tracking DB — no more requests in flight
            tracker?.close();

            // Send shutdown alert (best-effort, don't await long)
            await sendAlert('Pharos Stopped', 'Server shut down gracefully.', 'info');

            logger.info('Pharos stopped.');
        },
        logger,
    };
}
