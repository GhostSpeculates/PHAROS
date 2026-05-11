# CLAUDE.md — Pharos

## Project Overview

Pharos is an intelligent LLM routing gateway. It sits between AI apps (OpenClaw, ElizaOS, Discord bots, any OpenAI-compatible client) and model providers, classifying each query's complexity in real-time and routing it to the cheapest model that can handle it well. Saves 66%+ on LLM costs.

## Architecture

```
HTTP Request → Auth Middleware → Zod Validation → Classifier (failover chain)
  → Router (score→tier→model) → Conversation Tracker (tier floor)
  → Provider Adapter (prompt caching) → Response (OpenAI format)
  → Tracking (SQLite cost log + classifier provider)
```

### Classifier Failover Chain

The classifier tries providers in order before falling back to a static tier score:
1. **Moonshot** / kimi-latest (primary — separates classifier budget from Groq routing budget)
2. **Groq** / llama-3.3-70b-versatile (fast fallback)
3. **xAI** / grok-3-mini-fast (last resort)
4. **Static fallback** → economical tier midpoint score

Classifier input is truncated to prevent provider context limit failures:
- System message: first only, capped at 1000 chars
- User messages: last 3 only, each capped at 1000 chars
- Total cap: 4000 chars

Configured in `config/pharos.default.yaml` under `classifier.providers` array.
Backward-compatible with legacy single `provider`/`model` format.

### Core Modules

| Module | Path | Purpose |
|--------|------|---------|
| Entry | `src/index.ts` | Boot, graceful shutdown |
| Server | `src/server.ts` | Wires all components together |
| Config | `src/config/` | YAML loader + Zod schema validation |
| Classifier | `src/classifier/` | Failover chain scores queries 1-10 + task type |
| Router | `src/router/` | Score→tier mapping, failover chain |
| Providers | `src/providers/` | Anthropic, Google, OpenAI-compat adapters |
| Registry | `src/registry/` | Model metadata catalog (capabilities, pricing, speed) |
| Gateway | `src/gateway/` | Fastify HTTP routes, auth, request/response schemas |
| Tracking | `src/tracking/` | SQLite cost recording, savings calculator |
| Utils | `src/utils/` | Pino logger, ID generators, SSE helpers, context windows |
| CLI | `src/cli/` | `pharos start` and `pharos init` commands |

### Tier Routing (default config)

- **Free** (score 1-3): Groq Llama 3.3, Gemini Flash, Together Llama 3.3, Fireworks Llama 3.3
- **Economical** (score 4-6): Groq Llama 3.3, Kimi Latest, DeepSeek, Together DeepSeek V3, Together Qwen 2.5 72B, Fireworks DeepSeek V3, GPT-4o
- **Premium** (score 7-8): Claude Sonnet, GPT-4o
- **Frontier** (score 9-10): Claude Opus, Claude Sonnet (fallback), GPT-4o

### Providers (10 cloud)

Anthropic, Google, OpenAI, DeepSeek, Groq, Mistral, xAI, Moonshot, Together AI, Fireworks AI

All use the OpenAI-compatible adapter (`src/providers/openai-compat.ts`) except Anthropic (`anthropic.ts`) and Google (`google.ts`) which have native adapters.

### API Endpoints

- `GET /` — Live HTML dashboard (auto-refresh 30s)
- `POST /v1/chat/completions` — Main routing endpoint (OpenAI-compatible)
- `POST /v1/messages` — Anthropic-shape entry point (Claude Agent SDK)
- `GET /v1/models` — List available models
- `GET /v1/credits` — OpenRouter-shape wallet balance (Bearer auth)
- `GET /v1/stats` — Cost tracking and savings JSON
- `GET /v1/stats/recent` — Last 25 requests JSON
- `GET /health` — Health check with provider status
- `GET /wallet/me` — Full user record (Bearer auth)
- `POST /wallet/topup` — Stripe Checkout for existing customer (Bearer auth)
- `POST /wallet/checkout` — Stripe Checkout for new signup or returning email (public)
- `POST /webhook/stripe` — Stripe webhook receiver (verified signature, idempotent on event id)

## Tech Stack

- **Runtime**: Node.js 20+ / TypeScript (ES2022, ESM)
- **HTTP**: Fastify 5 with `@fastify/cors`, `@fastify/rate-limit`
- **Validation**: Zod
- **Testing**: Vitest 4
- **Providers**: `@anthropic-ai/sdk`, `@google/genai`, `openai`
- **Database**: better-sqlite3 (request tracking)
- **CLI**: Commander
- **Logging**: Pino + pino-pretty
- **Config**: YAML (`yaml` package)
- **IDs**: nanoid

## Commands

```bash
npm run dev        # Start dev server (tsx watch)
npm run build      # Compile TypeScript → dist/
npm start          # Run compiled build
npm run cli        # Run CLI (pharos init / pharos start)
npm test           # Run tests (vitest)
npm run test:watch # Run tests in watch mode
npm run lint       # ESLint
npm run format     # Prettier
```

## Configuration

- Default config: `config/pharos.default.yaml`
- User overrides: `pharos.yaml` in project root (gitignored)
- Environment: `.env` (copy from `.env.example`)
- Config merge order: defaults → user YAML → env vars
- Required env vars: at minimum `MOONSHOT_API_KEY` (powers classifier) + `GROQ_API_KEY` (free tier routing)

## Deployment

### Mac Mini (PRIMARY — Production)
- **Host**: ghostfx@192.168.1.148 (Mac Mini M4 16GB)
- **Path**: `~/pharos/` (config, data, dist, .env)
- **Service**: launchd `com.pharos.gateway` (PID managed by launchd)
- **Port**: 3777 (localhost)
- **Plist**: `~/Library/LaunchAgents/com.pharos.gateway.plist`
- **Auth**: Bearer token required (`PHAROS_API_KEY` env var in `~/pharos/.env`)
- **Logs**: `~/.openclaw/logs/pharos-stdout.log`, `pharos-stderr.log`
- **DB**: `~/pharos/data/pharos.db` (active), `pharos-vps-archive.db` (historical from VPS)
- **Deploy**: `npm run build` locally → `scp dist/ ghostfx@192.168.1.148:~/pharos/dist/`
- **Restart**: `launchctl kickstart -k gui/501/com.pharos.gateway`
- **Health**: `curl -s http://localhost:3777/health`
- **Stats**: `curl -s -H "Authorization: Bearer $PHAROS_API_KEY" http://localhost:3777/v1/stats`

### VPS — DECOMMISSIONED
- Historical VPS data preserved at `~/pharos/data/pharos-vps-archive.db` on Mac Mini
- Legacy deploy scripts in `scripts/` are VPS-only — do not use

## Code Conventions

- ESM (`"type": "module"`) — all imports use `.js` extensions
- Strict TypeScript, Zod for runtime validation
- Path alias `@/*` maps to `src/*`
- Prettier: single quotes, trailing commas, 100 char width, 2-space indent
- Pino structured logging — never use `console.log` in src/
- All API responses follow OpenAI's response format exactly
- Provider adapters extend abstract `LLMProvider` base class
- Errors are formatted as OpenAI-compatible error objects

## File Layout

```
src/
├── index.ts                          # Entry point
├── server.ts                         # Component assembly
├── cli/
│   ├── index.ts                      # CLI entry (commander)
│   ├── init.ts                       # pharos init
│   └── start.ts                      # pharos start
├── config/
│   ├── index.ts                      # Config loader
│   └── schema.ts                     # Zod schemas (incl. ClassifierProviderEntrySchema, ConversationConfigSchema)
├── classifier/
│   ├── index.ts                      # QueryClassifier (failover chain)
│   ├── prompt.ts                     # Classification prompt + input truncation
│   └── types.ts                      # ClassificationResult (incl. classifierProvider)
├── providers/
│   ├── base.ts                       # Abstract LLMProvider
│   ├── types.ts                      # ChatMessage, ChatRequest, etc.
│   ├── index.ts                      # ProviderRegistry
│   ├── anthropic.ts                  # Claude adapter (prompt caching)
│   ├── google.ts                     # Gemini adapter
│   └── openai-compat.ts             # DeepSeek/Groq/Mistral/OpenAI/Moonshot/xAI
├── registry/
│   └── models.ts                     # Model metadata catalog (capabilities, pricing, speed)
├── router/
│   ├── index.ts                      # ModelRouter (incl. task-type overrides)
│   ├── tier-resolver.ts              # Score→tier logic
│   ├── affinity.ts                   # Task-type affinity sorting
│   ├── conversation-tracker.ts       # Conversation tier floor tracking (LRU-backed)
│   └── failover.ts                   # Failover chain (affinity-aware)
├── tracking/
│   ├── store.ts                      # SQLite TrackingStore (incl. classifier_provider column)
│   ├── cost-calculator.ts            # Pricing table + calculations
│   └── types.ts                      # RequestRecord (incl. classifierProvider), CostSummary
├── gateway/
│   ├── router.ts                     # HTTP route handlers + HTML dashboard
│   ├── middleware/
│   │   ├── auth.ts                   # API key auth
│   │   ├── agent-rate-limit.ts       # Per-agent sliding window rate limiter
│   │   └── error-handler.ts          # Error formatting
│   └── schemas/
│       ├── request.ts                # Request validation
│       └── response.ts               # Response builders
└── utils/
    ├── logger.ts                     # Pino logger factory
    ├── id.ts                         # UUID v4 + nanoid generators
    ├── context.ts                    # Context window sizes + token estimation
    ├── stream.ts                     # SSE helpers
    ├── alerts.ts                     # Discord webhook alerts (singleton)
    ├── retry.ts                      # Retry-with-backoff for transient errors
    └── self-test.ts                  # Startup provider self-test
```

## Security & Hardening

- SQL queries use parameterized bindings (no string interpolation)
- Message content capped at 500KB, conversation array capped at 500 messages
- Bearer token parsing uses strict regex (`/^Bearer\s+(\S+)$/`)
- CORS configurable via `PHAROS_CORS_ORIGINS` env var (comma-separated, defaults to localhost dev ports)
- Rate limiting: 100 req/min per IP via `@fastify/rate-limit`, 30 req/min per agent
- Spending limits: daily/monthly caps, alerts at 80%/100%, 429 when exceeded
- Provider request timeouts: 30s default (AbortController for OpenAI/Anthropic, native for Google)
- Provider health cooldown: configurable (default 60s), tracked via consecutive error count
- Classifier validates response scores (must be finite number 1-10, otherwise tries next provider)
- Classifier input truncated (1000 chars/msg, 4000 total) to prevent context limit failures
- Tier config validated: scoreRange min <= max, no overlapping ranges between tiers
- Pricing table configurable via YAML (hardcoded defaults as fallback)
- TrackingStore.close() is idempotent (safe for multiple shutdown paths)
- Stream errors caught and SSE properly closed on failure
- macOS launchd: KeepAlive=true, auto-restart on crash (was systemd on VPS)
- Conversation tracking: bounded LRU cache (500 max, 30min TTL) prevents unbounded memory growth

## Development Notes

- Server listens on port 3777 by default
- SQLite DB stored at `data/pharos.db` (gitignored), auto-migrates new columns
- Classifier failover chain: Moonshot (kimi-latest) → Groq → xAI → static fallback score
- Fallback scores derived from tier config midpoints (not hardcoded)
- Provider health tracking: 3 consecutive errors → provider marked unhealthy (configurable cooldown)
- Context-size errors don't damage provider health (undoLastError)
- Pre-flight context window filtering: skips providers with insufficient context for large requests
- Streaming uses Server-Sent Events (SSE) matching OpenAI's format
- Response headers include `X-Pharos-*` metadata (tier, model, score, cost, retries, request-id)
- `presence_penalty` and `frequency_penalty` forwarded to providers
- Extended thinking passthrough for Anthropic models
- Groq rejects some requests at runtime (~12K+ tokens) despite 128K advertised limit — failover handles this gracefully
- Task-type affinity: within each tier, models are sorted by task-type preference (code→DeepSeek, reasoning→Anthropic, etc.)
- Virtual model names: `pharos-code`, `pharos-math`, `pharos-reasoning`, `pharos-creative`, `pharos-analysis`, `pharos-conversation` force a task type while using classifier for complexity
- Affinity config: `taskAffinity` in YAML overrides defaults from `src/router/affinity.ts`
- 10 task types: greeting, lookup, analysis, planning, creative, code, reasoning, tool_use, math, conversation
- Conversation tracking: LRU-backed tier floor prevents quality drops in multi-turn conversations
- Conversation tier floor: one tier below highest seen (e.g. premium peak → economical floor)
- Anthropic prompt caching: system messages get `cache_control: { type: 'ephemeral' }`, multi-turn conversations get cache breakpoint on second-to-last message
- Conversation config: `conversation.enabled`, `conversation.maxConversations` (500), `conversation.conversationTtlMs` (30min)

## Testing

- **Framework**: Vitest 4
- **Test files**: `src/__tests__/*.test.ts`
- **Coverage**: tier-resolver (23), cost-calculator (25), auth middleware (9), ID generators (10), config schema (52), classifier (21), failover (15), tracking-store (30), router (35), context (26), stream (10), providers (122), alerts (26), self-test (15), semaphore (16), lru-cache (10), agent-rate-limit (12), retry (40), registry (22), affinity (18), conversation-tracker (23)
- **Total**: 1120 tests, all passing (560 src + 560 dist)
- Run: `npm test` or `npm run test:watch`

## Alerts & Monitoring

- Discord webhook alerts via `src/utils/alerts.ts` (singleton pattern)
- Phone push notifications via ntfy.sh (critical alerts only) — configured via `PHAROS_NTFY_TOPIC`
- Configured via `PHAROS_DISCORD_WEBHOOK_URL` + `PHAROS_NTFY_TOPIC` env vars
- Severity levels: info (green/Discord only), warning (yellow/Discord only), critical (red/both Discord + phone)
- 5-minute cooldown per alert key to prevent spam
- Triggers: startup/shutdown, provider unhealthy (3 errors), classifier failover, all providers unavailable
- Startup self-test (`src/utils/self-test.ts`): sends tiny request to each provider, logs pass/fail
- Self-test configurable via `server.selfTest` (default: true), skipped in test environment

## Roadmap Status

- **Phase 1 (Core Engine)**: ✅ COMPLETE (Feb 25, 2026) — full feature inventory in `PRODUCT.md` and git history. Headlines: 982 tests, 73.4% savings, 0% error rate, classifier failover chain, per-agent rate limits, spending caps, retry-with-backoff, Docker.
- **Phase 2 (Universal Intelligent Router)**: IN PROGRESS — see PRODUCT.md for full blueprint
  - **Phase 2A**: ✅ Provider expansion — Together AI + Fireworks AI (5 new models)
  - **Phase 2B**: ✅ Model registry — `src/registry/models.ts` with capabilities, pricing, speed metadata
  - **Phase 2C**: ✅ Task-type-aware routing — affinity system, virtual model names (pharos-code, pharos-math, etc.)
  - **Phase 2D**: ✅ Conversation tracking + prompt caching — tier floor prevents quality drops, Anthropic cache hints
  - **Phase 2E**: ✅ Anthropic-shape `/v1/messages` endpoint — Claude Agent SDK compatibility (May 2, 2026)
  - Performance learning + auto-tuned routing weights
- **Phase 2.5 (SaaS Launch Blockers)**: 🚨 P0 — required before public SaaS launch
  - **Streaming + tool_use parity** — `ChatStreamChunk` currently only carries `content: string`; needs to surface `tool_calls` from each provider so the existing `AnthropicStreamTranslator` (which already supports tool_use events) gets fed properly. Every modern agent framework (Claude SDK, OpenAI Agents SDK, OpenClaw, Lindy) defaults to streaming, so without this Pharos breaks all of them for the most common pattern (agents using tools). Documented as known limitation in `src/translation/anthropic-stream.ts` and `src/gateway/messages-routes.ts` — promote to fix before launch.
  - ✅ Wave 5 wallet — Stripe Checkout (`/wallet/checkout` + `/wallet/topup`), webhook (`/webhook/stripe`), idempotent topup ledger, signup-on-first-payment, Resend welcome email with raw API key. 21 wallet route tests (May 10, 2026). See `CONTRACT.md` for the wire spec the landing page (`pharos.nexlabs.pro`) must follow.
- **Phase 3 (Dashboard)**: NOT STARTED — web UI, model registry browser, routing visualization
- **Phase 4 (Distribution)**: NOT STARTED — npm package, Docker Hub, docs site, community registry

### Strategic positioning (per Ghost, May 2, 2026)
Pharos is going SaaS as a **runtime-agnostic multi-modal power-up**. Drop-in inference router that works with any agent framework (Claude SDK, OpenAI Agents SDK, OpenClaw, Lindy, future), saves 70-90% on costs, handles all modalities. The "fits all" principle from the universal-compatibility memory operationalizes here.

## Production Stats

### Current (Mac Mini — verified May 1, 2026)
- **12 providers** configured, all healthy (verified via `/health`) — added OpenRouter 2026-04-30
- **17,728 lifetime requests** processed (verified via `/v1/stats`); **87.01% cost savings** vs Sonnet baseline
- **Active agents**: registered in `agents:` block of `pharos.yaml` — marketing-agent, openclaw, noir-prime, sentinel, quant, lens, prospector + `_default` floor (economical)
- **Note**: prior "15 agents in production" claim was aspirational; actual ongoing traffic comes primarily from NOIR scripts and the marketing agent. Once OpenClaw is reinstalled, expect that fleet to ramp up.
- Noir (orchestrator) routes via `pharos-auto:noir-prime` with `minTier: premium` agent profile guard (ensures premium+ for reliable tool_use delegation)
- Gemini 2.5 Flash handles free tier (score 1-3) — Ollama decommissioned May 2026
- Gemini 2.5 Flash across all fallback chains
- max_tokens capped at 1536 across all models (cost protection)
- Discord alerts + ntfy.sh phone notifications live

### Historical (VPS — decommissioned Feb 25, 2026)
Archived in `~/pharos/data/pharos-vps-archive.db` — 201 requests, 73.4% savings, 35/35 stress test pass.

<!-- KNOWLEDGE-BASE:start -->
## Knowledge Base
Personal knowledge ingested via `/learn <url>`. Auto-loads on session start.
@~/knowledge/INDEX.md
@~/knowledge/tags/pharos.md
<!-- KNOWLEDGE-BASE:end -->
