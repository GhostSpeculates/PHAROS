import type { Logger } from '../../utils/logger.js';

/**
 * Sliding window entry for a single agent.
 */
interface WindowEntry {
  count: number;
  windowStart: number;
}

/**
 * Result of a rate limit check.
 */
export interface RateLimitCheckResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

/**
 * Per-agent rate limiter using a sliding window counter.
 */
export interface AgentRateLimiter {
  /** Check if the given agent is allowed to make a request. */
  check(agentId: string): RateLimitCheckResult;
  /** Extract the agent identifier from a model field (e.g. "pharos-auto:noir-prime" -> "noir-prime"). */
  extractAgent(model: string): string | null;
}

const WINDOW_MS = 60_000;

/**
 * Create a per-agent rate limiter.
 *
 * Uses a sliding window counter: each agent gets `maxPerMinute` requests
 * per 60-second window. The window resets once 60 seconds have elapsed
 * since it started.
 *
 * Expired entries are cleaned up every 60 seconds via an unref'd interval
 * so the timer does not keep Node.js alive.
 */
export function createAgentRateLimiter(maxPerMinute: number, logger: Logger): AgentRateLimiter {
  const windows = new Map<string, WindowEntry>();

  // Periodic cleanup of expired entries (every 60s).
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    let cleaned = 0;

    for (const [agentId, entry] of windows) {
      if (now - entry.windowStart >= WINDOW_MS) {
        windows.delete(agentId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug({ cleaned, remaining: windows.size }, 'agent rate limiter cleanup');
    }
  }, WINDOW_MS);

  // Don't keep the process alive just for cleanup.
  cleanupInterval.unref();

  function extractAgent(model: string): string | null {
    if (!model) return null;

    const colonIndex = model.indexOf(':');
    if (colonIndex === -1) return null;

    const agent = model.slice(colonIndex + 1);
    return agent.length > 0 ? agent : null;
  }

  function check(agentId: string): RateLimitCheckResult {
    const now = Date.now();
    const entry = windows.get(agentId);

    // No existing window — start a new one.
    if (!entry || now - entry.windowStart >= WINDOW_MS) {
      windows.set(agentId, { count: 1, windowStart: now });
      return { allowed: true };
    }

    // Within the current window — check the limit.
    if (entry.count >= maxPerMinute) {
      const retryAfterMs = WINDOW_MS - (now - entry.windowStart);
      const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);

      logger.warn(
        { agentId, count: entry.count, maxPerMinute, retryAfterSeconds },
        'agent rate limited',
      );

      return { allowed: false, retryAfterSeconds };
    }

    // Under the limit — increment and allow.
    entry.count++;
    return { allowed: true };
  }

  return { check, extractAgent };
}
