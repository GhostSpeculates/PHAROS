import { loadConfig } from './config/index.js';
import { createServer } from './server.js';

/**
 * Pharos — Intelligent LLM Routing Gateway
 *
 * Entry point. Loads config, creates server, handles graceful shutdown.
 */
async function main() {
    // Catch unhandled rejections / exceptions at the process level
    // so they never silently crash the gateway.
    process.on('unhandledRejection', (reason) => {
        console.error('Unhandled promise rejection:', reason);
    });

    process.on('uncaughtException', (err) => {
        console.error('Uncaught exception:', err);
        // Give the logger a moment to flush, then exit non-zero
        setTimeout(() => process.exit(1), 1000);
    });

    try {
        // Load and validate configuration
        const config = loadConfig();

        // Create and start the server
        const server = await createServer(config);

        // Handle graceful shutdown — only trigger once
        let shuttingDown = false;
        const shutdown = async (signal: string) => {
            if (shuttingDown) return;
            shuttingDown = true;
            server.logger.info(`Received ${signal}, shutting down...`);
            await server.stop();
            process.exit(0);
        };

        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));

        await server.start();
    } catch (error) {
        console.error('Fatal: Failed to start Pharos');
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('Fatal: Unexpected error in main():', err);
    process.exit(1);
});
