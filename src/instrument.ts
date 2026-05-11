/**
 * instrument.ts — Sentry initialization.
 *
 * Must be loaded BEFORE all other imports so OpenTelemetry can patch
 * `http`, `fetch`, `better-sqlite3`, etc. Run with --import flag:
 *
 *   dev:  tsx watch --import ./src/instrument.ts src/index.ts
 *   prod: node --import ./dist/instrument.js dist/index.js
 *
 * Sentry is opt-in. No SENTRY_DSN env var = no-op (Sentry SDK ignores
 * empty DSN gracefully).
 */
import * as Sentry from '@sentry/node';

Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'production',
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: process.env.NODE_ENV === 'development' ? 1.0 : 0.1,
    sendDefaultPii: false,
});
