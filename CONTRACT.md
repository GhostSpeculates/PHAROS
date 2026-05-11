# Pharos SaaS — Cross-Session Contract

**Owners:** two parallel work sessions.

| Session | Repo | Owns |
|---------|------|------|
| **Backend** | `/Users/ghostfx/PHAROS` → `github.com/GhostSpeculates/PHAROS` | Pharos API, wallet routes, Stripe checkout, webhook, welcome email, Fly deploy |
| **Landing** | `/Users/ghostfx/NEX-LABS/Pharos` | `pharos.nexlabs.pro` marketing site, `/buy` form, success/cancel pages, customer dashboard |

Either session may edit this file; the other rebases or pulls. Treat it as a wire spec — change here first, then code.

---

## Domains

| Purpose | URL | Owner |
|---------|-----|-------|
| Pharos API (HTTP + SSE) | `https://pharos-nexlabs.fly.dev` | Backend |
| Marketing + buy flow | `https://pharos.nexlabs.pro` | Landing |
| Stripe webhook target | `https://pharos-nexlabs.fly.dev/webhook/stripe` | Backend |

Landing must allow CORS-less calls to the API. The API allows the landing origin via `PHAROS_CORS_ORIGINS` (set on Fly).

---

## API surface the landing page consumes

### `POST /wallet/checkout` (public)

Initiates Stripe Checkout for a new signup or returning buyer.

**Request**
```json
{ "email": "user@example.com", "amount_usd": 20 }
```

| Field | Type | Required | Rules |
|-------|------|----------|-------|
| `email` | string | yes | valid email, normalized lowercase |
| `amount_usd` | number | yes | integer or float between **5** and **500** |

**Response 200**
```json
{ "url": "https://checkout.stripe.com/...", "session_id": "cs_..." }
```

**Errors**
- `400` — invalid email or amount out of range
- `501` — Stripe not configured (missing `STRIPE_SECRET_KEY`)
- `502` — Stripe API error (network or rejected by Stripe)

**Landing flow:**
1. Collect email + amount on form.
2. `fetch('https://pharos-nexlabs.fly.dev/wallet/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({email, amount_usd}) })`
3. Read `data.url`, `window.location = data.url`.

### `GET /v1/credits` (Bearer auth)

Returns OpenRouter-shape balance. Customer dashboard uses this.

```json
{ "data": { "total_credits": 5.00, "total_usage": 1.23 } }
```

### `GET /wallet/me` (Bearer auth)

Returns full user record. Dashboard detail view.

```json
{
  "id": 1,
  "email": "user@example.com",
  "balance_usd": 3.77,
  "daily_cap_usd": null,
  "monthly_cap_usd": null,
  "role": "user",
  "stripe_linked": false,
  "created_at": "2026-05-10T20:00:00Z"
}
```

---

## Pages the landing page MUST serve

Stripe Checkout redirects after payment. The backend sets these URLs from `PHAROS_PUBLIC_URL` env var, which **must equal** `https://pharos.nexlabs.pro`.

| Path | When | Notes |
|------|------|-------|
| `/wallet/topup/success?session_id=cs_...` | Payment succeeded | Tell user to check email for API key. **Webhook does the credit application — do NOT call any API to confirm.** Just a "thanks, key on the way" page. |
| `/wallet/topup/cancel` | User cancelled checkout | Offer link back to `/buy`. |
| `/buy` | Marketing CTA | Email + amount form. Posts to `/wallet/checkout`. |

Backend does NOT serve these. Backend wallet-routes only owns API + webhook.

---

## Env vars per session

### Backend (`/Users/ghostfx/PHAROS/.env` and Fly secrets)

| Var | Value | Notes |
|-----|-------|-------|
| `STRIPE_SECRET_KEY` | `sk_live_...` | Live mode for production |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` | From Stripe Dashboard → webhook endpoint signing secret |
| `RESEND_API_KEY` | `re_...` | Sends welcome email with raw API key |
| `PHAROS_FROM_EMAIL` | `Pharos <noreply@pharos.nexlabs.pro>` | Defaults to `Pharos <onboarding@resend.dev>` until DNS verified |
| `PHAROS_PUBLIC_URL` | `https://pharos.nexlabs.pro` | Used for Stripe success/cancel + balance link in welcome email |
| `PHAROS_API_URL` | `https://pharos-nexlabs.fly.dev` | Used for `curl` examples in welcome email |
| `PHAROS_CORS_ORIGINS` | `https://pharos.nexlabs.pro` | Allow landing to call API from browser |
| `SENTRY_DSN` | `https://...@o....ingest.us.sentry.io/...` | Runtime error capture. Empty = Sentry no-op. |
| `SENTRY_ENVIRONMENT` | `production` | Defaults to `NODE_ENV` if unset. |
| `SENTRY_RELEASE` | `pharos@0.1.0+sha` | Optional. Match what `npm run sourcemaps:upload` tags. |

**Source-map upload (one-time setup + per-deploy):**

```bash
# One-time setup on your local machine
curl https://cli.sentry.dev/install -fsS | bash
sentry-cli login   # opens browser

# Export the auth token (or store in .env, NOT committed)
export SENTRY_AUTH_TOKEN=...
export SENTRY_ORG=nex-labs
export SENTRY_PROJECT=pharos

# Every deploy
npm run deploy   # = npm run build && sourcemaps:upload && fly deploy
```

`tsc` output is deterministic, so locally-built source maps match what Fly's builder produces.

### Landing (`/Users/ghostfx/NEX-LABS/Pharos/.env`)

| Var | Value | Notes |
|-----|-------|-------|
| `NEXT_PUBLIC_PHAROS_API_URL` | `https://pharos-nexlabs.fly.dev` | Form posts here |

(Use whatever framework convention applies — Next.js, Astro, etc.)

---

## Stripe Dashboard manual config (one-time)

1. Stripe → Developers → Webhooks → **Add endpoint**
2. URL: `https://pharos-nexlabs.fly.dev/webhook/stripe`
3. Events: `checkout.session.completed`
4. Copy the **signing secret** (`whsec_...`) → paste to `STRIPE_WEBHOOK_SECRET` on Fly.

If switching from test → live mode later, repeat in live-mode dashboard and update the Fly secret.

---

## Resend Dashboard manual config (recommended, not blocking)

Until DNS verified, welcome emails ship from `onboarding@resend.dev`. To send from `@pharos.nexlabs.pro`:

1. Resend → Domains → Add `pharos.nexlabs.pro`
2. Copy DNS records, add to nexlabs.pro DNS provider.
3. Once verified, set `PHAROS_FROM_EMAIL=Pharos <noreply@pharos.nexlabs.pro>` on Fly.

---

## Conflict-avoidance rules

- **Never** add `/buy`, `/wallet/topup/success`, `/wallet/topup/cancel` HTML routes to the backend. Those are landing pages.
- **Never** add API endpoints to the landing project. Landing calls Pharos API over HTTPS.
- **Always** update this file when the wire shape changes (request body, response keys, status codes, env vars).
- Commits that touch wallet-routes.ts, email.ts, or this file should mention `[contract]` in the subject so the other session knows to re-read.

---

## Verifiable end state for SaaS v1 launch

1. `curl https://pharos-nexlabs.fly.dev/health` → 200
2. `curl -X POST https://pharos-nexlabs.fly.dev/wallet/checkout -H 'content-type: application/json' -d '{"email":"test@example.com","amount_usd":5}'` → 200 with `url` field
3. Open `pharos.nexlabs.pro/buy`, pay $5 with real card.
4. Welcome email arrives at the address used. Contains a raw `pharos-...` API key.
5. `curl https://pharos-nexlabs.fly.dev/v1/credits -H "Authorization: Bearer <that-key>"` → `{"data":{"total_credits":5.00,"total_usage":0}}`
6. `curl https://pharos-nexlabs.fly.dev/v1/chat/completions -H "Authorization: Bearer <that-key>" -H 'content-type: application/json' -d '{"model":"auto","messages":[{"role":"user","content":"hello"}]}'` → 200 with completion

When all 6 are green, repo flips public + Wave 5 ships.
