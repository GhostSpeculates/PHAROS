import type { FastifyReply } from 'fastify';

/**
 * Send a single SSE chunk to the client.
 */
export function sendSSEChunk(reply: FastifyReply, data: object): void {
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Send the final [DONE] marker and end the stream.
 */
export function sendSSEDone(reply: FastifyReply): void {
    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
}

/**
 * Set up SSE headers on the response and hijack from Fastify.
 *
 * reply.hijack() tells Fastify we're taking over the response —
 * without it, Fastify tries to send a response after the async handler
 * returns, causing ERR_HTTP_HEADERS_SENT crashes.
 */
export function initSSEHeaders(reply: FastifyReply): void {
    reply.hijack();
    reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
}
