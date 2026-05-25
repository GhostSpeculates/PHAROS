import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startSyncCron, stopSyncCron } from '../../sync/cron.js';

describe('sync cron', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); stopSyncCron(); });

    it('invokes job at every interval', async () => {
        const job = vi.fn().mockResolvedValue(undefined);
        startSyncCron({ intervalMs: 1000, job });

        await vi.advanceTimersByTimeAsync(1000);
        expect(job).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1000);
        expect(job).toHaveBeenCalledTimes(2);
    });

    it('stopSyncCron prevents further invocations', async () => {
        const job = vi.fn().mockResolvedValue(undefined);
        startSyncCron({ intervalMs: 1000, job });
        stopSyncCron();
        await vi.advanceTimersByTimeAsync(5000);
        expect(job).not.toHaveBeenCalled();
    });

    it('continues running even if a job throws', async () => {
        const job = vi.fn()
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValue(undefined);
        startSyncCron({ intervalMs: 1000, job });
        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(1000);
        expect(job).toHaveBeenCalledTimes(2);
    });
});
