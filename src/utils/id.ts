import { nanoid } from 'nanoid';
import { randomUUID } from 'node:crypto';

/**
 * Generate an OpenAI-style completion ID.
 * Format: chatcmpl-<random>
 */
export function generateCompletionId(): string {
    return `chatcmpl-${nanoid(24)}`;
}

/**
 * Generate a unique request ID (UUID v4) for internal tracking.
 * If the client provides an X-Request-Id header, that should be used instead.
 */
export function generateRequestId(): string {
    return randomUUID();
}
