import { describe, it, expect } from 'vitest';
import { Semaphore } from '../utils/semaphore.js';

describe('Semaphore', () => {
  describe('constructor', () => {
    it('throws on non-positive maxConcurrent', () => {
      expect(() => new Semaphore(0)).toThrow('maxConcurrent must be a positive integer');
      expect(() => new Semaphore(-1)).toThrow('maxConcurrent must be a positive integer');
      expect(() => new Semaphore(1.5)).toThrow('maxConcurrent must be a positive integer');
    });

    it('creates a semaphore with the given capacity', () => {
      const sem = new Semaphore(3);
      expect(sem.active).toBe(0);
      expect(sem.waiting).toBe(0);
    });
  });

  describe('acquire and release basic flow', () => {
    it('acquires and releases a single slot', async () => {
      const sem = new Semaphore(1);

      await sem.acquire();
      expect(sem.active).toBe(1);

      sem.release();
      expect(sem.active).toBe(0);
    });

    it('acquire resolves immediately when under capacity', async () => {
      const sem = new Semaphore(3);

      await sem.acquire();
      await sem.acquire();
      await sem.acquire();

      expect(sem.active).toBe(3);
      expect(sem.waiting).toBe(0);

      sem.release();
      sem.release();
      sem.release();
      expect(sem.active).toBe(0);
    });
  });

  describe('allows up to maxConcurrent concurrent acquires', () => {
    it('permits exactly maxConcurrent slots', async () => {
      const sem = new Semaphore(5);
      const acquired: number[] = [];

      for (let i = 0; i < 5; i++) {
        await sem.acquire();
        acquired.push(i);
      }

      expect(acquired).toHaveLength(5);
      expect(sem.active).toBe(5);
      expect(sem.waiting).toBe(0);

      for (let i = 0; i < 5; i++) {
        sem.release();
      }
      expect(sem.active).toBe(0);
    });
  });

  describe('blocks when at capacity, unblocks on release', () => {
    it('queues acquire when at capacity and resolves on release', async () => {
      const sem = new Semaphore(1);
      const order: string[] = [];

      await sem.acquire();
      order.push('first-acquired');

      const blocked = sem.acquire().then(() => {
        order.push('second-acquired');
      });

      // The second acquire should be waiting.
      expect(sem.waiting).toBe(1);
      expect(sem.active).toBe(1);

      // Let microtasks settle — second should still be blocked.
      await Promise.resolve();
      expect(order).toEqual(['first-acquired']);

      sem.release();

      // Now the second acquire should resolve.
      await blocked;
      expect(order).toEqual(['first-acquired', 'second-acquired']);
      expect(sem.active).toBe(1);
      expect(sem.waiting).toBe(0);

      sem.release();
      expect(sem.active).toBe(0);
    });
  });

  describe('queue timeout', () => {
    it('rejects if acquire takes too long', async () => {
      const sem = new Semaphore(1);
      await sem.acquire();

      await expect(sem.acquire(50)).rejects.toThrow('Semaphore acquire timed out after 50ms');

      // The timed-out waiter should have been removed from the queue.
      expect(sem.waiting).toBe(0);
      expect(sem.active).toBe(1);

      sem.release();
      expect(sem.active).toBe(0);
    });

    it('does not reject if slot becomes available before timeout', async () => {
      const sem = new Semaphore(1);
      await sem.acquire();

      const acquirePromise = sem.acquire(500);

      // Release quickly — well within timeout.
      setTimeout(() => sem.release(), 10);

      await expect(acquirePromise).resolves.toBeUndefined();
      expect(sem.active).toBe(1);

      sem.release();
    });

    it('cleans up timed-out waiter from queue', async () => {
      const sem = new Semaphore(1);
      await sem.acquire();

      // Queue two waiters: one with timeout, one without.
      const timedOut = sem.acquire(30).catch(() => 'timed-out');
      const waiting = sem.acquire();

      expect(sem.waiting).toBe(2);

      // Wait for the timeout to fire.
      await timedOut;
      expect(sem.waiting).toBe(1);

      // Release should serve the remaining waiter.
      sem.release();
      await waiting;
      expect(sem.active).toBe(1);
      expect(sem.waiting).toBe(0);

      sem.release();
    });
  });

  describe('active and waiting getters', () => {
    it('reports accurate active count through acquire/release cycle', async () => {
      const sem = new Semaphore(3);

      expect(sem.active).toBe(0);
      await sem.acquire();
      expect(sem.active).toBe(1);
      await sem.acquire();
      expect(sem.active).toBe(2);
      await sem.acquire();
      expect(sem.active).toBe(3);

      sem.release();
      expect(sem.active).toBe(2);
      sem.release();
      expect(sem.active).toBe(1);
      sem.release();
      expect(sem.active).toBe(0);
    });

    it('reports accurate waiting count', async () => {
      const sem = new Semaphore(1);
      await sem.acquire();

      expect(sem.waiting).toBe(0);

      const p1 = sem.acquire();
      expect(sem.waiting).toBe(1);

      const p2 = sem.acquire();
      expect(sem.waiting).toBe(2);

      sem.release();
      await p1;
      expect(sem.waiting).toBe(1);

      sem.release();
      await p2;
      expect(sem.waiting).toBe(0);

      sem.release();
    });
  });

  describe('release when nothing is active', () => {
    it('does not go negative on extra release calls', () => {
      const sem = new Semaphore(3);

      expect(sem.active).toBe(0);
      sem.release();
      expect(sem.active).toBe(0);
      sem.release();
      expect(sem.active).toBe(0);
    });

    it('still works correctly after spurious releases', async () => {
      const sem = new Semaphore(1);

      sem.release(); // spurious
      sem.release(); // spurious

      await sem.acquire();
      expect(sem.active).toBe(1);

      sem.release();
      expect(sem.active).toBe(0);
    });
  });

  describe('multiple waiters served in FIFO order', () => {
    it('resolves queued waiters in the order they were added', async () => {
      const sem = new Semaphore(1);
      const order: number[] = [];

      await sem.acquire();

      const p1 = sem.acquire().then(() => order.push(1));
      const p2 = sem.acquire().then(() => order.push(2));
      const p3 = sem.acquire().then(() => order.push(3));

      expect(sem.waiting).toBe(3);

      // Release three times to unblock all waiters in order.
      sem.release();
      await p1;

      sem.release();
      await p2;

      sem.release();
      await p3;

      expect(order).toEqual([1, 2, 3]);

      sem.release();
      expect(sem.active).toBe(0);
    });
  });

  describe('concurrent stress test', () => {
    it('never exceeds maxConcurrent active tasks with 20 tasks through semaphore(5)', async () => {
      const sem = new Semaphore(5);
      let peakConcurrent = 0;
      let currentConcurrent = 0;

      const task = async (id: number): Promise<number> => {
        await sem.acquire();

        currentConcurrent++;
        if (currentConcurrent > peakConcurrent) {
          peakConcurrent = currentConcurrent;
        }

        // Verify we never exceed the limit at any point.
        expect(currentConcurrent).toBeLessThanOrEqual(5);

        // Simulate some async work with varying durations.
        await new Promise((r) => setTimeout(r, Math.random() * 20));

        currentConcurrent--;
        sem.release();

        return id;
      };

      const tasks = Array.from({ length: 20 }, (_, i) => task(i));
      const results = await Promise.all(tasks);

      expect(results).toHaveLength(20);
      expect(peakConcurrent).toBe(5);
      expect(currentConcurrent).toBe(0);
      expect(sem.active).toBe(0);
      expect(sem.waiting).toBe(0);
    });

    it('handles rapid acquire/release cycles without deadlock', async () => {
      const sem = new Semaphore(2);
      const completed: number[] = [];

      const task = async (id: number): Promise<void> => {
        await sem.acquire();
        await Promise.resolve(); // yield microtask
        completed.push(id);
        sem.release();
      };

      await Promise.all(Array.from({ length: 50 }, (_, i) => task(i)));

      expect(completed).toHaveLength(50);
      expect(sem.active).toBe(0);
      expect(sem.waiting).toBe(0);
    });
  });
});
