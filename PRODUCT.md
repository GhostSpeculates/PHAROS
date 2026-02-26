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
- Lightweight AI classifier (Moonshot/Kimi — cheap, good quality)
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
- 8 configured providers: Anthropic, Google, OpenAI, DeepSeek, Groq, Mistral, xAI, Moonshot
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

### Phase 1: Core Engine — IN PROGRESS

**Status: ✅ COMPLETE — Declared by Ghost on Feb 25, 2026. 918 tests, 73.4% cost savings, 0% error rate, 8 providers, stress tested 35/35. Phase 2 now in progress.**

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

#### Production Stats (Feb 25, 2026 — cumulative since launch)

| Metric | Value |
|--------|-------|
| Total requests processed | 201 |
| Total cost | $1.9258 |
| Baseline cost (all-Sonnet) | $7.2421 |
| **Total savings** | **$5.3163** |
| **Savings percentage** | **73.4%** |
| Providers active | 8 (Anthropic, Google, OpenAI, DeepSeek, Groq, Mistral, xAI, Moonshot) |
| Error rate | 0.0% |
| Classifier providers | Groq (106), unknown (87), Moonshot (7), fallback (1) |

#### Tier Breakdown

| Tier | Requests | Cost | Avg Cost/Req |
|------|----------|------|-------------|
| Free | 142 (70.6%) | $0.5166 | $0.0036 |
| Economical | 25 (12.4%) | $0.0115 | $0.0005 |
| Premium | 24 (11.9%) | $1.3594 | $0.0566 |
| Frontier | 10 (5.0%) | $0.0383 | $0.0038 |

#### Provider Breakdown

| Provider | Requests |
|----------|----------|
| Google | 107 |
| Groq | 38 |
| Anthropic | 32 |
| DeepSeek | 16 |
| Moonshot | 6 |
| OpenAI | 2 |

#### Key Observations
- 73.4% cost savings vs all-Sonnet baseline across 201 real-world requests
- 70.6% of traffic routes to free tier — classifier accurately identifies simple queries
- Frontier traffic at 5.0% (down from 6.3% after prompt tuning)
- Zero errors across entire request history
- Google (Gemini Flash) handles bulk of free-tier traffic, especially large-context requests
- Classifier primary switched to Moonshot (separates classifier budget from Groq routing budget)

### Phase 2: Universal Intelligent Model Router — THE GAME CHANGER

> **Vision**: Pharos becomes the first open-source tool that gives you native access to 300+ AI models across every major platform — and *automatically picks the best one for every query*. No other tool does this. OpenRouter is a dumb proxy. LiteLLM is a dumb proxy. Pharos is the brain.

#### 2A. Multi-Platform Provider Expansion
- [ ] **Together AI** integration (200+ models — Llama, Mixtral, Qwen, CodeLlama, StripedHyena)
- [ ] **Fireworks AI** integration (100+ models — fastest open-source inference)
- [ ] **HuggingFace Inference API** integration (100+ models — largest open-source hub)
- [ ] **Cerebras** integration (fastest inference hardware — Llama at 2000 tok/s)
- [ ] **Lambda Labs** integration (research-grade GPU inference)
- [ ] All use OpenAI-compatible APIs — Pharos already supports the protocol, just needs config + API keys
- [ ] Single env var per platform: `TOGETHER_API_KEY`, `FIREWORKS_API_KEY`, etc.

#### 2B. Universal Model Registry
- [ ] **Model database** — every model across every platform with: name, provider(s), context window, strengths, pricing, speed benchmarks
- [ ] **Auto-discovery** — query each platform's `/v1/models` endpoint on startup to know what's available
- [ ] **Multi-host awareness** — same model (e.g., Llama 3.3 70B) available on Groq, Together, Fireworks → Pharos picks the cheapest/fastest one that's healthy
- [ ] **Live pricing sync** — pull current pricing from provider APIs, not hardcoded
- [ ] **Model capability tags** — code, math, reasoning, creative, multilingual, vision, long-context

#### 2C. Task-Type-Aware Routing (Beyond Complexity Scoring)
- [ ] Classifier v2: score complexity (1-10) AND classify task type (code, math, reasoning, creative, analysis, conversation)
- [ ] **Model-task affinity matrix** — which models excel at which tasks:
  - Code → DeepSeek Coder, CodeLlama, Claude Sonnet
  - Math → Qwen-Math, Claude, GPT-4o
  - Reasoning → o1, Claude Opus, Qwen-72B
  - Creative writing → Claude, Gemini, Llama
  - Fast conversation → Groq/Llama, Gemini Flash
  - Multilingual → Qwen, Gemini, GPT-4o
- [ ] Route by (complexity × task_type) → optimal model, not just cheapest model in tier
- [ ] User can override: `"model": "pharos-code"` forces code-optimized routing

#### 2D. Intelligent Caching
- [ ] **Semantic cache** — embed queries, find similar past requests, serve cached responses for near-duplicates
- [ ] **Conversation-aware routing** — inherit tier across a conversation (don't reclassify every message)
- [ ] **Prompt caching** — leverage Anthropic and Google's native prompt caching for system prompts

#### 2E. Performance Learning
- [ ] **Track response quality signals** — latency, token usage, user follow-ups (did they re-ask = bad answer)
- [ ] **Model leaderboard** — per-task-type success rates: "DeepSeek wins 78% of code tasks, Claude wins 92% of reasoning tasks"
- [ ] **Auto-tune routing weights** — models that perform well get more traffic, underperformers get deprioritized
- [ ] **A/B routing** — occasionally route same query to two models, compare results to improve the affinity matrix

#### Why This Is Revolutionary

| Feature | OpenRouter | LiteLLM | RouteLLM | **Pharos v2** |
|---------|-----------|---------|----------|---------------|
| Multi-provider access | ✅ | ✅ | ❌ | ✅ |
| AI-powered model selection | ❌ | ❌ | Binary only | **Task-type aware** |
| Performance learning | ❌ | ❌ | ❌ | **Auto-tunes** |
| Same model, best provider | ✅ (cloud) | ❌ | ❌ | **✅ (self-hosted)** |
| Free / self-hosted | ❌ ($) | ✅ | ✅ | **✅** |
| Works with 300+ models | ✅ | ✅ (manual) | ❌ | **✅ (native)** |
| Cost optimization | ❌ | ❌ | Partial | **Full stack** |

### Phase 3: Dashboard & UX
- [ ] Web dashboard (React SPA with WebSocket live updates)
- [ ] Model registry browser — search/filter all available models by capability, price, speed
- [ ] Configuration UI (drag-and-drop tier setup, model affinity tuning)
- [ ] API key management interface
- [ ] Real-time routing visualization (see decisions as they happen)
- [ ] Weekly reports (savings, model performance, routing distribution)

### Phase 4: Product & Distribution
- [ ] npm package for easy installation (`npx pharos init`)
- [ ] Docker image for one-command deployment
- [ ] OpenClaw / ElizaOS plugins for native integration
- [ ] Documentation site with interactive model catalog
- [ ] Landing page
- [ ] GitHub release + open source launch
- [ ] Community model registry contributions (users share routing configs)

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
