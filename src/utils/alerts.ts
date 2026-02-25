import type { Logger } from './logger.js';

export type AlertSeverity = 'info' | 'warning' | 'critical';

const SEVERITY_COLORS: Record<AlertSeverity, number> = {
    info: 0x22c55e, // green
    warning: 0xeab308, // yellow
    critical: 0xef4444, // red
};

const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/** Module-level state */
let webhookUrl: string | undefined;
let ntfyTopic: string | undefined;
let logger: Logger | undefined;
const cooldowns = new Map<string, number>();

/**
 * Strip markdown bold/italic markers from text.
 * Converts **bold** to bold and *italic* to italic.
 */
function stripMarkdown(text: string): string {
    return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1');
}

/**
 * Initialize the alert system. Call once at startup.
 * If neither webhookUrl nor ntfyTopic is provided, all alerts silently no-op.
 */
export function initAlerts(url: string | undefined, log: Logger, topic?: string): void {
    webhookUrl = url?.trim() || undefined;
    ntfyTopic = topic?.trim() || undefined;
    logger = log;
    if (webhookUrl) {
        logger.info('Discord alerts: enabled');
    } else {
        logger.debug('Discord alerts: disabled (no webhook URL)');
    }
    if (ntfyTopic) {
        logger.info('ntfy.sh push notifications: enabled');
    } else {
        logger.debug('ntfy.sh push notifications: disabled (no topic)');
    }
}

/**
 * Send an alert via Discord webhook and/or ntfy.sh push notification.
 *
 * - Discord: sends for all severities when webhook URL is configured.
 * - ntfy.sh: sends for critical severity only when topic is configured.
 * - Deduplicates by alert key with a 5-minute cooldown.
 * - Never throws — alert failures must not crash Pharos.
 */
export async function sendAlert(
    title: string,
    message: string,
    severity: AlertSeverity,
    key?: string,
): Promise<void> {
    if (!webhookUrl && !ntfyTopic) return;

    // Cooldown check — use key or title as dedup key
    const cooldownKey = key ?? title;
    const lastSent = cooldowns.get(cooldownKey);
    if (lastSent && Date.now() - lastSent < COOLDOWN_MS) return;
    cooldowns.set(cooldownKey, Date.now());

    // ─── Discord webhook (all severities) ───
    if (webhookUrl) {
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

    // ─── ntfy.sh push notification (critical only) ───
    if (ntfyTopic && severity === 'critical') {
        try {
            const res = await fetch(`https://ntfy.sh/${ntfyTopic}`, {
                method: 'POST',
                headers: {
                    Title: title,
                    Priority: '5',
                    Tags: 'rotating_light',
                },
                body: stripMarkdown(message),
                signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) {
                logger?.warn({ status: res.status }, 'ntfy.sh alert delivery failed');
            }
        } catch (error) {
            logger?.debug(
                { error: error instanceof Error ? error.message : 'unknown' },
                'ntfy.sh alert send error (non-fatal)',
            );
        }
    }
}

/**
 * Reset cooldown state. Exposed for testing.
 */
export function resetAlertCooldowns(): void {
    cooldowns.clear();
}
