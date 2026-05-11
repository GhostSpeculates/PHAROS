import type { Logger } from '../../utils/logger.js';

/**
 * Result of a rate limit check.
 */
export interface RateLimitCheckResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

/**
 * Generic sliding window rate limiter keyed by an arbitrary string (IP or email).
 */
export interface SlidingWindowLimiter {
  check(key: string): RateLimitCheckResult;
}

interface WindowEntry {
  count: number;
  windowStart: number;
}

/**
 * Create a sliding window rate limiter.
 *
 * @param windowMs   Rolling window length in milliseconds.
 * @param max        Maximum requests allowed within the window.
 * @param label      Log label (e.g. 'ip', 'email') for structured log fields.
 * @param logger     Pino logger instance.
 */
export function createSlidingWindowLimiter(
  windowMs: number,
  max: number,
  label: string,
  logger: Logger,
): SlidingWindowLimiter {
  const windows = new Map<string, WindowEntry>();

  // Periodic cleanup of expired entries. unref() so the timer doesn't keep
  // the process alive.
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, entry] of windows) {
      if (now - entry.windowStart >= windowMs) {
        windows.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.debug({ cleaned, remaining: windows.size, label }, 'checkout rate limiter cleanup');
    }
  }, windowMs);

  cleanupInterval.unref();

  function check(key: string): RateLimitCheckResult {
    const now = Date.now();
    const entry = windows.get(key);

    if (!entry || now - entry.windowStart >= windowMs) {
      windows.set(key, { count: 1, windowStart: now });
      return { allowed: true };
    }

    if (entry.count >= max) {
      const retryAfterMs = windowMs - (now - entry.windowStart);
      const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);
      logger.warn({ key, count: entry.count, max, retryAfterSeconds, label }, 'checkout rate limited');
      return { allowed: false, retryAfterSeconds };
    }

    entry.count++;
    return { allowed: true };
  }

  return { check };
}
