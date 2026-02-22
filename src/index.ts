import { loadConfig } from './config/index.js';
import { createServer } from './server.js';

/**
 * Pharos — Intelligent LLM Routing Gateway
 *
 * Entry point. Loads config, creates server, handles graceful shutdown.
 */
async function main() {
    try {
        // Load and validate configuration
        const config = loadConfig();

        // Create and start the server
        const server = await createServer(config);

        // Handle graceful shutdown
        const shutdown = async () => {
            await server.stop();
            process.exit(0);
        };

        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        await server.start();
    } catch (error) {
        console.error('Fatal: Failed to start Pharos');
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    }
}

main();
