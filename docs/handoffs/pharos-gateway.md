# Pharos Gateway — Reference

> **Status**: Phase 1 COMPLETE + HARDENED | **Mac Mini**: `localhost:3777` | **Repo**: `c:\Users\ruben\OneDrive\Desktop\PHAROS`

## What It Is

Pharos is an intelligent LLM routing gateway. It sits between OpenClaw (Noir) and model providers, classifying each query's complexity in real-time and routing to the cheapest model that can handle it well. **Saves 83-95% on LLM costs.**

```
Noir Agent → OpenClaw → Pharos (localhost:3777) → Classifier → Optimal Provider
                                    |
                    Free / Economical / Premium / Frontier
```

## Tier Routing

| Tier | Score | Models | Cost |
|------|-------|--------|------|
| Free | 1-3 | Gemini Flash, Groq Llama 3.3 | ~$0 |
| Economical | 4-6 | DeepSeek, Mistral, Groq | ~$0.0002/req |
| Premium | 7-8 | Claude Sonnet, GPT-4o, Gemini Pro | ~$0.003/req |
| Frontier | 9-10 | Claude Opus, O3 | ~$0.02/req |

## Integration with Noir (LIVE)

Agents using `openai/pharos-auto` as their model route through Pharos. OpenClaw's `openai` provider points to `http://localhost:3777/v1`.

| Agent | Model | Status |
|-------|-------|--------|
| noir | pharos-auto | ✅ routed via Pharos |
| nexus | pharos-auto | ✅ routed via Pharos |
| essence | pharos-auto | ✅ routed via Pharos |
| lens | pharos-auto | ✅ routed via Pharos |
| edge | pharos-auto | ✅ routed via Pharos |
| sentinel | pharos-auto | ✅ routed via Pharos |
| vault | pharos-auto | ✅ routed via Pharos |

## Key Paths (Mac Mini)

| Resource | Path |
|----------|------|
| Pharos project | `~/pharos/` |
| Pharos config | `~/pharos/config/pharos.default.yaml` |
| Pharos env | `~/pharos/.env` |
| Pharos DB | `~/pharos/data/pharos.db` |
| Pharos service | `launchctl kickstart -k gui/$(id -u)/com.pharos.gateway` |
| Pharos logs | `tail -f ~/pharos/logs/pharos.log` |
| Integration guide | `PHAROS/NOIR-INTEGRATION.md` |

## Key Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /v1/chat/completions` | Main routing (OpenAI-compatible) |
| `GET /v1/models` | List available models |
| `GET /v1/stats` | Cost tracking + savings |
| `GET /health` | Health check (unauthenticated) |

## Response Headers

Every response includes: `X-Pharos-Tier`, `X-Pharos-Model`, `X-Pharos-Score`, `X-Pharos-Cost`, `X-Pharos-Request-Id`

## Tech Stack

Node.js 20+ / TypeScript / Fastify 5 / Zod / SQLite / Vitest (95 tests passing)

## Cost Projections

| Metric | Before Pharos | After Pharos |
|--------|---------------|--------------|
| Daily | ~$9.00 | ~$0.50-1.50 |
| Monthly | ~$270 | ~$15-45 |
| Savings | — | **83-95%** |

## Roadmap

- **Phase 1**: ✅ Core Engine — routing, classification, multi-provider, failover, tracking, security, tests
- **Phase 2**: ❌ Intelligence — semantic caching, conversation-aware routing, prompt caching
- **Phase 3**: ❌ Dashboard — web UI, config UI, real-time feed
- **Phase 4**: ❌ Distribution — npm package, Docker, docs site

## Rollback

```bash
cp ~/.openclaw/openclaw.json.backup.YYYYMMDD ~/.openclaw/openclaw.json
launchctl kickstart -k gui/$(id -u)/com.openclaw.agent
```

## Monitoring

```bash
# SSH tunnel for dashboard (from Windows/remote)
ssh -L 3777:localhost:3777 ghostfx@192.168.1.148
# Then open http://localhost:3777

# Stats API (on Mac Mini)
curl -H "Authorization: Bearer <key>" http://localhost:3777/v1/stats
```
