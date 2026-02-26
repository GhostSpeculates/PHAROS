import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isTransientError, calculateBackoffMs, sleep } from '../utils/retry.js';

// Helper: create an Error with a `.status` property (mimics OpenAI SDK errors)
function errorWithStatus(message: string, status: number): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

describe('isTransientError', () => {
  describe('returns true for transient errors', () => {
    it('HTTP 429 via status property', () => {
      expect(isTransientError(errorWithStatus('error', 429))).toBe(true);
    });

    it('HTTP 429 in message', () => {
      expect(isTransientError(new Error('Request failed with status 429'))).toBe(true);
    });

    it('HTTP 502 Bad Gateway in message', () => {
      expect(isTransientError(new Error('502 Bad Gateway'))).toBe(true);
    });

    it('HTTP 502 via status property', () => {
      expect(isTransientError(errorWithStatus('Bad Gateway', 502))).toBe(true);
    });

    it('HTTP 503 Service Unavailable in message', () => {
      expect(isTransientError(new Error('503 Service Unavailable'))).toBe(true);
    });

    it('HTTP 503 via status property', () => {
      expect(isTransientError(errorWithStatus('Service Unavailable', 503))).toBe(true);
    });

    it('timeout error', () => {
      expect(isTransientError(new Error('Request timeout'))).toBe(true);
    });

    it('ETIMEDOUT error', () => {
      expect(isTransientError(new Error('connect ETIMEDOUT 1.2.3.4:443'))).toBe(true);
    });

    it('ECONNRESET error', () => {
      expect(isTransientError(new Error('read ECONNRESET'))).toBe(true);
    });

    it('ECONNREFUSED error', () => {
      expect(isTransientError(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe(true);
    });

    it('socket hang up error', () => {
      expect(isTransientError(new Error('socket hang up'))).toBe(true);
    });

    it('rate limit exceeded message', () => {
      expect(isTransientError(new Error('rate limit exceeded'))).toBe(true);
    });

    it('too many requests message', () => {
      expect(isTransientError(new Error('too many requests, please slow down'))).toBe(true);
    });

    it('case insensitive rate limit', () => {
      expect(isTransientError(new Error('Rate Limit Exceeded'))).toBe(true);
    });

    it('case insensitive too many requests', () => {
      expect(isTransientError(new Error('Too Many Requests'))).toBe(true);
    });
  });

  describe('returns false for non-transient errors', () => {
    it('HTTP 400 Bad Request', () => {
      expect(isTransientError(new Error('400 Bad Request'))).toBe(false);
    });

    it('HTTP 400 via status property', () => {
      expect(isTransientError(errorWithStatus('Bad Request', 400))).toBe(false);
    });

    it('HTTP 401 Unauthorized', () => {
      expect(isTransientError(new Error('401 Unauthorized'))).toBe(false);
    });

    it('HTTP 401 via status property', () => {
      expect(isTransientError(errorWithStatus('Unauthorized', 401))).toBe(false);
    });

    it('HTTP 403 Forbidden', () => {
      expect(isTransientError(new Error('403 Forbidden'))).toBe(false);
    });

    it('HTTP 403 via status property', () => {
      expect(isTransientError(errorWithStatus('Forbidden', 403))).toBe(false);
    });

    it('HTTP 404 Not Found via status property', () => {
      expect(isTransientError(errorWithStatus('Not Found', 404))).toBe(false);
    });

    it('context length exceeded', () => {
      expect(isTransientError(new Error('context length exceeded'))).toBe(false);
    });

    it('maximum context length', () => {
      expect(isTransientError(new Error('maximum context length is 4096 tokens'))).toBe(false);
    });

    it('content too long', () => {
      expect(isTransientError(new Error('input too long for model'))).toBe(false);
    });

    it('generic error without transient pattern', () => {
      expect(isTransientError(new Error('something went wrong'))).toBe(false);
    });
  });

  describe('returns false for non-Error values', () => {
    it('string', () => {
      expect(isTransientError('timeout error')).toBe(false);
    });

    it('null', () => {
      expect(isTransientError(null)).toBe(false);
    });

    it('undefined', () => {
      expect(isTransientError(undefined)).toBe(false);
    });

    it('number', () => {
      expect(isTransientError(429)).toBe(false);
    });

    it('plain object', () => {
      expect(isTransientError({ message: 'timeout', status: 429 })).toBe(false);
    });
  });
});

describe('calculateBackoffMs', () => {
  it('attempt=0 returns value between 1000 and 1500', () => {
    for (let i = 0; i < 50; i++) {
      const ms = calculateBackoffMs(0);
      expect(ms).toBeGreaterThanOrEqual(1000);
      expect(ms).toBeLessThanOrEqual(1500);
    }
  });

  it('attempt=1 returns value between 2000 and 2500', () => {
    for (let i = 0; i < 50; i++) {
      const ms = calculateBackoffMs(1);
      expect(ms).toBeGreaterThanOrEqual(2000);
      expect(ms).toBeLessThanOrEqual(2500);
    }
  });

  it('attempt=2 returns value between 4000 and 4500', () => {
    for (let i = 0; i < 50; i++) {
      const ms = calculateBackoffMs(2);
      expect(ms).toBeGreaterThanOrEqual(4000);
      expect(ms).toBeLessThanOrEqual(4500);
    }
  });

  it('high attempt is capped at 5000', () => {
    for (let i = 0; i < 50; i++) {
      const ms = calculateBackoffMs(10);
      expect(ms).toBeLessThanOrEqual(5000);
    }
  });

  it('attempt=3 is capped at 5000', () => {
    // base = 1000 * 2^3 = 8000, + jitter up to 500 = 8500, capped to 5000
    for (let i = 0; i < 50; i++) {
      const ms = calculateBackoffMs(3);
      expect(ms).toBe(5000);
    }
  });

  it('returns different values (jitter works)', () => {
    const values = new Set<number>();
    for (let i = 0; i < 20; i++) {
      values.add(calculateBackoffMs(0));
    }
    // With 20 random attempts, we should get at least 2 distinct values
    expect(values.size).toBeGreaterThan(1);
  });
});

describe('sleep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves after the specified duration', async () => {
    let resolved = false;
    const promise = sleep(1000).then(() => {
      resolved = true;
    });

    expect(resolved).toBe(false);

    vi.advanceTimersByTime(999);
    await Promise.resolve(); // flush microtasks
    expect(resolved).toBe(false);

    vi.advanceTimersByTime(1);
    await promise;
    expect(resolved).toBe(true);
  });

  it('resolves immediately for 0ms', async () => {
    let resolved = false;
    const promise = sleep(0).then(() => {
      resolved = true;
    });

    vi.advanceTimersByTime(0);
    await promise;
    expect(resolved).toBe(true);
  });

  it('returns a Promise<void>', () => {
    const result = sleep(100);
    expect(result).toBeInstanceOf(Promise);
    vi.advanceTimersByTime(100);
  });
});
