export interface LRUCacheOptions {
  maxSize: number;
  ttlMs: number;
}

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

export class LRUCache<V> {
  private map: Map<string, CacheEntry<V>>;
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(options: LRUCacheOptions) {
    this.maxSize = options.maxSize;
    this.ttlMs = options.ttlMs;
    this.map = new Map();
  }

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }

    // Re-insert to promote to most-recently-used position
    this.map.delete(key);
    this.map.set(key, entry);

    return entry.value;
  }

  set(key: string, value: V): void {
    // Delete existing entry so re-insert moves it to the end
    if (this.map.has(key)) {
      this.map.delete(key);
    }

    // Evict oldest (first) entry if at capacity
    if (this.map.size >= this.maxSize) {
      const oldestKey = this.map.keys().next().value as string;
      this.map.delete(oldestKey);
    }

    this.map.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}
