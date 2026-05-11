# PHAROS

**The inference layer for AI agents that don't sleep.**

```
INFERENCE GATEWAY  ·  SIX MODALITIES  ·  50+ MODELS  ·  OPENAI-COMPAT
```

Pharos is a drop-in inference router. Point your agent at it, and every query
gets scored 1–10 in real time and shipped to the cheapest model that can
actually handle it. `hello world` doesn't go to Opus. A 200-step strategy plan
doesn't go to Llama. Result: **70–90% lower bills with the same answers.**

```
PHAROS-NEXLABS.FLY.DEV  ·  LIVE  ·  30% OVER UPSTREAM  ·  $5 MINIMUM TOP-UP
```

---

## Why this exists

Every modern agent (Claude SDK, OpenAI Agents, OpenClaw, Lindy, your own thing)
defaults to the same expensive model for every call — including the dumb ones.
That's how a Discord bot burns $400 in a weekend. Pharos sits in front of your
inference, classifies the query, and routes accordingly. You wire it up once,
you stop overpaying forever.

Built because I (Ghost / Nex Labs) was burning credits on agents that didn't
need frontier-tier intelligence to answer "ok." If you've seen the same bill,
you already know.

---

## Use it

**Hosted** → [pharos.nexlabs.pro](https://pharos.nexlabs.pro). Pay $5+, get a
key in your inbox, change one base URL, ship.

```bash
curl https://pharos-nexlabs.fly.dev/v1/chat/completions \
  -H "Authorization: Bearer pharos-..." \
  -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"hello"}]}'
```

That's the whole integration. Anything that speaks OpenAI or Anthropic format
works.

**Self-host** → MIT licensed. Bring your own provider keys, run on your box,
keep the savings.

```bash
git clone https://github.com/GhostSpeculates/PHAROS.git
cd PHAROS && npm install
cp .env.example .env   # add at minimum GROQ_API_KEY
npm run dev
```

Full setup: [GETTING_STARTED.md](./GETTING_STARTED.md)

---

## How it routes

A lightweight classifier (Kimi by default, with Groq + xAI as fallbacks) scores
each query 1–10. The score picks a tier. The tier picks a model.

| Score | Tier | Sample models | What it's for |
|:-----:|------|--------------|---------------|
| 1–3 | Free | Groq Llama 3.3, Gemini Flash | Greetings, lookups, simple replies |
| 4–6 | Economical | DeepSeek V3, Kimi K2, GPT-4o mini | Analysis, planning, moderate reasoning |
| 7–8 | Premium | Claude Sonnet, GPT-4o | Strategy, creative, multi-step |
| 9–10 | Frontier | Claude Opus | Genuinely hard problems |

If a provider goes down mid-request, Pharos cascades to the next available
model in the same tier. If the classifier goes down, it falls back to a static
tier score so traffic keeps flowing.

```
client  ──►  Pharos  ──►  classifier  ──►  tier  ──►  provider
                              │
                              └─ Kimi → Groq → xAI → static fallback
```

---

## What's in the box

- **12 providers** — Anthropic, Google, OpenAI, DeepSeek, Groq, Mistral,
  Moonshot, Together AI, Fireworks AI, OpenRouter, xAI (optional), local
- **Six modalities** — chat, embeddings, images, video, TTS, STT
- **OpenAI + Anthropic shape** — `/v1/chat/completions` and `/v1/messages`
  both work; streaming on both
- **Tool-use parity** — tool calls survive routing across providers
- **Wallet** — pay-as-you-go credits, Stripe Checkout, OpenRouter-shape
  `/v1/credits`
- **Live dashboard** at `/` — costs, savings, model usage, provider health
- **Sentry error capture** + structured Pino logs
- **Self-host or SaaS** — same code, your call

---

## API

| Endpoint | Notes |
|----------|-------|
| `POST /v1/chat/completions` | OpenAI shape, streaming, tool use |
| `POST /v1/messages` | Anthropic shape, Claude Agent SDK compatible |
| `POST /v1/embeddings` | Embedding routing |
| `POST /v1/images/generations` | Image generation, quality-tier routing |
| `POST /v1/videos/generations` | Async video gen, returns job id |
| `POST /v1/audio/speech` | TTS |
| `POST /v1/audio/transcriptions` | STT |
| `GET /v1/models` | Model catalog |
| `GET /v1/credits` | Balance (OpenRouter-shape, Bearer auth) |
| `GET /wallet/me` | Full user record (Bearer auth) |
| `POST /wallet/topup` | Buy more credits (Bearer auth) |
| `POST /wallet/checkout` | Public signup or returning top-up |
| `POST /webhook/stripe` | Stripe webhook receiver |
| `GET /v1/stats` | Live cost + savings JSON |
| `GET /` | HTML dashboard |
| `GET /health` | Health + provider status |

---

## Stack

Node 20+ · TypeScript (ESM) · Fastify 5 · Zod · Vitest (1620+ tests) ·
better-sqlite3 · Pino · Stripe SDK · Resend · `@sentry/node` · YAML config
with env overrides.

Deploys on Fly.io (production), Docker Compose (local), Mac mini (dev),
or any box with Node 20.

---

## Status

**Phase 1 (core engine):** shipped. Production traffic, 87% average cost
savings vs Sonnet baseline across 17k+ requests on the prior deployment.

**Phase 2 (universal router):** mostly shipped. Provider expansion, model
registry with capabilities + pricing + speed, task-type affinity routing,
conversation-aware tier floors, prompt caching, Anthropic `/v1/messages`
endpoint, tool-use parity across providers.

**Phase 2.5 (SaaS launch):** shipped. Wallet, Stripe Checkout, Resend welcome
email, OpenRouter-shape credits API, live on `pharos.nexlabs.pro`.

**Next:** admin/recovery tooling, anomaly detector, synthetic canary, semantic
caching.

---

## Security

API keys are bearer tokens over HTTPS; only SHA-256 hashes are stored. Stripe
webhooks verify signatures and are idempotent on `stripe_event_id`. Rate
limits per IP and per agent. CORS allowlisted. Spending caps with 80%/100%
alerts. SQLite on a persistent Fly volume, with Fly snapshots.

If you find something, open an issue with `security:` prefix or DM me on
GitHub.

---

## License

MIT. Use it. Fork it. Self-host it. Ship something.

---

Built by [Ghost / Nex Labs](https://github.com/GhostSpeculates). The name
comes from the [Lighthouse of Alexandria](https://en.wikipedia.org/wiki/Lighthouse_of_Alexandria) —
for centuries it guided every ship through dark water to the right port.
That's the job here, just for tokens.
