import pino from 'pino';

/**
 * Create the application logger.
 * In dev mode: colorful, human-readable output.
 * In production: structured JSON for log aggregation.
 */
export function createLogger(level: string = 'info', pretty: boolean = true) {
    return pino({
        level,
        ...(pretty
            ? {
                transport: {
                    target: 'pino-pretty',
                    options: {
                        colorize: true,
                        translateTime: 'HH:MM:ss',
                        ignore: 'pid,hostname',
                    },
                },
            }
            : {}),
    });
}

export type Logger = pino.Logger;
