---
tags: [pharos, routing, cost-optimization, architecture, standalone]
---

# Pharos Gateway

## What It Does

Pharos is a **standalone LLM routing gateway** at `localhost:3777` on the Mac Mini. It classifies query complexity (1-10) via Gemini Flash and routes to the cheapest model that can handle it.

**Key change**: Pharos is now **decoupled from Noir**. It's its own product. Noir (Claude Code) runs on Claude Max flat-rate billing, so it doesn't need Pharos for routing. Pharos is used for:
- Handling non-Ghost Discord messages (via the listener bot)
- Cheap sub-tasks that don't need Claude Code's full brain
- As a standalone product Ghost is developing

## How It Works

```
Query comes in
    |
Gemini Flash (free) scores complexity 1-10
    |
Pharos routes to the cheapest tier that fits
    |
Answer comes back
```

## The Tiers

| Tier | Score | Models | Cost |
|------|-------|--------|------|
| **Local** | 1-3 | Ollama Qwen 2.5 7B (on Mac Mini) | $0 |
| **Free** | 1-3 | Gemini Flash, Groq Llama | $0 |
| **Economical** | 4-6 | DeepSeek, Mistral | Pennies |
| **Premium** | 7-8 | Claude Sonnet 4.6, GPT-4o | Moderate |
| **Frontier** | 9-10 | Claude Opus, O3 | Expensive (rare) |

Most queries land in the Free/Economical tiers. Frontier is almost never used.

## Quick Commands

> [!example] Pharos Health Check
> ```bash
> # Check if Pharos is running
> curl http://localhost:3777/health
>
> # See cost stats and savings
> curl http://localhost:3777/v1/stats
> ```

## Key Files on Mac Mini

| File | Path |
|------|------|
| Root directory | `~/pharos/` |
| Config | `~/pharos/config/pharos.default.yaml` |
| Environment vars | `~/pharos/.env` |
| Database | `~/pharos/data/pharos.db` |

## How Noir Uses Pharos (Optional)

Noir (Claude Code) doesn't route through Pharos for its own tasks -- it runs on Claude Max. But Noir can offload cheap sub-tasks to Pharos:

```bash
curl -s http://localhost:3777/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"pharos-auto","messages":[{"role":"user","content":"FORMAT THIS DATA: ..."}],"max_tokens":512}'
```

The Discord Listener Bot routes non-Ghost messages through Pharos automatically, so random Discord users don't burn Claude Max credits.

## Related Notes
- [[System Overview]] -- How the whole system fits together
- [[Agent Roster]] -- Domain labels
- [[Mac Mini]] -- Where Pharos runs
