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

/**
 * Generate a fresh customer-facing Pharos API key. Format `pharos-{nanoid(32)}`
 * matches the operator-key shape so existing parsing assumptions hold.
 * 32 chars × ~5 bits = ~160 bits of entropy — well above the threshold for
 * an unguessable bearer token. Returned plaintext is shown to the user once;
 * only the SHA-256 hash is persisted (see WalletStore.hashApiKey).
 */
export function generateUserApiKey(): string {
    return `pharos-${nanoid(32)}`;
}
