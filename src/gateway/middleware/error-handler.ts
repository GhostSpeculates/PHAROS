import type { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { buildErrorResponse } from '../schemas/response.js';
import type { Logger } from '../../utils/logger.js';

/**
 * Global error handler that formats all errors as OpenAI-compatible responses.
 */
export function createErrorHandler(logger: Logger) {
    return (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
        logger.error(
            {
                err: error.message,
                url: request.url,
                method: request.method,
            },
            'Request error',
        );

        const statusCode = error.statusCode ?? 500;

        // Map common errors to OpenAI error types
        let errorType = 'server_error';
        if (statusCode === 400) errorType = 'invalid_request_error';
        if (statusCode === 401) errorType = 'authentication_error';
        if (statusCode === 429) errorType = 'rate_limit_error';
        if (statusCode === 404) errorType = 'not_found_error';

        reply.status(statusCode).send(
            buildErrorResponse(error.message, errorType),
        );
    };
}
