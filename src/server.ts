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
import { initPricing } from './tracking/cost-calculator.js';
import { initAlerts, sendAlert } from './utils/alerts.js';
import { providerSelfTest } from './utils/self-test.js';

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
    initAlerts(config.alerts?.discordWebhookUrl, logger);

    // ─── Initialize Pricing ───
    initPricing(config.pricing, logger);

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
        tracker = new TrackingStore(config.tracking.dbPath, logger, config.tracking.retentionDays);
        logger.info(`Cost tracking: enabled (${config.tracking.dbPath})`);
    }

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

    // Register error handler
    app.setErrorHandler(createErrorHandler(logger));

    // Register routes
    registerRoutes(app, config, classifier, router, registry, tracker, logger);

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
            logger.info(`   POST /v1/chat/completions  →  Routing endpoint`);
            logger.info(`   GET  /v1/models             →  List models`);
            logger.info(`   GET  /v1/stats              →  Cost & savings`);
            logger.info(`   GET  /health                →  Health check`);
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

            // Now safe to close the tracking DB — no more requests in flight
            tracker?.close();

            // Send shutdown alert (best-effort, don't await long)
            await sendAlert('Pharos Stopped', 'Server shut down gracefully.', 'info');

            logger.info('Pharos stopped.');
        },
        logger,
    };
}
