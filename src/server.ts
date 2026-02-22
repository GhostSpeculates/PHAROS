import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import type { PharosConfig } from './config/schema.js';
import { QueryClassifier } from './classifier/index.js';
import { ModelRouter } from './router/index.js';
import { ProviderRegistry } from './providers/index.js';
import { TrackingStore } from './tracking/store.js';
import { registerRoutes } from './gateway/router.js';
import { createErrorHandler } from './gateway/middleware/error-handler.js';
import { createLogger, type Logger } from './utils/logger.js';

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

    // ─── Initialize Providers ───
    const registry = new ProviderRegistry(config, logger);
    const availableProviders = registry.listAvailable();
    logger.info(`Providers ready: ${availableProviders.length > 0 ? availableProviders.join(', ') : 'none (check API keys)'}`);

    // ─── Initialize Classifier ───
    const classifier = new QueryClassifier(config, logger);

    // ─── Initialize Router ───
    const router = new ModelRouter(config, registry, logger);

    // ─── Initialize Tracking ───
    let tracker: TrackingStore | null = null;
    if (config.tracking.enabled) {
        tracker = new TrackingStore(config.tracking.dbPath, logger);
        logger.info(`Cost tracking: enabled (${config.tracking.dbPath})`);
    }

    // ─── Create Fastify Server ───
    const app = Fastify({
        logger: false, // We use our own pino logger
        bodyLimit: 10 * 1024 * 1024, // 10MB max request body
    });

    // Register CORS — configurable via PHAROS_CORS_ORIGINS env var (comma-separated)
    const corsOrigins = process.env.PHAROS_CORS_ORIGINS?.split(',') || true;
    await app.register(cors, {
        origin: corsOrigins,
        methods: ['GET', 'POST', 'OPTIONS'],
    });

    // Register rate limiting — 100 requests per minute per IP
    await app.register(rateLimit, {
        max: 100,
        timeWindow: '1 minute',
    });

    // Register error handler
    app.setErrorHandler(createErrorHandler(logger));

    // Register routes
    registerRoutes(app, config, classifier, router, registry, tracker, logger);

    // ─── Server lifecycle ───
    return {
        start: async () => {
            await app.listen({ port: config.server.port, host: config.server.host });
            logger.info('────────────────────────────────────────────');
            logger.info(`🚀 Pharos is live on http://localhost:${config.server.port}`);
            logger.info(`   POST /v1/chat/completions  →  Routing endpoint`);
            logger.info(`   GET  /v1/models             →  List models`);
            logger.info(`   GET  /v1/stats              →  Cost & savings`);
            logger.info(`   GET  /health                →  Health check`);
            logger.info('────────────────────────────────────────────');
        },
        stop: async () => {
            logger.info('Shutting down Pharos...');
            tracker?.close();
            await app.close();
            logger.info('Pharos stopped.');
        },
        logger,
    };
}
