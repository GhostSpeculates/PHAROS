# Noir (OpenClaw) + Pharos Integration Guide

This document covers how to connect **Noir** -- an AI Discord bot running OpenClaw on a Hostinger VPS -- to **Pharos**, the intelligent LLM routing gateway. Both services run on the same machine, making integration straightforward with zero network latency between them.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [OpenClaw Configuration Changes](#2-openclaw-configuration-changes)
3. [Per-Agent Recommendations](#3-per-agent-recommendations)
4. [Step-by-Step Setup](#4-step-by-step-setup)
5. [Pharos API Authentication](#5-pharos-api-authentication)
6. [Rollback Plan](#6-rollback-plan)
7. [Cost Projections](#7-cost-projections)
8. [Monitoring and Observability](#8-monitoring-and-observability)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. Architecture Overview

### Before Pharos

```
Noir Agent  -->  OpenClaw  -->  Anthropic API (claude-sonnet / claude-haiku)
                            -->  Google API (gemini-2.0-flash)

Every request goes directly to the provider at full price.
```

### After Pharos

```
Noir Agent  -->  OpenClaw  -->  Pharos (localhost:3777)  -->  Classifier  -->  Optimal Provider
                                        |
                        +---------------+---------------+---------------+
                        |               |               |               |
                    Free Tier      Economical       Premium         Frontier
                  (Gemini Flash,   (DeepSeek,     (Sonnet 4,      (Opus 4,
                   Groq Llama)     Mistral)        GPT-4o)          o3)
```

### How It Works

1. **Noir agent** sends a message through OpenClaw as usual.
2. **OpenClaw** routes the request to Pharos at `http://localhost:3777/v1/chat/completions` (OpenAI-compatible API).
3. **Pharos classifier** (runs on Groq Llama 3.3 70B, essentially free) scores the query complexity from 1 to 10.
4. **Pharos router** selects the cheapest model that can handle the query well:
   - Score 1-3 (greetings, simple questions) --> Free tier (Gemini Flash, Groq)
   - Score 4-6 (analysis, moderate tasks) --> Economical tier (DeepSeek, Mistral)
   - Score 7-8 (complex reasoning, code) --> Premium tier (Claude Sonnet, GPT-4o)
   - Score 9-10 (PhD-level, frontier needs) --> Frontier tier (Claude Opus, o3)
5. **Response** flows back through Pharos to OpenClaw to the Discord user.

### Key Properties

- **Same VPS**: Both Noir and Pharos run on `<vps-redacted>`. Communication is over `localhost` -- zero network latency, no external exposure needed.
- **Drop-in replacement**: Pharos speaks the OpenAI API format. OpenClaw already supports OpenAI-compatible providers.
- **Non-invasive**: Pharos runs independently. Stopping Pharos does not affect Noir if you revert the OpenClaw config.
- **Transparent**: Pharos adds `X-Pharos-Tier`, `X-Pharos-Model`, `X-Pharos-Score`, and `X-Pharos-Cost` headers to every response so you can see exactly what happened.

---

## 2. OpenClaw Configuration Changes

OpenClaw config is located at `/root/.openclaw/openclaw.json`. It uses provider prefixes like `anthropic/model-id` to determine routing.

There are two approaches for connecting to Pharos.

### Option A: Add Pharos as an OpenAI-Compatible Provider (Recommended)

This is the cleanest approach. You add Pharos as a new provider in OpenClaw and point agents at it. Agents that genuinely need a specific model can still bypass Pharos and go directly to a provider.

**Step 1: Add the Pharos provider profile to `openclaw.json`:**

```json
{
  "providers": {
    "openai": {
      "apiKey": "your-pharos-api-key-here",
      "baseUrl": "http://localhost:3777/v1"
    }
  }
}
```

> **Note:** The `apiKey` here is your `PHAROS_API_KEY` from Pharos's `.env` file, NOT an OpenAI key. Pharos uses this for authentication. If you have not set a `PHAROS_API_KEY` in Pharos's `.env`, authentication is skipped (open mode), and you can use any placeholder string.

If OpenClaw already has an `openai` provider entry for actual OpenAI models, you may need to use a different provider name. Check if OpenClaw supports custom provider aliases. If so:

```json
{
  "providers": {
    "pharos": {
      "type": "openai",
      "apiKey": "your-pharos-api-key-here",
      "baseUrl": "http://localhost:3777/v1"
    }
  }
}
```

**Step 2: Update agent model references:**

Change agent models from their current value to `openai/pharos-auto` (or `pharos/auto` if using a custom alias).

When Pharos receives `pharos-auto` or `auto` as the model name, it triggers intelligent classification and routing. The request gets scored and sent to the optimal model automatically.

### Option B: Override Provider Base URLs

If OpenClaw supports custom `baseUrl` overrides per provider, you could redirect the Anthropic provider endpoint to Pharos:

```json
{
  "providers": {
    "anthropic": {
      "apiKey": "your-pharos-api-key-here",
      "baseUrl": "http://localhost:3777/v1"
    }
  }
}
```

This approach is **not recommended** because:
- It hijacks ALL Anthropic traffic, even for agents that should go direct.
- The model name `claude-sonnet-4-5-20250929` will be treated as a direct route in Pharos (bypassing the classifier), unless you also change the model names to `auto`.
- It conflates two different concerns (provider identity vs. routing target).

### Recommendation

**Use Option A.** It gives you the best of both worlds:
- Agents that benefit from intelligent routing use `openai/pharos-auto`.
- Agents that NEED a specific model (e.g., `noir-prime` needing guaranteed Claude Sonnet quality) can keep using `anthropic/claude-sonnet-4-5-20250929` directly.
- You can migrate agents one at a time and compare results.

---

## 3. Per-Agent Recommendations

Noir has 7 agents. Here is the recommended Pharos configuration for each:

| Agent | Role | Current Model | Recommended | Rationale |
|-------|------|---------------|-------------|-----------|
| **noir-prime** | Executive / main persona | `anthropic/claude-sonnet-4-5-20250929` | Keep direct **OR** `openai/pharos-auto` | Executive agent needs reliable, high-quality responses. Start by keeping it direct. Once you trust Pharos routing, switch to `pharos-auto` -- it will still route complex exec tasks to Sonnet/Opus. |
| **main** | Misc channel chat | `anthropic/claude-haiku-4-5-20251001` | `openai/pharos-auto` | General Discord chat is mostly simple conversation (score 1-4). Pharos will route to free/cheap models for casual messages and escalate only when needed. Big savings. |
| **trading** | Market analysis | `anthropic/claude-haiku-4-5-20251001` | `openai/pharos-auto` | Trading queries vary widely -- "what's BTC price?" is trivial, but "analyze this chart pattern and suggest entries" is complex. Pharos handles this perfectly by scoring each query individually. |
| **smarthome** (Nex Labs) | Business operations | `anthropic/claude-haiku-4-5-20251001` | `openai/pharos-auto` | Business tasks range from simple status checks to complex planning. Pharos routes each appropriately. |
| **research** | Web search, news | `anthropic/claude-haiku-4-5-20251001` | `openai/pharos-auto` | Most research queries are factual lookups (score 2-4). Pharos will use free models for these. Complex research synthesis gets upgraded automatically. |
| **finance** | Calculations, tracking | `anthropic/claude-haiku-4-5-20251001` | `openai/pharos-auto` | Financial calculations are moderate complexity (score 3-6). Pharos uses economical models for these, saving significantly vs. Haiku while maintaining accuracy. |
| **worker** | Background tasks | `google/gemini-2.0-flash` | `openai/pharos-auto` | Already on a free-tier model. Pharos will keep routing simple worker tasks to free models (Gemini Flash, Groq). No cost increase, but gains failover protection. |

### Migration Strategy

Do not switch all agents at once. Migrate in phases:

1. **Phase 1 (Low risk):** Switch `worker`, `main`, and `research` to `pharos-auto`. These handle the simplest traffic and benefit most from cost savings.
2. **Phase 2 (Medium risk):** Switch `trading`, `smarthome`, and `finance` to `pharos-auto`. Monitor response quality for a day.
3. **Phase 3 (Optional):** Switch `noir-prime` to `pharos-auto` once you are confident in Pharos routing accuracy. Alternatively, keep `noir-prime` on direct Anthropic permanently -- it is one agent, so the cost impact is small.

---

## 4. Step-by-Step Setup

### Prerequisites

- SSH access to the VPS (`<vps-redacted>`)
- Node.js >= 20 installed on the VPS
- Pharos source code deployed to the VPS

### Step 1: Deploy Pharos to the VPS

Clone or copy the Pharos project to the VPS:

```bash
# On the VPS
cd /root
git clone <pharos-repo-url> pharos
cd pharos
npm install
npm run build
```

### Step 2: Configure Pharos Environment

Create the `.env` file:

```bash
cp .env.example .env
nano .env
```

Fill in your provider API keys:

```env
# Server
PHAROS_PORT=3777
PHAROS_API_KEY=noir-pharos-secret-key-change-this

# Required: powers the classifier
GROQ_API_KEY=your-groq-key

# Provider keys (add all you want available for routing)
GOOGLE_AI_API_KEY=your-google-key
ANTHROPIC_API_KEY=your-anthropic-key
DEEPSEEK_API_KEY=your-deepseek-key
MISTRAL_API_KEY=your-mistral-key
```

> **Important:** The `ANTHROPIC_API_KEY` here is the same key Noir currently uses. Pharos needs it to make requests to Anthropic on behalf of Noir.

### Step 3: Verify Pharos is Running

Start Pharos and confirm it responds:

```bash
cd /root/pharos
npm start
```

In a separate terminal:

```bash
curl http://localhost:3777/health
```

Expected response:

```json
{
  "status": "ok",
  "service": "pharos",
  "version": "0.1.0",
  "providers": {
    "anthropic": { "available": true, "healthy": true },
    "google": { "available": true, "healthy": true },
    "groq": { "available": true, "healthy": true },
    "deepseek": { "available": true, "healthy": true }
  }
}
```

### Step 4: Set Up Pharos as a Systemd Service

Create a systemd unit so Pharos starts on boot and restarts on failure:

```bash
sudo nano /etc/systemd/system/pharos.service
```

```ini
[Unit]
Description=Pharos LLM Routing Gateway
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/pharos
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable pharos
sudo systemctl start pharos
sudo systemctl status pharos
```

### Step 5: Backup OpenClaw Config

Before making any changes:

```bash
cp /root/.openclaw/openclaw.json /root/.openclaw/openclaw.json.backup.$(date +%Y%m%d)
```

### Step 6: Update OpenClaw Config

Edit `/root/.openclaw/openclaw.json`:

```bash
nano /root/.openclaw/openclaw.json
```

Add the Pharos provider (adjust the structure to match OpenClaw's actual config format):

```json
{
  "providers": {
    "openai": {
      "apiKey": "noir-pharos-secret-key-change-this",
      "baseUrl": "http://localhost:3777/v1"
    }
  }
}
```

Update agent model references. For each agent you want to route through Pharos, change the model from its current value:

```
BEFORE: "model": "anthropic/claude-haiku-4-5-20251001"
AFTER:  "model": "openai/pharos-auto"
```

Example for a phased rollout (Phase 1 -- low-risk agents only):

```json
{
  "agents": {
    "noir-prime": { "model": "anthropic/claude-sonnet-4-5-20250929" },
    "main":      { "model": "openai/pharos-auto" },
    "trading":   { "model": "anthropic/claude-haiku-4-5-20251001" },
    "smarthome": { "model": "anthropic/claude-haiku-4-5-20251001" },
    "research":  { "model": "openai/pharos-auto" },
    "finance":   { "model": "anthropic/claude-haiku-4-5-20251001" },
    "worker":    { "model": "openai/pharos-auto" }
  }
}
```

### Step 7: Restart OpenClaw

```bash
systemctl restart openclaw
```

### Step 8: Verify Traffic is Flowing

Check Pharos logs:

```bash
journalctl -u pharos -f
```

You should see log entries like:

```
INFO: Request received { requestId: "req_...", model: "pharos-auto", messageCount: 3 }
INFO: -> Routed { tier: "free", provider: "google", model: "gemini-2.0-flash", score: 2 }
INFO: Completed { cost: "$0.000000", latencyMs: 1200 }
```

Check the Pharos dashboard by visiting `http://localhost:3777` in a browser (or via SSH tunnel). It shows live provider status, request counts, costs, and savings percentages.

### Step 9: Test with a Direct Curl

Send a test request to Pharos to verify it works end-to-end:

```bash
curl -X POST http://localhost:3777/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer noir-pharos-secret-key-change-this" \
  -d '{
    "model": "pharos-auto",
    "messages": [
      {"role": "user", "content": "Hello, how are you?"}
    ]
  }'
```

This should return a response routed to a free-tier model (score ~1-2). Check the response headers for `X-Pharos-Tier: free`.

---

## 5. Pharos API Authentication

Pharos uses Bearer token authentication identical to the OpenAI API format.

| Parameter | Value |
|-----------|-------|
| **Base URL** | `http://localhost:3777/v1` |
| **API Key** | The `PHAROS_API_KEY` value from Pharos's `.env` file |
| **Auth Header** | `Authorization: Bearer <PHAROS_API_KEY>` |
| **Model (auto)** | `pharos-auto` or `auto` -- triggers intelligent classification and routing |
| **Model (direct)** | Any model name from the Pharos config (e.g., `claude-sonnet-4-20250514`) -- bypasses classifier, routes directly |

### Authentication Behavior

- If `PHAROS_API_KEY` is set in `.env`, all requests to `/v1/chat/completions`, `/v1/models`, and `/v1/stats` require a valid Bearer token.
- If `PHAROS_API_KEY` is **not set** (empty), authentication is skipped entirely (open mode). This is fine for localhost-only deployments where only OpenClaw connects to Pharos.
- The `/health` endpoint is always unauthenticated.

### Model Name Behavior

When Pharos receives a request, the `model` field determines routing:

| Model Value | Behavior |
|-------------|----------|
| `pharos-auto` | Classify the query, route to optimal tier and model |
| `auto` | Same as `pharos-auto` |
| `claude-sonnet-4-20250514` | Direct route to Anthropic Claude Sonnet (bypasses classifier for routing) |
| `gemini-2.0-flash` | Direct route to Google Gemini Flash |
| Any unknown model name | Falls back to classifier-based routing |

---

## 6. Rollback Plan

If something goes wrong after switching to Pharos, recovery is immediate.

### Quick Rollback (< 2 minutes)

```bash
# 1. Restore the OpenClaw config backup
cp /root/.openclaw/openclaw.json.backup.YYYYMMDD /root/.openclaw/openclaw.json

# 2. Restart OpenClaw
systemctl restart openclaw

# 3. Verify Noir is working
#    (check Discord, send a test message)
```

That is it. Noir goes back to direct provider routing instantly.

### Stopping Pharos Independently

Pharos can be stopped without any impact on Noir, as long as OpenClaw is not configured to route through it:

```bash
systemctl stop pharos
```

If OpenClaw IS configured to use Pharos and Pharos goes down, OpenClaw requests to the `openai` provider will fail. This is why the rollback plan above restores the config first.

### Partial Rollback

If only one agent is having issues through Pharos, change just that agent back to direct routing:

```
"trading": { "model": "anthropic/claude-haiku-4-5-20251001" }
```

Then restart OpenClaw. Other agents continue using Pharos.

---

## 7. Cost Projections

### Current Spend (Direct Provider Routing)

| Agent | Model | Estimated Daily Cost | Monthly |
|-------|-------|---------------------|---------|
| noir-prime | Claude Sonnet 4.5 | ~$3.00 | ~$90 |
| main | Claude Haiku 4.5 | ~$1.50 | ~$45 |
| trading | Claude Haiku 4.5 | ~$1.00 | ~$30 |
| smarthome | Claude Haiku 4.5 | ~$1.00 | ~$30 |
| research | Claude Haiku 4.5 | ~$1.00 | ~$30 |
| finance | Claude Haiku 4.5 | ~$1.00 | ~$30 |
| worker | Gemini 2.0 Flash | ~$0.50 | ~$15 |
| **Total** | | **~$9.00/day** | **~$270/month** |

### Expected Spend (With Pharos)

Based on Pharos's classification distribution (approximately 70% free, 25% economical, 5% premium/frontier):

| Tier | % of Traffic | Avg Cost per Request | Contribution |
|------|-------------|---------------------|--------------|
| Free (Gemini Flash, Groq) | ~70% | ~$0.0000 | ~$0.00/day |
| Economical (DeepSeek, Mistral) | ~20% | ~$0.0002 | ~$0.20/day |
| Premium (Sonnet, GPT-4o) | ~8% | ~$0.003 | ~$0.50/day |
| Frontier (Opus, o3) | ~2% | ~$0.02 | ~$0.30/day |
| **Total** | | | **~$0.50-1.50/day** |

### Savings Summary

| Metric | Before Pharos | After Pharos | Savings |
|--------|---------------|--------------|---------|
| **Daily cost** | ~$9.00 | ~$0.50-1.50 | $7.50-8.50/day |
| **Monthly cost** | ~$270 | ~$15-45 | $225-255/month |
| **Annual cost** | ~$3,240 | ~$180-540 | $2,700-3,060/year |
| **Savings %** | -- | -- | **83-95%** |

### Where the Savings Come From

- **Casual Discord messages** (greetings, short questions, banter): Currently hitting Haiku ($1/M input, $5/M output). Pharos routes these to Gemini Flash or Groq (free). This alone covers ~60% of traffic.
- **Factual lookups and simple tasks**: Currently Haiku. Pharos routes to DeepSeek ($0.14/M input) -- 7x cheaper than Haiku.
- **Complex tasks still get premium models**: The 5-10% of genuinely complex queries still go to Sonnet or Opus. Quality does not degrade where it matters.
- **Worker agent**: Already on Gemini Flash. Pharos keeps it there but adds failover to Groq if Google is down.

---

## 8. Monitoring and Observability

### Pharos Dashboard

Visit `http://localhost:3777` in a browser (use an SSH tunnel if needed):

```bash
# From your local machine
ssh -L 3777:localhost:3777 root@<vps-redacted>
# Then open http://localhost:3777 in your browser
```

The dashboard shows:
- Provider health status (green/gray indicators)
- Total requests, total cost, savings percentage
- Breakdown by tier (free, economical, premium, frontier)

### Stats API

```bash
curl -H "Authorization: Bearer <your-pharos-key>" http://localhost:3777/v1/stats
```

Returns JSON with detailed cost tracking, tier breakdowns, and savings calculations.

### Response Headers

Every response from Pharos includes metadata headers:

| Header | Description | Example |
|--------|-------------|---------|
| `X-Pharos-Tier` | Which tier handled the request | `free` |
| `X-Pharos-Model` | Which model was used | `gemini-2.0-flash` |
| `X-Pharos-Provider` | Which provider was used | `google` |
| `X-Pharos-Score` | Complexity score (1-10) | `3` |
| `X-Pharos-Cost` | Estimated cost in USD | `0.000000` |
| `X-Pharos-Request-Id` | Unique request ID for tracing | `req_abc123` |

### Logs

```bash
# Live Pharos logs
journalctl -u pharos -f

# Last 100 lines
journalctl -u pharos -n 100

# OpenClaw logs (to verify it's connecting)
journalctl -u openclaw -f
```

---

## 9. Troubleshooting

### Pharos is not starting

```bash
# Check status
systemctl status pharos

# Check for port conflicts
ss -tlnp | grep 3777

# Verify Node.js version
node --version  # Must be >= 20
```

### OpenClaw cannot connect to Pharos

```bash
# Test Pharos is responding
curl http://localhost:3777/health

# Test with auth
curl -H "Authorization: Bearer <key>" http://localhost:3777/v1/models

# Check if the API key matches between OpenClaw config and Pharos .env
```

### Responses are slow

Check which model Pharos is selecting. If the classifier is routing too aggressively to premium/frontier tiers, the issue is classification accuracy. Look at the `X-Pharos-Score` headers in the logs:

```bash
journalctl -u pharos | grep "Routed" | tail -20
```

If scores seem too high, consider tuning the classifier or adjusting tier score ranges in `config/pharos.default.yaml`.

### Quality seems lower for certain queries

If a specific agent is getting worse responses through Pharos:
1. Check which tier/model is being selected for that agent's typical queries.
2. Consider switching that agent back to direct routing temporarily.
3. Alternatively, adjust the tier boundaries in the Pharos config to be more conservative (e.g., change the economical range from `[4, 6]` to `[5, 7]` so more queries go to premium).

### Provider is showing as unhealthy

```bash
curl http://localhost:3777/health
```

If a provider shows `"healthy": false`, it means Pharos detected errors or timeouts from that provider. Pharos will automatically skip unhealthy providers and failover to the next available model in the tier. The provider will be retried after the `healthCooldownMs` period (default: 60 seconds).

### Pharos is using too much memory

Pharos is lightweight (typically under 100MB RSS). If memory is a concern on the VPS:
- Ensure the SQLite tracking database (`data/pharos.db`) is not growing unbounded. Pharos stores request logs there.
- Restart Pharos periodically: `systemctl restart pharos`

---

## Quick Reference

```
VPS IP:              <vps-redacted>
Pharos URL:          http://localhost:3777
Pharos API:          http://localhost:3777/v1/chat/completions
Pharos Health:       http://localhost:3777/health
Pharos Dashboard:    http://localhost:3777
Pharos Stats:        http://localhost:3777/v1/stats
OpenClaw Config:     /root/.openclaw/openclaw.json
Pharos Config:       /root/pharos/config/pharos.default.yaml
Pharos Env:          /root/pharos/.env
Pharos Logs:         journalctl -u pharos -f
OpenClaw Restart:    systemctl restart openclaw
Pharos Restart:      systemctl restart pharos
```
