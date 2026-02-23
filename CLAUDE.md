# CLAUDE.md — Pharos

## Project Overview

Pharos is an intelligent LLM routing gateway. It sits between AI apps (OpenClaw, ElizaOS, Discord bots, any OpenAI-compatible client) and model providers, classifying each query's complexity in real-time and routing it to the cheapest model that can handle it well. Saves 66%+ on LLM costs.

## Architecture

```
HTTP Request → Auth Middleware → Zod Validation → Classifier (failover chain)
  → Router (score→tier→model) → Provider Adapter → Response (OpenAI format)
  → Tracking (SQLite cost log + classifier provider)
```

### Classifier Failover Chain

The classifier tries providers in order before falling back to a static tier score:
1. **Groq** / llama-3.3-70b-versatile (fast, cheap)
2. **Moonshot** / kimi-k2 (cheap, good quality)
3. **xAI** / grok-3-mini-fast (fast fallback)
4. **Static fallback** → premium tier midpoint score

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
| Gateway | `src/gateway/` | Fastify HTTP routes, auth, request/response schemas |
| Tracking | `src/tracking/` | SQLite cost recording, savings calculator |
| Utils | `src/utils/` | Pino logger, ID generators, SSE helpers, context windows |
| CLI | `src/cli/` | `pharos start` and `pharos init` commands |

### Tier Routing (default config)

- **Free** (score 1-3): Groq Llama 3.3, Gemini Flash
- **Economical** (score 4-6): Groq Llama 3.3, Kimi K2, DeepSeek, GPT-4o
- **Premium** (score 7-8): Claude Sonnet, GPT-4o
- **Frontier** (score 9-10): Claude Opus, Claude Sonnet (fallback), GPT-4o

### Providers (8 active)

Anthropic, Google, OpenAI, DeepSeek, Groq, Mistral, xAI, Moonshot

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
- Required env vars: at minimum `GROQ_API_KEY` (powers classifier + free tier)

## Deployment

- **VPS**: root@<vps-redacted>, port 3777, systemd service `pharos`
- **Deploy**: `npm run build && bash scripts/deploy-vps.sh`
- Deploy script packages `.env` + `config/` + `dist/` + `package*.json` → tarball → SCP → VPS
- Systemd: `Restart=always`, 5s delay, 5 burst/60s limit
- Journald: 500M max, 50M per file (`/etc/systemd/journald.conf.d/pharos.conf`)
- Auth: Bearer token required (`PHAROS_API_KEY` env var)
- Binding: localhost-only (127.0.0.1), UFW firewall (SSH only)

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
│   └── schema.ts                     # Zod schemas (incl. ClassifierProviderEntrySchema)
├── classifier/
│   ├── index.ts                      # QueryClassifier (failover chain)
│   ├── prompt.ts                     # Classification prompt + input truncation
│   └── types.ts                      # ClassificationResult (incl. classifierProvider)
├── providers/
│   ├── base.ts                       # Abstract LLMProvider
│   ├── types.ts                      # ChatMessage, ChatRequest, etc.
│   ├── index.ts                      # ProviderRegistry
│   ├── anthropic.ts                  # Claude adapter
│   ├── google.ts                     # Gemini adapter
│   └── openai-compat.ts             # DeepSeek/Groq/Mistral/OpenAI/Moonshot/xAI
├── router/
│   ├── index.ts                      # ModelRouter
│   ├── tier-resolver.ts              # Score→tier logic
│   └── failover.ts                   # Failover chain
├── tracking/
│   ├── store.ts                      # SQLite TrackingStore (incl. classifier_provider column)
│   ├── cost-calculator.ts            # Pricing table + calculations
│   └── types.ts                      # RequestRecord (incl. classifierProvider), CostSummary
├── gateway/
│   ├── router.ts                     # HTTP route handlers + HTML dashboard
│   ├── middleware/
│   │   ├── auth.ts                   # API key auth
│   │   └── error-handler.ts          # Error formatting
│   └── schemas/
│       ├── request.ts                # Request validation
│       └── response.ts               # Response builders
└── utils/
    ├── logger.ts                     # Pino logger factory
    ├── id.ts                         # nanoid generators
    ├── context.ts                    # Context window sizes + token estimation
    └── stream.ts                     # SSE helpers
```

## Security & Hardening

- SQL queries use parameterized bindings (no string interpolation)
- Message content capped at 500KB, conversation array capped at 100 messages
- Bearer token parsing uses strict regex (`/^Bearer\s+(\S+)$/`)
- CORS configurable via `PHAROS_CORS_ORIGINS` env var (comma-separated, defaults to open)
- Rate limiting: 100 req/min per IP via `@fastify/rate-limit`
- Provider request timeouts: 30s default (AbortController for OpenAI/Anthropic, native for Google)
- Provider health cooldown: configurable (default 60s), tracked via consecutive error count
- Classifier validates response scores (must be finite number 1-10, otherwise tries next provider)
- Classifier input truncated (1000 chars/msg, 4000 total) to prevent context limit failures
- Tier config validated: scoreRange min <= max, no overlapping ranges between tiers
- Pricing table configurable via YAML (hardcoded defaults as fallback)
- TrackingStore.close() is idempotent (safe for multiple shutdown paths)
- Stream errors caught and SSE properly closed on failure
- Systemd: Restart=always, memory limits (2G max), graceful shutdown (SIGTERM, 30s timeout)

## Development Notes

- Server listens on port 3777 by default
- SQLite DB stored at `data/pharos.db` (gitignored), auto-migrates new columns
- Classifier failover chain: Groq → Kimi → xAI → static fallback score
- Fallback scores derived from tier config midpoints (not hardcoded)
- Provider health tracking: 3 consecutive errors → provider marked unhealthy (configurable cooldown)
- Context-size errors don't damage provider health (undoLastError)
- Pre-flight context window filtering: skips providers with insufficient context for large requests
- Streaming uses Server-Sent Events (SSE) matching OpenAI's format
- Response headers include `X-Pharos-*` metadata (tier, model, score, cost, retries, request-id)
- `presence_penalty` and `frequency_penalty` forwarded to providers
- Extended thinking passthrough for Anthropic models
- Groq rejects some requests at runtime (~12K+ tokens) despite 128K advertised limit — failover handles this gracefully

## Testing

- **Framework**: Vitest 4
- **Test files**: `src/__tests__/*.test.ts`
- **Coverage**: tier-resolver (23), cost-calculator (20), auth middleware (9), ID generators (10), config schema (38), classifier (11), failover (15), tracking-store (13), router (15), context (21), stream (10)
- **Total**: 370 tests, all passing (185 src + 185 dist)
- Run: `npm test` or `npm run test:watch`

## Roadmap Status

- **Phase 1 (Core Engine)**: COMPLETE + HARDENED + CLASSIFIER FAILOVER
  - Routing, classification, multi-provider (8), failover, tracking, security, tests
  - Classifier failover chain (Groq → Kimi → xAI → fallback)
  - Input truncation to prevent classifier context limit failures
  - Systemd: Restart=always, journald 500M limit
  - Per-provider timeout/cooldown from config (ProviderRegistry)
  - presence_penalty / frequency_penalty forwarded (OpenAI-compat + Google)
  - Unknown model pricing warns once per model
  - CORS origin parsing trims whitespace
  - 370 tests passing
- **Phase 2 (Intelligence)**: NOT STARTED — semantic caching, conversation-aware routing, prompt caching
- **Phase 3 (Dashboard)**: NOT STARTED — web UI (React SPA), config UI, real-time feed
- **Phase 4 (Distribution)**: NOT STARTED — npm package, Docker, docs site

## Production Stats (Feb 23, 2026)

- 80+ requests processed, **66% savings** vs Sonnet baseline
- 8 providers active and healthy
- Zero errors since hardening deploy
- Memory: ~62MB, VPS load: 0.07
