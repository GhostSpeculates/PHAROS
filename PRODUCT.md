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

### Layer 2: Query Classifier
- Lightweight AI classifier (Gemini Flash free tier)
- Analyzes each incoming message for:
  - **Complexity score** (1-10)
  - **Task type** (greeting, lookup, analysis, strategy, creative, code, reasoning)
  - **Required capabilities** (tool use, long context, vision, code execution)
- Classification cost: ~$0.00 (free tier)

### Layer 3: Semantic Cache
- Vector embedding of query → similarity search against cache
- Cache hit (>0.92 similarity) → return stored response instantly
- Cache miss → route to model, cache the response
- Expected hit rate: 30-70% for recurring agent workflows (crons, heartbeats)

### Layer 4: Model Router
- Maps complexity score + task type → optimal model from configured pool
- Considers: cost, latency, quality score, provider health, rate limits
- Automatic failover chain if primary model unavailable

### Layer 5: Provider Pool
- All configured API providers with their models, keys, and pricing
- Health monitoring (latency, error rates, availability)
- Dynamic cost tracking (bill accumulation per provider)

### Layer 6: Observability Dashboard
- Real-time cost tracking and savings calculation
- Query volume by tier/model/provider
- Classification accuracy monitoring
- Cache hit rate visualization
- Daily/weekly/monthly spend reports

---

## Routing Logic (The Brain)

### Complexity Classification Prompt (v0.1)
```
You are a query complexity classifier. Score the following user message 
from 1-10 based on how complex an AI model is needed to answer well.

Scoring guide:
1-2: Greetings, acknowledgments, simple yes/no, status checks
3-4: Factual lookups, simple summaries, formatting, basic questions
5-6: Analysis, comparisons, moderate planning, code review
7-8: Multi-step reasoning, creative writing, complex code generation
9-10: PhD-level analysis, novel strategy, Opus-tier reasoning

Also classify the task type: greeting | lookup | analysis | planning | 
creative | code | reasoning | tool_use

Respond ONLY as JSON: {"score": N, "type": "..."}
```

### Tier Mapping (Default Configuration)
```yaml
tiers:
  free:
    score_range: [1, 3]
    models:
      - provider: google
        model: gemini-2.0-flash
      - provider: groq
        model: llama-3.3-70b-versatile
    
  economical:
    score_range: [4, 6]
    models:
      - provider: deepseek
        model: deepseek-chat
      - provider: mistral
        model: mistral-large-latest
      - provider: groq
        model: llama-3.3-70b-versatile
    
  premium:
    score_range: [7, 8]
    models:
      - provider: anthropic
        model: claude-sonnet-4-20250514
      - provider: openai
        model: gpt-4o
      - provider: google
        model: gemini-2.5-pro
    
  frontier:
    score_range: [9, 10]
    models:
      - provider: anthropic
        model: claude-opus-4-20250514
      - provider: openai
        model: o3
      - provider: anthropic
        model: claude-sonnet-4-20250514
```

---

## Development Roadmap

### Phase 1: Core Engine (MVP)
- [ ] Project scaffolding (Node.js/TypeScript)
- [ ] OpenAI-compatible API server
- [ ] Query classifier (Gemini Flash)
- [ ] Basic tier routing (4 tiers)
- [ ] Multi-provider support (Anthropic, Google, DeepSeek, Groq)
- [ ] YAML configuration system
- [ ] Basic logging and cost tracking
- [ ] CLI for setup and management
- **Milestone**: Pharos routes Noir's traffic, saving 85%+ on Anthropic spend

### Phase 2: Intelligence Layer
- [ ] Semantic caching (Redis + embeddings)
- [ ] Conversation-aware routing (inherit tier across conversation)
- [ ] Channel/context-aware routing (Nex Labs channels get higher default)
- [ ] Provider health monitoring and auto-failover
- [ ] Classification accuracy feedback loop
- [ ] Prompt caching integration (Anthropic, Google)

### Phase 3: Dashboard & UX
- [ ] Web dashboard (cost tracking, savings visualization)
- [ ] Configuration UI (drag-and-drop tier setup)
- [ ] API key management interface
- [ ] Real-time query feed with routing decisions
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
| Semantic caching | ✅ | ❌ | ✅ | ✅ |
| Consumer-friendly setup | ✅ | ❌ | ❌ | ✅ |
| Self-hostable | ✅ | ✅ | ✅ | ❌ |
| Web dashboard | ✅ | ❌ | ✅ | ✅ |
| OpenClaw integration | ✅ | ❌ | ❌ | ❌ |
| Frontier model access | ✅ | ✅ | ✅ | ✅ |
| Free to use | ✅ | ✅ | ✅ | ❌ |
| Channel-aware routing | ✅ | ❌ | ❌ | ❌ |

---

## Name Origin
> *The Lighthouse of Alexandria (Pharos) — one of the Seven Wonders of the Ancient World. Built circa 280 BC on the island of Pharos off the coast of Alexandria, Egypt. For nearly a thousand years it guided every ship through dangerous waters to the right port. At 100+ meters tall, it was among the tallest structures in the world.*
>
> *Today, **Pharos** guides every AI query through the noise to the right model.*

## Built By
**Nex Labs** — [@GhostSpeculates](https://github.com/GhostSpeculates)
