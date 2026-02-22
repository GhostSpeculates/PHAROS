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
- **HTTP**: Fastify 5 with `@fastify/cors`
- **Validation**: Zod
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

## Development Notes

- Server listens on port 3777 by default
- SQLite DB stored at `data/pharos.db` (gitignored)
- Classifier has a 5s timeout; falls back to "economical" tier on failure
- Provider health tracking: 3 consecutive errors → provider marked unhealthy for 60s
- Streaming uses Server-Sent Events (SSE) matching OpenAI's format
- Response headers include `X-Pharos-*` metadata (tier, model, score)

## Roadmap Status

- **Phase 1 (Core Engine)**: COMPLETE — routing, classification, multi-provider, failover, tracking
- **Phase 2 (Intelligence)**: NOT STARTED — semantic caching, conversation-aware routing, prompt caching
- **Phase 3 (Dashboard)**: NOT STARTED — web UI, config UI, real-time feed
- **Phase 4 (Distribution)**: NOT STARTED — npm package, Docker, docs site
