/**
 * email.ts — Resend transactional email helper (Wave 1 Day 2).
 *
 * Single use case for v1: welcome email with raw API key on first payment.
 * The raw key is shown to the user EXACTLY ONCE — only the SHA-256 hash is
 * stored in the wallet DB. If they lose it, they buy a new one.
 *
 * Degrades gracefully when RESEND_API_KEY is absent: returns ok:false with
 * reason='not_configured'. Caller logs and moves on. Don't 500 the webhook
 * just because the email failed — the top-up already landed in the ledger.
 */
import type { Logger } from './logger.js';

export interface SendResult {
    ok: boolean;
    id?: string;
    reason?: 'not_configured' | 'send_failed';
    error?: string;
}

const DEFAULT_FROM = 'Pharos <onboarding@resend.dev>';

let cachedClient: { send: (args: SendArgs) => Promise<SendResult> } | null = null;

interface SendArgs {
    to: string;
    subject: string;
    html: string;
    text: string;
}

async function getClient(logger: Logger) {
    if (cachedClient) return cachedClient;
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) return null;

    const { Resend } = await import('resend');
    const resend = new Resend(apiKey);
    const from = process.env.PHAROS_FROM_EMAIL || DEFAULT_FROM;

    cachedClient = {
        send: async ({ to, subject, html, text }: SendArgs): Promise<SendResult> => {
            try {
                const { data, error } = await resend.emails.send({
                    from,
                    to: [to],
                    subject,
                    html,
                    text,
                });
                if (error) {
                    logger.error({ err: error, to }, '[email] resend send failed');
                    return { ok: false, reason: 'send_failed', error: error.message };
                }
                return { ok: true, id: data?.id };
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                logger.error({ err: msg, to }, '[email] resend threw');
                return { ok: false, reason: 'send_failed', error: msg };
            }
        },
    };
    return cachedClient;
}

/**
 * Send the first-payment welcome email with the raw API key.
 * The key MUST be the unhashed plaintext — this is the only place the user sees it.
 */
export async function sendWelcomeEmail(opts: {
    to: string;
    apiKey: string;
    creditsUsd: number;
    logger: Logger;
}): Promise<SendResult> {
    const client = await getClient(opts.logger);
    if (!client) return { ok: false, reason: 'not_configured' };

    const credits = `$${opts.creditsUsd.toFixed(2)}`;
    const subject = `Your Pharos API key — ${credits} in credits ready to use`;
    const apiBase = (process.env.PHAROS_API_URL || 'https://pharos-nexlabs.fly.dev').replace(/\/$/, '');
    const walletBase = (process.env.PHAROS_PUBLIC_URL || apiBase).replace(/\/$/, '');

    const html = `<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111;">
  <h1 style="font-size: 22px; margin: 0 0 16px;">Welcome to Pharos</h1>
  <p>Your wallet is loaded with <strong>${credits}</strong> in API credits.</p>
  <p>Here's your API key. <strong>Save it now</strong> — we don't store the plaintext, so this is the only time you'll see it. If you lose it, you'll need to buy a new one.</p>
  <pre style="background: #f4f4f5; padding: 16px; border-radius: 6px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; word-break: break-all; user-select: all;">${opts.apiKey}</pre>
  <h3 style="font-size: 16px; margin: 24px 0 8px;">Quickstart</h3>
  <pre style="background: #f4f4f5; padding: 16px; border-radius: 6px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; overflow-x: auto;">curl ${apiBase}/v1/chat/completions \\
  -H "Authorization: Bearer ${opts.apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"auto","messages":[{"role":"user","content":"hello"}]}'</pre>
  <p style="margin-top: 24px;">Check your balance any time at <a href="${walletBase}/wallet">${walletBase.replace(/^https?:\/\//, '')}/wallet</a>.</p>
  <p style="color: #666; font-size: 12px; margin-top: 32px;">— The Pharos team</p>
</body>
</html>`;

    const text = `Welcome to Pharos

Your wallet is loaded with ${credits} in API credits.

API key (save it — only shown once):
${opts.apiKey}

Quickstart:
curl ${apiBase}/v1/chat/completions \\
  -H "Authorization: Bearer ${opts.apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"auto","messages":[{"role":"user","content":"hello"}]}'

Balance: ${walletBase}/wallet

— The Pharos team`;

    return client.send({ to: opts.to, subject, html, text });
}

/** For tests — reset the lazy client (so RESEND_API_KEY env changes take effect). */
export function _resetEmailClientForTests(): void {
    cachedClient = null;
}
