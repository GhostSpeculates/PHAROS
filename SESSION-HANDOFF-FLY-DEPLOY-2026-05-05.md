# Pharos → Fly.io Production Deploy

**Created:** 2026-05-05
**Goal:** Get Pharos running on Fly.io as the always-on production gateway, so nexlabs.pro Site Concierge can hit it without depending on Ghost's Mac Mini.
**Verifiable end state:** `curl https://pharos.fly.dev/health` returns HTTP 200, AND `curl -H "Authorization: Bearer <PHAROS_API_KEY>" https://pharos.fly.dev/v1/models` returns the model list JSON.

---

## Why this deploy

- MASTER-PLAN.md rule #6: *"Mac Mini = dev only. Fly.io = production."*
- Phase 1 hosting model: cloud-first because Comcast residential has no SLA.
- nexlabs.pro Site Concierge (in active build at `/Users/ghostfx/NEX-LABS/projects/nex-labs-next`) needs a public, always-on Pharos endpoint. Mac Mini doesn't qualify.

---

## Pre-reqs (Ghost / human, can't be automated)

1. **Fly.io account** — sign up at https://fly.io. Free tier exists; production app on `shared-cpu-1x` 256MB ≈ $1.94/mo + outbound bandwidth (effectively ~$5/mo realistic).
2. **Payment method on file** at https://fly.io/dashboard/personal/billing
3. **Provider API keys ready to paste:**
   - `GROQ_API_KEY` — REQUIRED (powers primary classifier + free tier routing)
   - `ANTHROPIC_API_KEY` — required (Site Concierge will route Claude through this)
   - `OPENAI_API_KEY` — optional but recommended
   - `GOOGLE_AI_API_KEY` — optional (free tier Gemini)
4. **Strong `PHAROS_API_KEY`** — generate one with: `openssl rand -hex 32` (this is the bearer token clients send to authenticate against Pharos itself; will be set in nexlabs.pro env too)

---

## Step 1 — Install flyctl

```bash
brew install flyctl
# OR
curl -L https://fly.io/install.sh | sh
```

Verify: `flyctl version`

## Step 2 — Auth

```bash
fly auth login
# Browser opens, log in, return to terminal
fly auth whoami    # confirms signed in
```

## Step 3 — Verify directory + Dockerfile

```bash
cd /Users/ghostfx/PHAROS
ls Dockerfile     # must exist (it does)
```

## Step 4 — Bind to all interfaces in production

The current `.env.example` defaults to `PHAROS_HOST=127.0.0.1` (localhost-only). Fly.io needs the service bound to `0.0.0.0` so traffic from outside the VM can reach it. Set this as a Fly env var (Step 6), NOT in the Dockerfile.

If `src/server.ts` doesn't already read `PHAROS_HOST`, verify it does:

```bash
grep -n "PHAROS_HOST" src/server.ts src/config/schema.ts
```

Should bind to `process.env.PHAROS_HOST || '127.0.0.1'`. If it doesn't, fix that before deploy.

## Step 5 — `fly launch --no-deploy`

```bash
cd /Users/ghostfx/PHAROS
fly launch --no-deploy --name pharos --region iad --copy-config=false
```

Flags:
- `--no-deploy` → create app + `fly.toml` only, don't ship yet (we still need to set secrets first)
- `--name pharos` → app URL becomes `pharos.fly.dev` (if taken, pick `pharos-nexlabs` or similar)
- `--region iad` → Northern Virginia, lowest latency to most US East users; change if Ghost wants West-coast
- `--copy-config=false` → don't pull anything from github

Fly will:
- Detect Dockerfile
- Generate `fly.toml`
- Provision a VM and IPv4/IPv6

## Step 6 — Edit `fly.toml`

Open the generated `fly.toml`. Make sure the `[env]` and `[http_service]` sections look like:

```toml
app = "pharos"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[env]
  PHAROS_PORT = "3777"
  PHAROS_HOST = "0.0.0.0"
  PHAROS_LOG_LEVEL = "info"
  NODE_ENV = "production"

[http_service]
  internal_port = 3777
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 1   # KEEP 1 RUNNING — required for chat latency

[[http_service.checks]]
  interval = "30s"
  timeout = "5s"
  grace_period = "10s"
  method = "GET"
  path = "/health"

[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"
```

Critical:
- `min_machines_running = 1` — without this, Fly aggressively cold-starts and chat replies eat 5–10s warm-up. Costs ~$2/mo extra but UX-defining.
- `internal_port = 3777` — must match `PHAROS_PORT`.
- `force_https = true` — public HTTPS endpoint.

## Step 7 — Set secrets

Secrets are encrypted at rest, only injected as env vars at runtime. NEVER commit them.

```bash
fly secrets set \
  GROQ_API_KEY="<paste>" \
  ANTHROPIC_API_KEY="<paste>" \
  OPENAI_API_KEY="<paste>" \
  GOOGLE_AI_API_KEY="<paste>" \
  PHAROS_API_KEY="<paste-the-openssl-rand-output>"
```

Verify (without leaking values):
```bash
fly secrets list
```

## Step 8 — Deploy

```bash
fly deploy
```

Watch the logs. Build takes ~2 min. Deploy takes ~30s. First deploy may take longer.

## Step 9 — Verify

```bash
# Health check
curl https://pharos.fly.dev/health

# Models listing (should return JSON of available models)
curl -H "Authorization: Bearer <PHAROS_API_KEY>" https://pharos.fly.dev/v1/models

# Smoke test a chat completion
curl -X POST https://pharos.fly.dev/v1/messages \
  -H "Authorization: Bearer <PHAROS_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-haiku-20241022",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "Say hi in 5 words."}]
  }'
```

Expected: JSON response with a Claude-generated message.

## Step 10 — Hand back

Reply to the main session with:
- ✅ Deploy URL: `https://pharos.fly.dev` (or actual URL if name was taken)
- ✅ The `PHAROS_API_KEY` value (so it can be set in nexlabs.pro Vercel env)
- ✅ Health check output
- ✅ Confirmed model list works

The main session will then:
1. Set `NEXT_PUBLIC_PHAROS_URL` and `PHAROS_API_KEY` in nexlabs.pro Vercel env
2. Swap the Concierge stub backend for the live Pharos URL
3. Test the floating widget end-to-end on a Vercel preview deploy

---

## Known gotchas

- **First deploy may fail** if `npm run build` in Dockerfile errors out for any reason (TS errors, etc). Run `npm run build` locally first to confirm clean build.
- **If `pharos` app name taken**: try `pharos-nexlabs` or `pharos-prod`. Update `app =` line in `fly.toml`.
- **Cold starts**: `min_machines_running = 1` MUST be set or chat UX breaks. Worth the ~$2/mo.
- **PHAROS_API_KEY rotation**: if leaked, run `fly secrets set PHAROS_API_KEY="<new>"` then `fly deploy` (forces machine restart).
- **Logs**: `fly logs -a pharos` for live tailing. Check first if anything looks off.

---

## What to NOT touch

- Mac Mini Pharos at `:3777` keeps running — it's still the dev brain. Don't kill it.
- Don't change the existing `/Users/ghostfx/PHAROS/src/` business logic. This deploy is pure ops, not feature work.
- Don't merge any in-flight Pharos branches without asking Ghost first.
