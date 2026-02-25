import type { Logger } from './logger.js';

export type AlertSeverity = 'info' | 'warning' | 'critical';

const SEVERITY_COLORS: Record<AlertSeverity, number> = {
    info: 0x22c55e,     // green
    warning: 0xeab308,  // yellow
    critical: 0xef4444,  // red
};

const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/** Module-level state */
let webhookUrl: string | undefined;
let logger: Logger | undefined;
const cooldowns = new Map<string, number>();

/**
 * Initialize the alert system. Call once at startup.
 * If no webhookUrl is provided, all alerts silently no-op.
 */
export function initAlerts(url: string | undefined, log: Logger): void {
    webhookUrl = url?.trim() || undefined;
    logger = log;
    if (webhookUrl) {
        logger.info('Discord alerts: enabled');
    } else {
        logger.debug('Discord alerts: disabled (no webhook URL)');
    }
}

/**
 * Send a Discord webhook alert.
 *
 * - Silently no-ops if no webhook URL is configured.
 * - Deduplicates by alert key with a 5-minute cooldown.
 * - Never throws — alert failures must not crash Pharos.
 */
export async function sendAlert(
    title: string,
    message: string,
    severity: AlertSeverity,
    key?: string,
): Promise<void> {
    if (!webhookUrl) return;

    // Cooldown check — use key or title as dedup key
    const cooldownKey = key ?? title;
    const lastSent = cooldowns.get(cooldownKey);
    if (lastSent && Date.now() - lastSent < COOLDOWN_MS) return;
    cooldowns.set(cooldownKey, Date.now());

    const payload = {
        embeds: [
            {
                title: `${severity === 'critical' ? '🚨' : severity === 'warning' ? '⚠️' : 'ℹ️'} ${title}`,
                description: message,
                color: SEVERITY_COLORS[severity],
                footer: { text: `Pharos v0.1.0` },
                timestamp: new Date().toISOString(),
            },
        ],
    };

    try {
        const res = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
            logger?.warn({ status: res.status }, 'Discord alert delivery failed');
        }
    } catch (error) {
        logger?.debug(
            { error: error instanceof Error ? error.message : 'unknown' },
            'Discord alert send error (non-fatal)',
        );
    }
}

/**
 * Reset cooldown state. Exposed for testing.
 */
export function resetAlertCooldowns(): void {
    cooldowns.clear();
}
