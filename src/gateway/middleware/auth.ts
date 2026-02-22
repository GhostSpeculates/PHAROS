import type { FastifyRequest, FastifyReply } from 'fastify';
import type { PharosConfig } from '../../config/schema.js';
import { buildErrorResponse } from '../schemas/response.js';

/**
 * API key authentication middleware.
 *
 * Clients must send a Bearer token matching the configured Pharos API key.
 * If no API key is configured, authentication is skipped (open mode).
 */
export function createAuthMiddleware(config: PharosConfig) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        // If no API key configured, skip auth (useful for local dev)
        if (!config.auth.apiKey) {
            return;
        }

        const authHeader = request.headers.authorization;

        if (!authHeader) {
            reply.status(401).send(
                buildErrorResponse(
                    'Missing Authorization header. Use: Authorization: Bearer <your-pharos-key>',
                    'authentication_error',
                    'missing_api_key',
                ),
            );
            return reply;
        }

        const match = authHeader.match(/^Bearer\s+(\S+)$/);

        if (!match) {
            reply.status(401).send(
                buildErrorResponse(
                    'Malformed Authorization header. Use: Authorization: Bearer <your-pharos-key>',
                    'authentication_error',
                    'invalid_api_key',
                ),
            );
            return reply;
        }

        const token = match[1];

        if (token !== config.auth.apiKey) {
            reply.status(401).send(
                buildErrorResponse(
                    'Invalid API key provided.',
                    'authentication_error',
                    'invalid_api_key',
                ),
            );
            return reply;
        }
    };
}
