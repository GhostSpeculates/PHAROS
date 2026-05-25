type Job = () => Promise<void>;

let timer: ReturnType<typeof setInterval> | null = null;

export interface StartCronOptions {
    intervalMs: number;
    job: Job;
}

export function startSyncCron(opts: StartCronOptions): void {
    stopSyncCron();
    timer = setInterval(() => {
        opts.job().catch(() => { /* swallow; next tick will retry */ });
    }, opts.intervalMs);
}

export function stopSyncCron(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}
