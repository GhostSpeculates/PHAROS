<p align="center">
  <h1 align="center">PHAROS</h1>
  <p align="center"><em>The Lighthouse for Intelligent AI Routing</em></p>
  <p align="center">
    <strong>Save 66%+ on LLM costs without sacrificing quality.</strong><br/>
    Pharos intelligently routes every AI query to the optimal model — from free tiers to frontier models like Claude Opus — ensuring you only pay for power when you truly need it.
  </p>
</p>

---

## Quick Start

```bash
git clone https://github.com/GhostSpeculates/PHAROS.git
cd PHAROS
npm install
cp .env.example .env
# Edit .env — add at least GROQ_API_KEY and PHAROS_API_KEY
npm run dev
```

**Prerequisites:** Node.js 20+ and a [Groq API key](https://console.groq.com) (free).

**Full setup guide:** [GETTING_STARTED.md](./GETTING_STARTED.md)

---

## What is Pharos?

Pharos is an **intelligent LLM routing gateway** — a service that sits between your AI application (OpenClaw, ElizaOS, custom bots, any OpenAI-compatible client) and the model providers (Anthropic, Google, DeepSeek, Groq, Mistral, OpenAI, xAI, Moonshot).

Instead of sending every query to an expensive frontier model, Pharos **classifies each query in real-time** and routes it to the optimal model from a tiered pool of providers:

- **Free (Score 1-3):** Simple queries, greetings, routine tasks --> Groq Llama 3.3, Gemini Flash
- **Economical (Score 4-6):** Analysis, planning, moderate reasoning --> Groq, Kimi K2, DeepSeek, GPT-4o
- **Premium (Score 7-8):** Complex strategy, creative work, multi-step reasoning --> Claude Sonnet, GPT-4o
- **Frontier (Score 9-10):** The hardest problems that genuinely need the best --> Claude Opus

The result: **~70% of queries cost $0, ~25% cost fractions of a penny, and only ~5% hit premium models** — with essentially identical quality to running everything on Sonnet.

## How It Works

```
Your App  -->  Pharos Gateway  -->  Query Classifier  -->  Optimal Model
                                        |
                    +-------------------+-------------------+
                    v                   v                    v
              Free Models        Cheap Models         Premium Models
            (Gemini, Groq)     (DeepSeek, Kimi)    (Sonnet, Opus)
```

1. **Drop-in replacement**: Pharos exposes an OpenAI-compatible API. Change one URL and you are routed.
2. **Real-time classification**: A lightweight classifier (runs on Moonshot/Kimi) scores query complexity (1-10) with a failover chain (Moonshot --> Groq --> xAI --> static fallback).
3. **Smart routing**: Based on the score, Pharos routes to the cheapest model that can handle the query well.
4. **Automatic failover**: If a provider is down, Pharos cascades to the next available model in the tier.
5. **Full observability**: Live dashboard showing costs, model usage, savings, and provider health.

## Key Features

- **OpenAI-compatible API** — Works with anything that speaks OpenAI format
- **Intelligent classification** — AI-powered query complexity scoring, not rule-based
- **8 providers** — Anthropic, Google, OpenAI, DeepSeek, Groq, Mistral, xAI, Moonshot
- **Tiered model pools** — 4 tiers with configurable score ranges and model lists
- **Automatic failover** — Provider down? Seamless cascade to the next best option
- **Classifier failover chain** — Moonshot --> Groq --> xAI --> static fallback
- **Cost dashboard** — See exactly how much Pharos saved you (live at `/`)
- **Context-size-aware routing** — Pre-flight filtering skips providers that cannot handle large requests
- **Extended thinking passthrough** — Anthropic extended thinking works transparently
- **Streaming support** — Server-Sent Events matching OpenAI's format
- **API key management** — One place for all your provider keys
- **Configurable thresholds** — Tune the quality/cost tradeoff to your preference
- **Self-hostable** — Runs on your own VPS or Docker (2GB+ RAM, no GPU needed)
- **Semantic caching** — _Coming in Phase 2_

## Who Is This For?

- **OpenClaw / ElizaOS users** burning through API credits
- **Discord bot operators** paying too much for AI responses
- **Indie developers** building AI-powered products on a budget
- **Small businesses** using AI assistants for operations
- **Anyone** who wants frontier AI quality at significantly less cost

---

## Docker

```bash
# Start Pharos
docker compose up -d

# View logs
docker compose logs -f pharos

# Stop
docker compose down
```

Make sure your `.env` file is configured before running. SQLite data persists in `./data/` and config overrides load from `./config/`.

## Deployment

| Method | Command | Notes |
|--------|---------|-------|
| **Local dev** | `npm run dev` | Auto-restarts on file changes |
| **Production** | `npm run build && npm start` | Compiled TypeScript |
| **Docker** | `docker compose up -d` | See above |
| **VPS** | `bash scripts/deploy-vps.sh` | SCP + systemd |

See [GETTING_STARTED.md](./GETTING_STARTED.md) for detailed deployment instructions.

---

## Tech Stack

- **Runtime**: Node.js 20+ / TypeScript (ES2022, ESM)
- **HTTP**: Fastify 5 with CORS, rate limiting
- **Validation**: Zod
- **Testing**: Vitest 4 (772 tests)
- **Providers**: `@anthropic-ai/sdk`, `@google/genai`, `openai`
- **Database**: better-sqlite3 (request tracking)
- **Config**: YAML with env-var overrides
- **Logging**: Pino structured logging

## Project Status

**Phase 1 (Core Engine): IN PROGRESS** — Deployed to production, routing live traffic. Core infrastructure is built but Phase 1 requires continued hardening, bug fixes, and professional polish before moving to Phase 2.

- 8 providers configured, 772 tests passing, 73%+ cost savings
- Classifier failover chain, context-size-aware routing, production hardening
- Needs continued stability testing and edge case coverage

**Phase 2 (Intelligence): Planned** — Semantic caching, conversation-aware routing, prompt caching

**Phase 3 (Dashboard): Planned** — React SPA, configuration UI, real-time feed

**Phase 4 (Distribution): Planned** — npm package, Docker Hub image, documentation site

---

## Documentation

| Document | Description |
|----------|-------------|
| [GETTING_STARTED.md](./GETTING_STARTED.md) | Step-by-step setup guide, API keys, configuration, deployment |
| [NOIR-INTEGRATION.md](./NOIR-INTEGRATION.md) | Connecting OpenClaw/Noir Discord bots to Pharos |
| [PRODUCT.md](./PRODUCT.md) | Product definition, architecture, roadmap, competitive analysis |
| [config/pharos.default.yaml](./config/pharos.default.yaml) | Full configuration reference with all defaults |

---

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Live HTML dashboard (auto-refresh) |
| `POST /v1/chat/completions` | Main routing endpoint (OpenAI-compatible) |
| `GET /v1/models` | List available models |
| `GET /v1/stats` | Cost tracking and savings |
| `GET /v1/stats/recent` | Last 25 requests |
| `GET /health` | Health check with provider status |

---

Built by [Nex Labs](https://github.com/GhostSpeculates)

*Named after the [Lighthouse of Alexandria](https://en.wikipedia.org/wiki/Lighthouse_of_Alexandria) — one of the Seven Wonders of the Ancient World. For centuries, the Pharos guided every ship safely through dangerous waters to the right port. Today, Pharos guides every AI query to the right model.*
