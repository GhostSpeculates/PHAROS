import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LRUCache } from '../utils/lru-cache.js';

describe('LRUCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should set and get a basic value', () => {
    const cache = new LRUCache<string>({ maxSize: 10, ttlMs: 60_000 });
    cache.set('key1', 'value1');
    expect(cache.get('key1')).toBe('value1');
  });

  it('should return undefined for a missing key', () => {
    const cache = new LRUCache<string>({ maxSize: 10, ttlMs: 60_000 });
    expect(cache.get('nonexistent')).toBeUndefined();
  });

  it('should evict the oldest entry when maxSize is exceeded', () => {
    const cache = new LRUCache<string>({ maxSize: 3, ttlMs: 60_000 });
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');
    // Adding a 4th entry should evict 'a' (oldest)
    cache.set('d', '4');

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('2');
    expect(cache.get('c')).toBe('3');
    expect(cache.get('d')).toBe('4');
    expect(cache.size).toBe(3);
  });

  it('should promote an accessed key so it is not evicted next', () => {
    const cache = new LRUCache<string>({ maxSize: 3, ttlMs: 60_000 });
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');

    // Access 'a' to promote it — 'b' becomes the oldest
    cache.get('a');

    // Insert a new entry — 'b' should be evicted, not 'a'
    cache.set('d', '4');

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('1');
    expect(cache.get('c')).toBe('3');
    expect(cache.get('d')).toBe('4');
  });

  it('should expire entries after ttlMs', () => {
    const cache = new LRUCache<string>({ maxSize: 10, ttlMs: 5_000 });
    cache.set('key1', 'value1');

    // Advance time past the TTL
    vi.advanceTimersByTime(5_001);

    expect(cache.get('key1')).toBeUndefined();
  });

  it('should return entries that have not yet expired', () => {
    const cache = new LRUCache<string>({ maxSize: 10, ttlMs: 5_000 });
    cache.set('key1', 'value1');

    // Advance time but stay within the TTL
    vi.advanceTimersByTime(4_999);

    expect(cache.get('key1')).toBe('value1');
  });

  it('should overwrite previous value and reset TTL when setting the same key', () => {
    const cache = new LRUCache<string>({ maxSize: 10, ttlMs: 5_000 });
    cache.set('key1', 'original');

    // Advance 3 seconds
    vi.advanceTimersByTime(3_000);

    // Overwrite the key — TTL resets
    cache.set('key1', 'updated');

    // Advance another 3 seconds (6s total from original set, but only 3s from reset)
    vi.advanceTimersByTime(3_000);

    // Should still be available because TTL was reset
    expect(cache.get('key1')).toBe('updated');

    // Advance past the new TTL
    vi.advanceTimersByTime(2_001);

    expect(cache.get('key1')).toBeUndefined();
  });

  it('should remove all entries on clear()', () => {
    const cache = new LRUCache<string>({ maxSize: 10, ttlMs: 60_000 });
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');

    expect(cache.size).toBe(3);

    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeUndefined();
  });

  it('should report accurate size', () => {
    const cache = new LRUCache<string>({ maxSize: 10, ttlMs: 60_000 });

    expect(cache.size).toBe(0);

    cache.set('a', '1');
    expect(cache.size).toBe(1);

    cache.set('b', '2');
    expect(cache.size).toBe(2);

    // Overwriting should not increase size
    cache.set('a', 'updated');
    expect(cache.size).toBe(2);
  });

  it('should never exceed maxSize under stress', () => {
    const maxSize = 100;
    const cache = new LRUCache<number>({ maxSize, ttlMs: 60_000 });

    for (let i = 0; i < 200; i++) {
      cache.set(`key-${i}`, i);
      expect(cache.size).toBeLessThanOrEqual(maxSize);
    }

    expect(cache.size).toBe(maxSize);

    // The first 100 keys should have been evicted
    for (let i = 0; i < 100; i++) {
      expect(cache.get(`key-${i}`)).toBeUndefined();
    }

    // The last 100 keys should still be present
    for (let i = 100; i < 200; i++) {
      expect(cache.get(`key-${i}`)).toBe(i);
    }
  });
});
