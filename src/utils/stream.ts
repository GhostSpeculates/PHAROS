import type { FastifyReply } from 'fastify';

/**
 * Check whether the client connection is still alive.
 */
export function isClientConnected(reply: FastifyReply): boolean {
    return !reply.raw.destroyed && !reply.raw.writableEnded;
}

/**
 * Send a single SSE chunk to the client.
 *
 * If `eventName` is provided, the chunk includes an `event: <name>` line
 * before the data line — required by Anthropic's Messages API streaming
 * protocol. OpenAI streaming format omits the event name, so chat-path
 * callers don't pass it.
 *
 * Returns false if the write failed (client disconnected).
 */
export function sendSSEChunk(reply: FastifyReply, data: object, eventName?: string): boolean {
    if (!isClientConnected(reply)) return false;
    try {
        const prefix = eventName ? `event: ${eventName}\n` : '';
        reply.raw.write(`${prefix}data: ${JSON.stringify(data)}\n\n`);
        return true;
    } catch {
        return false;
    }
}

/**
 * Send the final [DONE] marker and end the stream.
 * Returns false if the write failed (client disconnected).
 */
export function sendSSEDone(reply: FastifyReply): boolean {
    if (!isClientConnected(reply)) return false;
    try {
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
        return true;
    } catch {
        return false;
    }
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
