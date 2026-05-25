# PHAROS — Map

LLM routing gateway. Internal backbone for NEX-LABS agents and NOIR scripts. Not a product (do NOT pitch externally — competes with OpenRouter, Vercel AI Gateway, Portkey, LiteLLM).

## Boot order

1. `CLAUDE.md` — architecture, commands, deployment (110 lines)
2. `docs/REFERENCE.md` — long-form (file layout, security, dev notes, tests, alerts, roadmap, stats)
3. `~/knowledge/INDEX.md` + `~/knowledge/tags/pharos.md` — knowledge base (auto-loaded via CLAUDE.md block)

## Top-level dirs

| Dir | Purpose |
|---|---|
| `src/` | All runtime TypeScript. Module map in CLAUDE.md. Full file layout in `docs/REFERENCE.md`. |
| `config/` | YAML config. Defaults: `pharos.default.yaml`. User overrides: `pharos.yaml` (gitignored). |
| `data/` | SQLite DB (`pharos.db`). Auto-migrates new columns. |
| `dist/` | Compiled output (`npm run build`). |
| `docs/` | Long-form reference + design docs (CONTRACT, GETTING_STARTED, NOIR-INTEGRATION, QUICKSTART, README, session handoffs). |
| `scripts/` | Build/deploy helpers. |

## Where things go

| Need | Path |
|---|---|
| Add a new provider | `src/providers/<name>.ts`, extend `LLMProvider` base, register in `src/providers/index.ts` |
| Change tier logic | `src/router/tier-resolver.ts` + tests in `src/__tests__/` |
| Add a route | `src/gateway/router.ts` + schema in `src/gateway/schemas/` |
| Change classifier | `src/classifier/` (failover chain config in `pharos.default.yaml`) |
| Change pricing | `src/tracking/cost-calculator.ts` |

## Critical runtime facts (don't relearn each session)

- Port: 3777 (localhost only)
- Auth: Bearer `PHAROS_API_KEY` env var
- Classifier failover: Moonshot kimi-latest → Groq llama-3.3 → xAI grok-3-mini-fast → static fallback
- Max tokens cap: 1536 (cost protection — don't bypass)
- Provider count: 10 cloud (Anthropic, Google, OpenAI, DeepSeek, Groq, Mistral, xAI, Moonshot, Together AI, Fireworks AI). Plus OpenRouter added April 30.
- Active agents in production: marketing-agent, openclaw, noir-prime, sentinel, quant, lens, prospector, `_default`
- Service: `com.pharos.gateway` (launchd)
- DB: `~/pharos/data/pharos.db`
- Logs: `~/.openclaw/logs/pharos-stdout.log`, `pharos-stderr.log`

## Cross-project paths

| External path | Why |
|---|---|
| `~/.openclaw/logs/` | Pharos stdout/stderr log destination |
| `~/pharos/` | Deployed copy on Mac Mini (this is the dev repo) |
| `~/agents/king-tut/` | King Tut monitors Pharos health (24/7 daemon, launchd-managed) |
| `~/Library/LaunchAgents/com.pharos.gateway.plist` | Service plist |
| `pharos.nexlabs.pro` | SaaS landing page (must follow `CONTRACT.md` wire spec) |

## Roadmap state (May 2026)

- Phase 1 (Core Engine): ✅ COMPLETE Feb 25, 2026
- Phase 2 (Universal Intelligent Router): IN PROGRESS — 2A/B/C/D/E done, performance learning + auto-tuned weights TODO
- Phase 2.5 (SaaS Launch Blockers): 🚨 P0
  - Streaming + tool_use parity (known limitation in `src/translation/anthropic-stream.ts`)
  - ✅ Wallet (Stripe Checkout, webhook, idempotent topup, signup-on-first-payment)
- Phase 3 (Dashboard): NOT STARTED
- Phase 4 (Distribution): NOT STARTED

Details in `docs/REFERENCE.md` § Roadmap.

## Don't

- Don't pitch externally — internal backbone only
- Don't bypass `max_tokens` cap (1536)
- Don't commit `.env`
- Don't change conversation tier floor logic without re-running `src/router/conversation-tracker.ts` tests
