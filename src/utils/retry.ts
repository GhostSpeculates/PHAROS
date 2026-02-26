/**
 * Retry-with-backoff utility for transient provider errors.
 *
 * Pharos retries ONCE with exponential backoff + jitter before
 * failing over to a different provider. Non-transient errors
 * (400, 401, 403, 404, context-size) are never retried.
 */

const TRANSIENT_STATUS_CODES = new Set([429, 502, 503]);

const NON_TRANSIENT_STATUS_CODES = new Set([400, 401, 403, 404]);

const TRANSIENT_MESSAGE_PATTERNS = [
  /\b429\b/,
  /\b502\b/,
  /\b503\b/,
  /timeout/i,
  /etimedout/i,
  /econnreset/i,
  /econnrefused/i,
  /socket hang up/i,
  /rate limit/i,
  /too many requests/i,
];

const CONTEXT_SIZE_PATTERNS = [/context/i, /too long/i, /maximum context/i];

function getStatus(error: unknown): number | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as Record<string, unknown>).status === 'number'
  ) {
    return (error as Record<string, unknown>).status as number;
  }
  return undefined;
}

function getMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return '';
}

/**
 * Returns true if the error indicates a transient issue that is worth retrying:
 * - HTTP 429 (rate limit / too many requests)
 * - HTTP 502, 503 (bad gateway / service unavailable)
 * - Network timeout / connection errors
 * - Message contains "rate limit" or "too many requests"
 *
 * Returns false for client errors (400, 401, 403, 404), context-size errors,
 * and non-Error values.
 */
export function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const status = getStatus(error);
  const message = getMessage(error);

  // Non-transient status codes — never retry
  if (status !== undefined && NON_TRANSIENT_STATUS_CODES.has(status)) {
    return false;
  }

  // Context / content size errors — never retry
  for (const pattern of CONTEXT_SIZE_PATTERNS) {
    if (pattern.test(message)) {
      return false;
    }
  }

  // Transient status codes — retry
  if (status !== undefined && TRANSIENT_STATUS_CODES.has(status)) {
    return true;
  }

  // Transient message patterns — retry
  for (const pattern of TRANSIENT_MESSAGE_PATTERNS) {
    if (pattern.test(message)) {
      return true;
    }
  }

  return false;
}

/**
 * Calculate exponential backoff with jitter.
 *
 * Formula: min(1000 * 2^attempt + random(0, 500), 5000)
 *
 * - attempt=0 → 1000–1500ms
 * - attempt=1 → 2000–2500ms
 * - attempt=2 → 4000–4500ms
 * - attempt=3+ → capped at 5000ms
 */
export function calculateBackoffMs(attempt: number): number {
  const base = 1000 * Math.pow(2, attempt);
  const jitter = Math.random() * 500;
  return Math.min(base + jitter, 5000);
}

/**
 * Promise-based delay.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
