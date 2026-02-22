<p align="center">
  <h1 align="center">⚡ PHAROS</h1>
  <p align="center"><em>The Lighthouse for Intelligent AI Routing</em></p>
  <p align="center">
    <strong>Save 85-95% on LLM costs without sacrificing quality.</strong><br/>
    Pharos intelligently routes every AI query to the optimal model — from free tiers to frontier models like Claude Opus — ensuring you only pay for power when you truly need it.
  </p>
</p>

---

## What is Pharos?

Pharos is an **intelligent LLM routing gateway** — a service that sits between your AI application (OpenClaw, ElizaOS, custom bots, any OpenAI-compatible client) and the model providers (Anthropic, Google, DeepSeek, Groq, Mistral, OpenAI, and more).

Instead of sending every query to an expensive frontier model, Pharos **classifies each query in real-time** and routes it to the optimal model from a tiered pool of providers:

- **Tier 1 — Free**: Simple queries, status checks, routine tasks → Gemini Flash, Groq free tier
- **Tier 2 — Economical**: Analysis, planning, moderate reasoning → DeepSeek V3, Mistral, Groq paid
- **Tier 3 — Premium**: Complex strategy, creative work, multi-step reasoning → Claude Sonnet, GPT-4o
- **Tier 4 — Frontier**: The hardest problems that genuinely need the best → Claude Opus, Gemini Pro

The result: **~70% of queries cost $0, ~25% cost fractions of a penny, and only ~5% hit premium models** — with essentially identical quality to running everything on Sonnet.

## The Problem

Running AI assistants (OpenClaw, Discord bots, autonomous agents) on frontier models costs $60-240+/month. Most of those queries don't need a $15/million-token model. But downgrading everything to a cheap model strips the power that makes AI assistants actually useful.

**There's no middle ground** — until Pharos.

## How It Works

```
Your App  →  Pharos Gateway  →  Query Classifier  →  Optimal Model
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                  ▼
              Free Models      Cheap Models       Premium Models
            (Gemini, Groq)   (DeepSeek, Mistral)  (Sonnet, Opus)
```

1. **Drop-in replacement**: Pharos exposes an OpenAI-compatible API. Change one URL and you're routed.
2. **Real-time classification**: A lightweight classifier (runs on free-tier Gemini Flash) scores query complexity (1-10).
3. **Smart routing**: Based on the score, Pharos routes to the cheapest model that can handle the query well.
4. **Semantic caching**: Repeated/similar queries get cached responses — zero cost, instant response.
5. **Automatic failover**: If a provider is down, Pharos cascades to the next available model.
6. **Full observability**: Dashboard showing costs, model usage, savings, and query breakdowns.

## Key Features

- 🔌 **OpenAI-compatible API** — Works with anything that speaks OpenAI format
- 🧠 **Intelligent classification** — Not rule-based; uses AI to understand query complexity
- 💰 **Multi-provider routing** — Anthropic, Google, DeepSeek, Groq, Mistral, OpenAI, Cohere, Fireworks
- 🏗️ **Tiered model pools** — Configure your own tiers and cost/quality preferences
- 🔄 **Automatic failover** — Provider down? Seamless cascade to next best option
- 📊 **Cost dashboard** — See exactly how much Pharos saved you
- 🗄️ **Semantic caching** — Similar queries return cached responses (68-90% hit rate for recurring patterns)
- 🔐 **API key management** — One place for all your provider keys
- ⚙️ **Configurable thresholds** — Tune the quality/cost tradeoff to your preference
- 🌐 **Self-hostable** — Runs on your own VPS (2GB+ RAM, no GPU needed)

## Who Is This For?

- **OpenClaw / ElizaOS users** burning through API credits
- **Discord bot operators** paying too much for AI responses
- **Indie developers** building AI-powered products on a budget
- **Small businesses** using AI assistants for operations
- **Anyone** who wants frontier AI quality at 95% less cost

## Tech Stack

- **Runtime**: Node.js / TypeScript
- **Proxy layer**: OpenAI-compatible HTTP server
- **Classifier**: Gemini Flash (free tier) for query scoring
- **Caching**: Redis + vector embeddings for semantic cache
- **Dashboard**: Web UI for monitoring and configuration
- **Config**: YAML/JSON for provider and tier configuration

## Project Status

🚧 **In Development** — Built by [Nex Labs](https://github.com/GhostSpeculates)

---

*Named after the [Lighthouse of Alexandria](https://en.wikipedia.org/wiki/Lighthouse_of_Alexandria) — one of the Seven Wonders of the Ancient World. For centuries, the Pharos guided every ship safely through dangerous waters to the right port. Today, Pharos guides every AI query to the right model.*
