import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initAlerts, sendAlert, resetAlertCooldowns } from '../utils/alerts.js';

// ─── Mock Logger ──────────────────────────────────────────

function mockLogger() {
    return {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        trace: vi.fn(),
        child: vi.fn().mockReturnThis(),
    } as any;
}

// ─── Mock global fetch ────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);
    resetAlertCooldowns();
    // Reset to no webhook/topic so tests are isolated
    initAlerts(undefined, mockLogger());
});

afterEach(() => {
    vi.restoreAllMocks();
});

// ─── Tests ────────────────────────────────────────────────

describe('alerts', () => {
    describe('initAlerts', () => {
        it('enables alerts when webhook URL is provided', () => {
            const logger = mockLogger();
            initAlerts('https://discord.com/api/webhooks/test', logger);
            expect(logger.info).toHaveBeenCalledWith('Discord alerts: enabled');
        });

        it('disables alerts when no webhook URL', () => {
            const logger = mockLogger();
            initAlerts(undefined, logger);
            expect(logger.debug).toHaveBeenCalledWith('Discord alerts: disabled (no webhook URL)');
        });

        it('disables alerts for empty string', () => {
            const logger = mockLogger();
            initAlerts('  ', logger);
            expect(logger.debug).toHaveBeenCalledWith('Discord alerts: disabled (no webhook URL)');
        });

        it('enables ntfy when topic is provided', () => {
            const logger = mockLogger();
            initAlerts(undefined, logger, 'test-topic');
            expect(logger.info).toHaveBeenCalledWith('ntfy.sh push notifications: enabled');
        });

        it('disables ntfy when no topic', () => {
            const logger = mockLogger();
            initAlerts(undefined, logger);
            expect(logger.debug).toHaveBeenCalledWith(
                'ntfy.sh push notifications: disabled (no topic)',
            );
        });

        it('disables ntfy for empty/whitespace topic', () => {
            const logger = mockLogger();
            initAlerts(undefined, logger, '  ');
            expect(logger.debug).toHaveBeenCalledWith(
                'ntfy.sh push notifications: disabled (no topic)',
            );
        });
    });

    describe('sendAlert', () => {
        it('sends a Discord webhook with correct payload', async () => {
            const logger = mockLogger();
            initAlerts('https://discord.com/api/webhooks/test', logger);

            await sendAlert('Test Alert', 'Test message', 'info');

            expect(mockFetch).toHaveBeenCalledOnce();
            const [url, opts] = mockFetch.mock.calls[0];
            expect(url).toBe('https://discord.com/api/webhooks/test');
            expect(opts.method).toBe('POST');
            expect(opts.headers['Content-Type']).toBe('application/json');

            const body = JSON.parse(opts.body);
            expect(body.embeds).toHaveLength(1);
            expect(body.embeds[0].title).toContain('Test Alert');
            expect(body.embeds[0].description).toBe('Test message');
            expect(body.embeds[0].footer.text).toContain('Pharos');
            expect(body.embeds[0].timestamp).toBeDefined();
        });

        it('uses green color for info severity', async () => {
            const logger = mockLogger();
            initAlerts('https://discord.com/api/webhooks/test', logger);

            await sendAlert('Info', 'msg', 'info');
            const body = JSON.parse(mockFetch.mock.calls[0][1].body);
            expect(body.embeds[0].color).toBe(0x22c55e);
        });

        it('uses yellow color for warning severity', async () => {
            const logger = mockLogger();
            initAlerts('https://discord.com/api/webhooks/test', logger);

            await sendAlert('Warn', 'msg', 'warning');
            const body = JSON.parse(mockFetch.mock.calls[0][1].body);
            expect(body.embeds[0].color).toBe(0xeab308);
        });

        it('uses red color for critical severity', async () => {
            const logger = mockLogger();
            initAlerts('https://discord.com/api/webhooks/test', logger);

            await sendAlert('Crit', 'msg', 'critical');
            const body = JSON.parse(mockFetch.mock.calls[0][1].body);
            expect(body.embeds[0].color).toBe(0xef4444);
        });

        it('includes emoji prefix based on severity', async () => {
            const logger = mockLogger();
            initAlerts('https://discord.com/api/webhooks/test', logger);

            await sendAlert('Info', 'msg', 'info');
            const body1 = JSON.parse(mockFetch.mock.calls[0][1].body);
            expect(body1.embeds[0].title).toMatch(/^ℹ️/);

            resetAlertCooldowns();
            await sendAlert('Warn', 'msg', 'warning');
            const body2 = JSON.parse(mockFetch.mock.calls[1][1].body);
            expect(body2.embeds[0].title).toMatch(/^⚠️/);

            resetAlertCooldowns();
            await sendAlert('Crit', 'msg', 'critical');
            const body3 = JSON.parse(mockFetch.mock.calls[2][1].body);
            expect(body3.embeds[0].title).toMatch(/^🚨/);
        });

        it('silently no-ops when neither webhook URL nor ntfy topic configured', async () => {
            const logger = mockLogger();
            initAlerts(undefined, logger);

            await sendAlert('Test', 'msg', 'info');
            expect(mockFetch).not.toHaveBeenCalled();
        });

        it('does not throw on fetch failure', async () => {
            const logger = mockLogger();
            initAlerts('https://discord.com/api/webhooks/test', logger);
            mockFetch.mockRejectedValue(new Error('network error'));

            await expect(sendAlert('Test', 'msg', 'info')).resolves.toBeUndefined();
            expect(logger.debug).toHaveBeenCalled();
        });

        it('logs warning on non-ok response', async () => {
            const logger = mockLogger();
            initAlerts('https://discord.com/api/webhooks/test', logger);
            mockFetch.mockResolvedValue({ ok: false, status: 429 });

            await sendAlert('Test', 'msg', 'info');
            expect(logger.warn).toHaveBeenCalledWith(
                { status: 429 },
                'Discord alert delivery failed',
            );
        });
    });

    describe('cooldown', () => {
        it('deduplicates alerts with the same key within 5 minutes', async () => {
            const logger = mockLogger();
            initAlerts('https://discord.com/api/webhooks/test', logger);

            await sendAlert('Alert', 'msg', 'info', 'same_key');
            await sendAlert('Alert', 'msg', 'info', 'same_key');
            await sendAlert('Alert', 'msg', 'info', 'same_key');

            expect(mockFetch).toHaveBeenCalledOnce();
        });

        it('allows different keys to send independently', async () => {
            const logger = mockLogger();
            initAlerts('https://discord.com/api/webhooks/test', logger);

            await sendAlert('Alert A', 'msg', 'info', 'key_a');
            await sendAlert('Alert B', 'msg', 'info', 'key_b');

            expect(mockFetch).toHaveBeenCalledTimes(2);
        });

        it('uses title as default key when no key provided', async () => {
            const logger = mockLogger();
            initAlerts('https://discord.com/api/webhooks/test', logger);

            await sendAlert('Same Title', 'msg1', 'info');
            await sendAlert('Same Title', 'msg2', 'info');
            await sendAlert('Different Title', 'msg3', 'info');

            expect(mockFetch).toHaveBeenCalledTimes(2);
        });

        it('resets cooldowns with resetAlertCooldowns', async () => {
            const logger = mockLogger();
            initAlerts('https://discord.com/api/webhooks/test', logger);

            await sendAlert('Alert', 'msg', 'info', 'key');
            expect(mockFetch).toHaveBeenCalledOnce();

            resetAlertCooldowns();

            await sendAlert('Alert', 'msg', 'info', 'key');
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });
    });

    describe('ntfy.sh push notifications', () => {
        it('sends ntfy notification on critical severity when topic configured', async () => {
            const logger = mockLogger();
            initAlerts(undefined, logger, 'test-topic');

            await sendAlert('Down', 'All providers failed', 'critical');

            expect(mockFetch).toHaveBeenCalledOnce();
            const [url, opts] = mockFetch.mock.calls[0];
            expect(url).toBe('https://ntfy.sh/test-topic');
            expect(opts.method).toBe('POST');
            expect(opts.headers.Title).toBe('Down');
            expect(opts.headers.Priority).toBe('5');
            expect(opts.headers.Tags).toBe('rotating_light');
            expect(opts.body).toBe('All providers failed');
        });

        it('does NOT send ntfy on info severity', async () => {
            const logger = mockLogger();
            initAlerts(undefined, logger, 'test-topic');

            await sendAlert('Info', 'msg', 'info');
            expect(mockFetch).not.toHaveBeenCalled();
        });

        it('does NOT send ntfy on warning severity', async () => {
            const logger = mockLogger();
            initAlerts(undefined, logger, 'test-topic');

            await sendAlert('Warn', 'msg', 'warning');
            expect(mockFetch).not.toHaveBeenCalled();
        });

        it('sends both Discord and ntfy on critical', async () => {
            const logger = mockLogger();
            initAlerts('https://discord.com/api/webhooks/test', logger, 'test-topic');

            await sendAlert('Down', 'msg', 'critical');

            expect(mockFetch).toHaveBeenCalledTimes(2);
            // First call is Discord
            expect(mockFetch.mock.calls[0][0]).toBe('https://discord.com/api/webhooks/test');
            // Second call is ntfy
            expect(mockFetch.mock.calls[1][0]).toBe('https://ntfy.sh/test-topic');
        });

        it('respects cooldown for ntfy', async () => {
            const logger = mockLogger();
            initAlerts(undefined, logger, 'test-topic');

            await sendAlert('Down', 'msg', 'critical', 'same-key');
            await sendAlert('Down', 'msg', 'critical', 'same-key');

            expect(mockFetch).toHaveBeenCalledOnce();
        });

        it('strips markdown from ntfy message body', async () => {
            const logger = mockLogger();
            initAlerts(undefined, logger, 'test-topic');

            await sendAlert('Down', '**bold** text with *italic*', 'critical');

            expect(mockFetch).toHaveBeenCalledOnce();
            const [, opts] = mockFetch.mock.calls[0];
            expect(opts.body).toBe('bold text with italic');
        });

        it('does not throw on ntfy fetch failure', async () => {
            const logger = mockLogger();
            initAlerts(undefined, logger, 'test-topic');
            mockFetch.mockRejectedValue(new Error('network error'));

            await expect(sendAlert('Down', 'msg', 'critical')).resolves.toBeUndefined();
            expect(logger.debug).toHaveBeenCalled();
        });

        it('logs warning on ntfy non-ok response', async () => {
            const logger = mockLogger();
            initAlerts(undefined, logger, 'test-topic');
            mockFetch.mockResolvedValue({ ok: false, status: 500 });

            await sendAlert('Down', 'msg', 'critical');
            expect(logger.warn).toHaveBeenCalledWith(
                { status: 500 },
                'ntfy.sh alert delivery failed',
            );
        });
    });
});
