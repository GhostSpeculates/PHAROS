import { loadConfig } from '../config/index.js';
import { createServer } from '../server.js';

/**
 * `pharos start` — Start the routing server.
 */
export async function startCommand(options: { port?: string; config?: string }) {
    try {
        // Override port from CLI if provided
        if (options.port) {
            process.env.PHAROS_PORT = options.port;
        }

        const config = loadConfig();
        const server = await createServer(config);

        // Graceful shutdown
        const shutdown = async () => {
            await server.stop();
            process.exit(0);
        };

        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        await server.start();
    } catch (error) {
        console.error('Failed to start Pharos:');
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    }
}
