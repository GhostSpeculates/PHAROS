# Pharos — Product Definition

## Vision
An intelligent LLM routing gateway that makes AI affordable for everyone without compromising quality. Pharos ensures frontier models like Claude Opus are available when genuinely needed, while routing routine queries to free or ultra-cheap alternatives automatically.

## Core Value Proposition
> "Use Opus when you need Opus. Pay $0 when you don't."

Users running AI assistants (OpenClaw, ElizaOS, custom bots) currently face a binary choice:
1. Use expensive frontier models for everything → $60-240+/month
2. Downgrade to cheap models → lose the intelligence that makes AI useful

Pharos eliminates this tradeoff with real-time intelligent routing.

## Target Audience (Priority Order)
1. **OpenClaw / ElizaOS operators** — Self-hosters running AI agents on VPS
2. **Discord bot builders** — AI-powered bots burning through API credits
3. **Indie AI developers** — Building products on top of LLM APIs
4. **Small business AI users** — Using AI assistants for operations
5. **Enterprise teams** — Managing multi-model AI infrastructure

## Product Tiers (Pharos itself)
- **Open Source (Self-Hosted)** — Free forever, run on your own infra
- **Pharos Cloud (Future)** — Managed hosted version with dashboard, SaaS pricing

---

## Architecture Overview

### Layer 1: API Gateway
- OpenAI-compatible HTTP endpoint (`/v1/chat/completions`)
- Drop-in replacement: change `base_url` and you're routed
- Handles auth, rate limiting, request queuing
- Extended thinking passthrough for Anthropic models

### Layer 2: Query Classifier
- Lightweight AI classifier (Groq/Llama 3.3 70B — fast, cheap)
- Analyzes each incoming message for:
  - **Complexity score** (1-10) with explicit per-score guidelines
  - **Task type** (greeting, lookup, analysis, planning, creative, code, reasoning)
- Classification cost: ~$0.0001/request
- Median classification latency: ~230ms

### Layer 3: Model Router
- Maps complexity score + task type → optimal model from configured pool
- Pre-flight context size filtering (skips providers that can't handle large requests)
- Automatic failover chain if primary model unavailable
- Context-size-aware provider health (oversized errors don't damage health scores)

### Layer 4: Provider Pool
- 6 active providers: Anthropic, Google, OpenAI, DeepSeek, Groq, xAI
- Per-provider health monitoring (consecutive errors, cooldown recovery)
- Rolling latency tracking (50-sample window, baseline degradation alerts)
- Dynamic cost tracking per provider

### Layer 5: Observability Dashboard
- Real-time HTML dashboard at `/` with auto-refresh
- Cost tracking and savings calculation vs baseline (Sonnet)
- Request feed with score, tier, provider, model, latency, cost
- Provider health and latency status at a glance
- JSON API endpoints: `/v1/stats`, `/v1/stats/recent`, `/health`

---

## Routing Logic (The Brain)

### Complexity Classification
10-level scoring system with explicit guidelines per score:

| Score | Label | Example | Routes To |
|-------|-------|---------|-----------|
| 1-2 | Trivial | "hi", "thanks", "what time is it?" | Free tier |
| 3 | Simple | "what's the capital of France?" | Free tier |
| 4-5 | Moderate | "explain HTTPS encryption", "compare React vs Vue" | Economical |
| 6 | Detailed | "design patterns in software engineering" | Economical |
| 7 | Complex | "build a REST API with auth and pagination" | Premium |
| 8 | Advanced | "design a distributed cache with consistency" | Premium |
| 9 | Frontier (rare) | "formal verification of concurrent lock-free structures" | Frontier |
| 10 | Exceptional (extremely rare) | "novel theoretical framework unifying RL and category theory" | Frontier |

Critical rules: 90% of complex tasks score 7-8. Long prompts don't automatically mean high scores. Score 9-10 reserved for genuinely frontier-level work.

### Tier Configuration (Production)
```yaml
tiers:
  free:          # Score 1-3
    - groq/llama-3.3-70b-versatile
    - google/gemini-2.5-flash
  economical:    # Score 4-6
    - deepseek/deepseek-chat
    - groq/llama-3.3-70b-versatile
    - openai/gpt-4o
  premium:       # Score 7-8
    - anthropic/claude-sonnet-4-20250514
    - openai/gpt-4o
  frontier:      # Score 9-10
    - anthropic/claude-opus-4-20250514
    - anthropic/claude-sonnet-4-20250514
    - openai/gpt-4o
```

---

## Development Roadmap

### Phase 1: Core Engine — COMPLETE, BATTLE-TESTED

**Status: Deployed to production, routing live traffic from OpenClaw/Noir agents on Discord.**

- [x] Project scaffolding (Node.js/TypeScript, Fastify)
- [x] OpenAI-compatible API server with streaming support
- [x] Query classifier (Groq/Llama 3.3 70B, ~230ms median)
- [x] 4-tier routing (free, economical, premium, frontier)
- [x] Multi-provider support (Anthropic, Google, OpenAI, DeepSeek, Groq, xAI)
- [x] YAML configuration system with env-var API keys
- [x] Cost tracking with SQLite (auto-cleanup of records >30 days)
- [x] Real-time HTML dashboard with provider health, latency, recent requests
- [x] Automatic failover with retry chain across providers
- [x] Pre-flight context size filtering (skips providers with insufficient context windows)
- [x] Context-size errors don't damage provider health scores
- [x] Extended thinking passthrough for Anthropic models
- [x] Per-provider rolling latency tracking with degradation alerts
- [x] Production hardening:
  - [x] Graceful shutdown (drains in-flight requests, 15s timeout)
  - [x] Process-level unhandledRejection / uncaughtException handlers
  - [x] Client disconnect detection during streaming (no writes to dead sockets)
  - [x] Safe SSE write helpers with connection state checks
  - [x] Localhost-only binding (127.0.0.1, not exposed to internet)
  - [x] UFW firewall (SSH only)
  - [x] SSH key-only authentication

#### Production Stats (Feb 22, 2026 — first day of live traffic)

| Metric | Value |
|--------|-------|
| Total requests processed | 53 |
| Total cost | $0.2384 |
| Baseline cost (all-Sonnet) | $0.5197 |
| **Total savings** | **$0.2813** |
| **Savings percentage** | **54.1%** |
| Providers active | 6 (Anthropic, Google, OpenAI, DeepSeek, Groq, xAI) |
| Provider health | All 6 healthy, 0 consecutive errors |
| Memory usage | 55 MB (peak 66 MB) |
| Database size | 36 KB |
| Errors since hardened deploy | 0 |
| VPS uptime | 16 days |

#### Tier Breakdown

| Tier | Requests | Cost | Avg Cost/Req |
|------|----------|------|-------------|
| Free | 24 (45%) | $0.1158 | $0.0048 |
| Economical | 13 (25%) | $0.0008 | $0.0001 |
| Premium | 6 (11%) | $0.0835 | $0.0139 |
| Frontier | 10 (19%) | $0.0383 | $0.0038 |

#### Provider Breakdown

| Provider | Requests | Cost |
|----------|----------|------|
| Groq | 22 | $0.0009 |
| Anthropic | 15 | $0.1120 |
| DeepSeek | 13 | $0.0008 |
| Google | 2 | $0.1148 |
| OpenAI | 1 | $0.0098 |

#### Key Observations
- Classifier accuracy is excellent: greetings/simple queries → free tier, moderate analysis → economical, complex code/architecture → premium, PhD-level research → frontier
- Pre-flight context filtering eliminated the cascade failure where 200K+ token requests bounced through all providers — now routes directly to Gemini Flash (1M context)
- 54% cost savings even with mixed real-world traffic including large context payloads
- Zero errors since production hardening deploy
- Streaming handles client disconnects gracefully — no more `ERR_HTTP_HEADERS_SENT` crashes

### Phase 2: Intelligence Layer
- [ ] Semantic caching (Redis + embeddings)
- [ ] Conversation-aware routing (inherit tier across conversation)
- [ ] Channel/context-aware routing (Nex Labs channels get higher default)
- [ ] Classification accuracy feedback loop
- [ ] Prompt caching integration (Anthropic, Google)

### Phase 3: Dashboard & UX
- [ ] Web dashboard (React SPA with WebSocket live updates)
- [ ] Configuration UI (drag-and-drop tier setup)
- [ ] API key management interface
- [ ] Weekly email reports (savings summary)

### Phase 4: Product & Distribution
- [ ] npm package for easy installation
- [ ] Docker image for one-command deployment
- [ ] OpenClaw plugin for native integration
- [ ] Documentation site
- [ ] Landing page
- [ ] GitHub release + open source launch

---

## Competitive Advantage

| Feature | Pharos | RouteLLM | LiteLLM | Requesty |
|---------|--------|----------|---------|----------|
| AI-powered classification | ✅ | ✅ | ❌ | ✅ |
| Free tier routing | ✅ | ❌ | ❌ | ❌ |
| Context-size-aware routing | ✅ | ❌ | ❌ | ❌ |
| Extended thinking passthrough | ✅ | ❌ | ❌ | ❌ |
| Consumer-friendly setup | ✅ | ❌ | ❌ | ✅ |
| Self-hostable | ✅ | ✅ | ✅ | ❌ |
| Web dashboard | ✅ | ❌ | ✅ | ✅ |
| OpenClaw integration | ✅ | ❌ | ❌ | ❌ |
| Frontier model access | ✅ | ✅ | ✅ | ✅ |
| Free to use | ✅ | ✅ | ✅ | ❌ |

---

## Name Origin
> *The Lighthouse of Alexandria (Pharos) — one of the Seven Wonders of the Ancient World. Built circa 280 BC on the island of Pharos off the coast of Alexandria, Egypt. For nearly a thousand years it guided every ship through dangerous waters to the right port. At 100+ meters tall, it was among the tallest structures in the world.*
>
> *Today, **Pharos** guides every AI query through the noise to the right model.*

## Built By
**Nex Labs** — [@GhostSpeculates](https://github.com/GhostSpeculates)
