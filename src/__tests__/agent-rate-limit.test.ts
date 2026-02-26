import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAgentRateLimiter } from '../gateway/middleware/agent-rate-limit.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
} as any;

// ────────────────────────────────────────────────────────────────
// extractAgent
// ────────────────────────────────────────────────────────────────
describe('extractAgent', () => {
  const limiter = createAgentRateLimiter(10, logger);

  it('extracts agent after colon', () => {
    expect(limiter.extractAgent('pharos-auto:noir-prime')).toBe('noir-prime');
  });

  it('returns null when no colon is present', () => {
    expect(limiter.extractAgent('pharos-auto')).toBeNull();
  });

  it('returns everything after the first colon when multiple colons exist', () => {
    expect(limiter.extractAgent('pharos-auto:agent:extra')).toBe('agent:extra');
  });

  it('returns null for empty string', () => {
    expect(limiter.extractAgent('')).toBeNull();
  });

  it('returns null when colon is at the end with nothing after it', () => {
    expect(limiter.extractAgent('pharos-auto:')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// check
// ────────────────────────────────────────────────────────────────
describe('check', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests under the limit', () => {
    const limiter = createAgentRateLimiter(5, logger);

    for (let i = 0; i < 5; i++) {
      const result = limiter.check('noir-prime');
      expect(result.allowed).toBe(true);
      expect(result.retryAfterSeconds).toBeUndefined();
    }
  });

  it('blocks when the limit is reached', () => {
    const limiter = createAgentRateLimiter(3, logger);

    // Use up all 3 allowed requests.
    limiter.check('noir-prime');
    limiter.check('noir-prime');
    limiter.check('noir-prime');

    // 4th request should be blocked.
    const result = limiter.check('noir-prime');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeDefined();
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('returns correct retryAfterSeconds', () => {
    const limiter = createAgentRateLimiter(1, logger);

    // Use up the single allowed request.
    limiter.check('noir-prime');

    // Advance time by 30 seconds (halfway through the window).
    vi.advanceTimersByTime(30_000);

    const result = limiter.check('noir-prime');
    expect(result.allowed).toBe(false);
    // 60s window started at t=0, we're at t=30s, so ~30s remaining.
    expect(result.retryAfterSeconds).toBe(30);
  });

  it('resets after the window expires', () => {
    const limiter = createAgentRateLimiter(2, logger);

    // Use up both requests.
    limiter.check('noir-prime');
    limiter.check('noir-prime');

    // Blocked now.
    expect(limiter.check('noir-prime').allowed).toBe(false);

    // Advance past the 60-second window.
    vi.advanceTimersByTime(60_000);

    // Should be allowed again with a fresh window.
    const result = limiter.check('noir-prime');
    expect(result.allowed).toBe(true);
  });

  it('different agents have independent limits', () => {
    const limiter = createAgentRateLimiter(1, logger);

    // noir-prime uses its one request.
    expect(limiter.check('noir-prime').allowed).toBe(true);
    expect(limiter.check('noir-prime').allowed).toBe(false);

    // shadow-agent is unaffected.
    expect(limiter.check('shadow-agent').allowed).toBe(true);
    expect(limiter.check('shadow-agent').allowed).toBe(false);
  });

  it('logs a warning when an agent is rate limited', () => {
    const limiter = createAgentRateLimiter(1, logger);

    limiter.check('noir-prime');
    limiter.check('noir-prime');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'noir-prime',
        maxPerMinute: 1,
      }),
      'agent rate limited',
    );
  });

  it('cleanup interval removes expired entries', () => {
    const limiter = createAgentRateLimiter(5, logger);

    limiter.check('noir-prime');
    limiter.check('shadow-agent');

    // Advance past 60s so entries expire, then trigger the cleanup interval.
    vi.advanceTimersByTime(60_000);

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ cleaned: 2, remaining: 0 }),
      'agent rate limiter cleanup',
    );
  });
});
