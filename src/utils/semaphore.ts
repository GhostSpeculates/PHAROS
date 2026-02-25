/**
 * A counting semaphore for concurrency limiting.
 *
 * Allows up to `maxConcurrent` tasks to run simultaneously.
 * Additional acquirers are queued and served in FIFO order.
 */
export class Semaphore {
  private readonly max: number;
  private current: number;
  private readonly queue: Array<() => void>;

  constructor(maxConcurrent: number) {
    if (maxConcurrent < 1 || !Number.isInteger(maxConcurrent)) {
      throw new Error('maxConcurrent must be a positive integer');
    }
    this.max = maxConcurrent;
    this.current = 0;
    this.queue = [];
  }

  /**
   * Wait until a slot is available, then acquire it.
   * If queueTimeoutMs is provided and a slot cannot be acquired
   * within that time, throws an error.
   */
  async acquire(queueTimeoutMs?: number): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const resolver = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        resolve();
      };

      this.queue.push(resolver);

      if (queueTimeoutMs !== undefined) {
        timer = setTimeout(() => {
          const idx = this.queue.indexOf(resolver);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
          }
          reject(new Error(`Semaphore acquire timed out after ${queueTimeoutMs}ms`));
        }, queueTimeoutMs);
      }
    });
  }

  /**
   * Release a slot back to the pool.
   * If there are waiters in the queue, the next one is served immediately.
   */
  release(): void {
    if (this.current <= 0) {
      return;
    }

    if (this.queue.length > 0) {
      // Hand the slot directly to the next waiter (current count stays the same).
      const next = this.queue.shift()!;
      next();
    } else {
      this.current--;
    }
  }

  /** Current number of active (acquired) slots. */
  get active(): number {
    return this.current;
  }

  /** Current number of waiters in the queue. */
  get waiting(): number {
    return this.queue.length;
  }
}
