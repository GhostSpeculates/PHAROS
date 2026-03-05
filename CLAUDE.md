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

### Providers (11 active — 10 cloud + 1 local)

Anthropic, Google, OpenAI, DeepSeek, Groq, Mistral, xAI, Moonshot, Together AI, Fireworks AI, Ollama (local)

All use the OpenAI-compatible adapter (`src/providers/openai-compat.ts`) except Anthropic (`anthropic.ts`) and Google (`google.ts`) which have native adapters.

### API Endpoints

- `GET /` — Live HTML dashboard (auto-refresh 30s)
- `POST /v1/chat/completions` — Main routing endpoint (OpenAI-compatible)
- `GET /v1/models` — List available models
- `GET /v1/stats` — Cost tracking and savings JSON
- `GET /v1/stats/recent` — Last 25 requests JSON
- `GET /health` — Health check with provider status

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

### Providers (11 active on Mac Mini)
Anthropic, Google, OpenAI, DeepSeek, Groq, Mistral, xAI, Moonshot, Together AI, Fireworks AI, Ollama (local)

### Ollama (Local — $0 routing)
- **Models**: qwen2.5:14b (8GB), kimi-k2.5:cloud
- **Endpoint**: http://localhost:11434
- Pharos routes score 1-3 queries to Ollama for free local inference
- All 8 OpenClaw workers use `ollama/qwen2.5:14b` as primary model

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

- **Phase 1 (Core Engine)**: ✅ COMPLETE — declared by Ghost on Feb 25, 2026
  - 982 tests, 73.4% cost savings, 0% error rate, stress tested 35/35, 10 providers
  - Routing, classification, multi-provider (10), failover, tracking, security, 982 tests
  - Classifier: concurrency semaphore (max 5), LRU cache (30s TTL), 429 fast failover, metrics
  - Classifier failover chain (Moonshot/kimi-latest → Groq → xAI → static fallback/economical)
  - Frontier prompt tightened: 99% of tasks score 1-8, explicit "NOT 9-10" examples
  - Discord alerts + ntfy.sh phone push (critical only) + startup self-test
  - Error tracking in SQLite (status + error_message columns)
  - Configurable: rate limit, body limit, retention days, oversized threshold, self-test, classifier concurrency
  - Request ID: UUID v4 (crypto.randomUUID()), X-Request-Id client correlation
  - Per-agent rate limiting: sliding window counter, configurable per-minute limit
  - Spending limits: daily/monthly caps with alerts at 80% and 100%
  - Retry with backoff: transient errors (429/502/503) retried once before failover
  - Debug logging: opt-in, first 500 chars of input/output stored in SQLite
  - CORS defaults to localhost dev ports (not wide open)
  - Google multimodal fix (array content handling)
  - Moonshot: international platform (api.moonshot.ai), model kimi-latest
  - Stress test script: `scripts/stress-test.sh` (35 requests, 3 phases, burst + mixed load)
  - Dockerfile + docker-compose.yml (multi-stage build, non-root, healthcheck, 512MB limit)
- **Phase 2 (Universal Intelligent Router)**: IN PROGRESS — see PRODUCT.md for full blueprint
  - **Phase 2A**: ✅ Provider expansion — Together AI + Fireworks AI (5 new models)
  - **Phase 2B**: ✅ Model registry — `src/registry/models.ts` with capabilities, pricing, speed metadata
  - **Phase 2C**: ✅ Task-type-aware routing — affinity system, virtual model names (pharos-code, pharos-math, etc.)
  - **Phase 2D**: ✅ Conversation tracking + prompt caching — tier floor prevents quality drops, Anthropic cache hints
  - Performance learning + auto-tuned routing weights
- **Phase 3 (Dashboard)**: NOT STARTED — web UI, model registry browser, routing visualization
- **Phase 4 (Distribution)**: NOT STARTED — npm package, Docker Hub, docs site, community registry

## Production Stats

### Current (Mac Mini — March 4, 2026)
- **11 providers** configured, all healthy (verified via `/health`)
- **15 agents** routing through Pharos (7 core via `pharos/pharos-auto:X`, 8 workers via `ollama/qwen2.5:14b` with Pharos fallback)
- Noir (orchestrator) routes via `pharos-auto:noir-prime` with `minTier: premium` agent profile guard (ensures premium+ for reliable tool_use delegation)
- Local Ollama handles score 1-3 queries at $0
- Gemini 2.5 Flash across all fallback chains
- max_tokens capped at 1536 across all models (cost protection)
- Discord alerts + ntfy.sh phone notifications live

### Historical (VPS — Feb 25, 2026)
- 201 requests processed, **73.4% savings** vs Sonnet baseline ($1.93 actual vs $7.24 baseline)
- Stress tested: 35/35 requests under burst load, 0 failures
- Historical data preserved in `~/pharos/data/pharos-vps-archive.db`
