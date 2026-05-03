import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isClientConnected, sendSSEChunk, sendSSEDone, initSSEHeaders } from '../utils/stream.js';
import type { FastifyReply } from 'fastify';

// ─── Mock Reply ──────────────────────────────────────────

function makeMockReply(opts?: { destroyed?: boolean; writableEnded?: boolean }): FastifyReply {
    const raw = {
        destroyed: opts?.destroyed ?? false,
        writableEnded: opts?.writableEnded ?? false,
        write: vi.fn().mockReturnValue(true),
        end: vi.fn(),
        writeHead: vi.fn(),
    };

    return {
        raw,
        hijack: vi.fn(),
    } as unknown as FastifyReply;
}

// ─── Tests ───────────────────────────────────────────────

describe('isClientConnected', () => {
    it('returns true when client is connected', () => {
        const reply = makeMockReply();
        expect(isClientConnected(reply)).toBe(true);
    });

    it('returns false when raw stream is destroyed', () => {
        const reply = makeMockReply({ destroyed: true });
        expect(isClientConnected(reply)).toBe(false);
    });

    it('returns false when raw stream writableEnded', () => {
        const reply = makeMockReply({ writableEnded: true });
        expect(isClientConnected(reply)).toBe(false);
    });
});

describe('sendSSEChunk', () => {
    it('writes SSE-formatted data to the raw stream', () => {
        const reply = makeMockReply();
        const data = { choices: [{ delta: { content: 'hello' } }] };
        const result = sendSSEChunk(reply, data);

        expect(result).toBe(true);
        expect(reply.raw.write).toHaveBeenCalledWith(`data: ${JSON.stringify(data)}\n\n`);
    });

    it('returns false when client is disconnected', () => {
        const reply = makeMockReply({ destroyed: true });
        const result = sendSSEChunk(reply, { test: true });

        expect(result).toBe(false);
        expect(reply.raw.write).not.toHaveBeenCalled();
    });

    it('returns false when write throws', () => {
        const reply = makeMockReply();
        (reply.raw.write as any).mockImplementation(() => {
            throw new Error('write failed');
        });

        const result = sendSSEChunk(reply, { test: true });
        expect(result).toBe(false);
    });
});

describe('sendSSEDone', () => {
    it('writes [DONE] marker and ends the stream', () => {
        const reply = makeMockReply();
        const result = sendSSEDone(reply);

        expect(result).toBe(true);
        expect(reply.raw.write).toHaveBeenCalledWith('data: [DONE]\n\n');
        expect(reply.raw.end).toHaveBeenCalled();
    });

    it('returns false when client is disconnected', () => {
        const reply = makeMockReply({ destroyed: true });
        const result = sendSSEDone(reply);

        expect(result).toBe(false);
        expect(reply.raw.write).not.toHaveBeenCalled();
        expect(reply.raw.end).not.toHaveBeenCalled();
    });

    it('returns false when write throws', () => {
        const reply = makeMockReply();
        (reply.raw.write as any).mockImplementation(() => {
            throw new Error('write failed');
        });

        const result = sendSSEDone(reply);
        expect(result).toBe(false);
    });
});

describe('initSSEHeaders', () => {
    it('hijacks the reply and sets SSE headers', () => {
        const reply = makeMockReply();
        initSSEHeaders(reply);

        expect(reply.hijack).toHaveBeenCalled();
        expect(reply.raw.writeHead).toHaveBeenCalledWith(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
    });
});

describe('sendSSEChunk with eventName', () => {
    it('omits event line when eventName not provided (OpenAI shape)', () => {
        const reply = makeMockReply();
        sendSSEChunk(reply, { foo: 1 });
        expect(reply.raw.write).toHaveBeenCalledWith('data: {"foo":1}\n\n');
    });

    it('includes event line when eventName provided (Anthropic shape)', () => {
        const reply = makeMockReply();
        sendSSEChunk(reply, { type: 'message_start' }, 'message_start');
        expect(reply.raw.write).toHaveBeenCalledWith(
            'event: message_start\ndata: {"type":"message_start"}\n\n',
        );
    });
});
