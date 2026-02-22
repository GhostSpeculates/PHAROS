import { nanoid } from 'nanoid';

/**
 * Generate an OpenAI-style completion ID.
 * Format: chatcmpl-<random>
 */
export function generateCompletionId(): string {
    return `chatcmpl-${nanoid(24)}`;
}

/**
 * Generate a unique request ID for internal tracking.
 */
export function generateRequestId(): string {
    return `req-${nanoid(16)}`;
}
