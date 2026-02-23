# CLAUDE.md — Pharos

## Project Overview

Pharos is an intelligent LLM routing gateway. It sits between AI apps (OpenClaw, ElizaOS, Discord bots, any OpenAI-compatible client) and model providers, classifying each query's complexity in real-time and routing it to the cheapest model that can handle it well. Saves 85-95% on LLM costs.

## Architecture

```
HTTP Request → Auth Middleware → Zod Validation → Classifier (Gemini Flash)
  → Router (score→tier→model) → Provider Adapter → Response (OpenAI format)
  → Tracking (SQLite cost log)
```

### Core Modules

| Module | Path | Purpose |
|--------|------|---------|
| Entry | `src/index.ts` | Boot, graceful shutdown |
| Server | `src/server.ts` | Wires all components together |
| Config | `src/config/` | YAML loader + Zod schema validation |
| Classifier | `src/classifier/` | Gemini Flash scores queries 1-10 + task type |
| Router | `src/router/` | Score→tier mapping, failover chain |
| Providers | `src/providers/` | Anthropic, Google, OpenAI-compat adapters |
| Gateway | `src/gateway/` | Fastify HTTP routes, auth, request/response schemas |
| Tracking | `src/tracking/` | SQLite cost recording, savings calculator |
| Utils | `src/utils/` | Pino logger, ID generators, SSE helpers |
| CLI | `src/cli/` | `pharos start` and `pharos init` commands |

### Tier Routing (default config)

- **Free** (score 1-3): Gemini Flash, Groq Llama 3.3
- **Economical** (score 4-6): DeepSeek, Mistral, Groq
- **Premium** (score 7-8): Claude Sonnet, GPT-4o, Gemini Pro
- **Frontier** (score 9-10): Claude Opus, O3, Claude Sonnet (fallback)

### API Endpoints

- `POST /v1/chat/completions` — Main routing endpoint (OpenAI-compatible)
- `GET /v1/models` — List available models
- `GET /v1/stats` — Cost tracking and savings dashboard
- `GET /health` — Health check

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
- Only `GOOGLE_AI_API_KEY` is required (powers the free-tier classifier)

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
│   └── schema.ts                     # Zod schemas
├── classifier/
│   ├── index.ts                      # QueryClassifier class
│   ├── prompt.ts                     # Classification prompt builder
│   └── types.ts                      # ClassificationResult, TaskType
├── providers/
│   ├── base.ts                       # Abstract LLMProvider
│   ├── types.ts                      # ChatMessage, ChatRequest, etc.
│   ├── index.ts                      # ProviderRegistry
│   ├── anthropic.ts                  # Claude adapter
│   ├── google.ts                     # Gemini adapter
│   └── openai-compat.ts             # DeepSeek/Groq/Mistral/OpenAI
├── router/
│   ├── index.ts                      # ModelRouter
│   ├── tier-resolver.ts              # Score→tier logic
│   └── failover.ts                   # Failover chain
├── tracking/
│   ├── store.ts                      # SQLite TrackingStore
│   ├── cost-calculator.ts            # Pricing table + calculations
│   └── types.ts                      # RequestRecord, CostSummary
├── gateway/
│   ├── router.ts                     # HTTP route handlers
│   ├── middleware/
│   │   ├── auth.ts                   # API key auth
│   │   └── error-handler.ts          # Error formatting
│   └── schemas/
│       ├── request.ts                # Request validation
│       └── response.ts               # Response builders
└── utils/
    ├── logger.ts                     # Pino logger factory
    ├── id.ts                         # nanoid generators
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
- Classifier validates response scores (must be finite number 1-10, otherwise fallback)
- Tier config validated: scoreRange min <= max, no overlapping ranges between tiers
- Pricing table configurable via YAML (hardcoded defaults as fallback)
- TrackingStore.close() is idempotent (safe for multiple shutdown paths)
- Stream errors caught and SSE properly closed on failure

## Development Notes

- Server listens on port 3777 by default
- SQLite DB stored at `data/pharos.db` (gitignored)
- Classifier has a 5s timeout with AbortController; falls back to "economical" tier on failure
- Fallback scores derived from tier config midpoints (not hardcoded)
- Provider health tracking: 3 consecutive errors → provider marked unhealthy (configurable cooldown)
- Streaming uses Server-Sent Events (SSE) matching OpenAI's format
- Response headers include `X-Pharos-*` metadata (tier, model, score)
- `presence_penalty` and `frequency_penalty` forwarded to providers

## Testing

- **Framework**: Vitest 4
- **Test files**: `src/__tests__/*.test.ts`
- **Coverage**: tier-resolver (23 tests), cost-calculator (20), auth middleware (9), ID generators (10), config schema (33)
- **Total**: 95 tests, all passing
- Run: `npm test` or `npm run test:watch`

## Roadmap Status

- **Phase 1 (Core Engine)**: COMPLETE + HARDENED — routing, classification, multi-provider, failover, tracking, security, tests
- **Phase 2 (Intelligence)**: NOT STARTED — semantic caching, conversation-aware routing, prompt caching
- **Phase 3 (Dashboard)**: NOT STARTED — web UI, config UI, real-time feed
- **Phase 4 (Distribution)**: NOT STARTED — npm package, Docker, docs site
