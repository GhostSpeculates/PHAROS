# Pharos Universal Catalog — Design Spec

**Date:** 2026-05-22
**Author:** Ghost
**Status:** Draft for review
**Slice:** A (universal catalog + tier-by-price routing)
**Estimated effort:** ~1 week
**Blast radius:** registry layer + router; wallet/tracking/auth untouched

---

## 1. Problem

Pharos's model registry is a 56-entry hand-coded array in `src/registry/models.ts`. Adding a new model means editing TypeScript and redeploying. Pricing fields are placeholder zeros for several entries (e.g. Gemini Flash, Groq Llama) — current routing decisions are made on inaccurate cost data. The router maps tiers to hardcoded model names, so newly added models cannot route until additional code edits land.

Goal: every model accessible to Pharos should be auto-discovered, real-priced, and auto-eligible for tier routing.

## 2. Goals

1. New models from supported providers appear in `/v1/models` without code change.
2. Real upstream pricing replaces placeholder zeros.
3. Tier 1–10 routing buckets models by **price boundaries**, not model name.
4. Same model reachable via multiple paths (direct provider, Hugging Face, Vercel AI Gateway) → resolver picks cheapest available.
5. Pharos boots and serves even if every external `/models` endpoint is unreachable.
6. All 1120 existing tests pass post-change.

## 3. Non-goals

- Database migration (Supabase / Fly MPG) — explicitly deferred.
- Smart classifier learning which provider is cheapest per task type — Slice A2 (next spec).
- Per-app API keys, per-app budgets, webhooks — Slice C (later spec).
- Image / video / TTS / STT model auto-sync — text models only this spec.
- Provider failover policy changes — preserve current behavior.

## 4. Architecture

```
HTTP → Auth → Zod → Classifier ─→ Router (tier-by-price)
                                       ↓
                                  Registry (static ∪ dynamic)
                                       ↓
                                  Resolver (cheapest path)
                                       ↓
                                  Provider Adapter
                                       ↓
                                  Response

Catalog Sync Service (boot + 24h cron):
  Fetch /v1/models from {HF, Vercel, direct providers}
  Normalize → canonical IDs → merge → persist /data/catalog-cache.json
```

### 4.1 Components

| Component | State | Responsibility |
|---|---|---|
| Classifier | unchanged | Score request 1–10 |
| Router (`src/router/index.ts`, `tier-resolver.ts`, `failover.ts`) | **unchanged** | Continues reading `config.tiers[tierName].models[]` as today |
| **Registry** | refactored | Expose merged view: static seed ∪ dynamic sync (used for pricing/metadata lookups) |
| **Tier Populator** | new | After sync completes, regenerate in-memory `config.tiers[tierName].models[]` from merged catalog filtered by `tier_price_boundaries` |
| **Resolver** | new | Given canonical model ID, return ordered list of available provider paths (cheapest first) |
| **Catalog Sync Service** | new | Fetch + normalize + merge + persist |
| OpenAI-compat adapter | unchanged | Reused for HF + Vercel (both speak OpenAI shape) |
| Anthropic / Google adapters | unchanged | |
| Wallet / tracking / auth | unchanged | |

### 4.2 Data flow on request

1. Request hits `/v1/chat/completions`.
2. Classifier scores → tier `n`.
3. Conversation tier-floor check raises `n` if conversation requires it (unchanged).
4. Router calls `resolveTier(score, config)` → tier name (unchanged).
5. Router calls `findAvailableModel(tier, config, registry, ...)` (unchanged) — reads `config.tiers[tierName].models[]` which was populated by the tier populator at sync time.
6. Router sorts candidates by affinity + performance (unchanged) and picks one.
7. Resolver picks cheapest provider path for that canonical model (preference order: `direct > huggingface > vercel`).
8. Provider adapter sends request, streams response.

### 4.3 Data flow on boot

1. Load static seed (sync, in-memory, ~6 entries).
2. If `/data/catalog-cache.json` exists, load into runtime registry.
3. Merged registry available; HTTP server starts.
4. Async: spawn sync orchestrator.
5. Schedule recurring sync every `sync.interval_hours` (default 24).

### 4.4 Sync orchestrator

For each enabled source in parallel (5s timeout each):
1. Fetch `/v1/models` (or provider equivalent).
2. Parse → normalize into `ModelRegistryEntry` shape with canonical ID.
3. Tag `source: 'huggingface' | 'vercel' | 'direct'` + `synced_at`.

Merge step:
1. Group by canonical ID.
2. Combine `available_via` lists.
3. For pricing fields, prefer direct-source value, then HF, then Vercel.
4. Write result to `/data/catalog-cache.json` atomically (write-temp-then-rename).

Failure modes:
- All sources fail, no cache → registry uses static seed only. Sentry alert. Pharos serves.
- Some sources fail → merge succeeded ones. Pino-log per-source result.
- Corrupt cache file → log + treat as missing.
- Cron sync fails → log, do not clobber registry, retry next interval.

## 5. File-level changes

### 5.1 New files

| Path | Purpose |
|---|---|
| `src/registry/static.ts` | ~6 emergency-fallback seed entries (one per direct-key provider) |
| `src/registry/dynamic.ts` | Runtime cache structure for synced models |
| `src/registry/canonical.ts` | Normalize provider-specific IDs → canonical ID |
| `src/registry/resolver.ts` | Pick provider path for a given canonical model |
| `src/sync/index.ts` | Orchestrator entrypoint |
| `src/sync/sources/huggingface.ts` | Fetch `https://router.huggingface.co/v1/models` |
| `src/sync/sources/vercel.ts` | Fetch `https://ai-gateway.vercel.sh/v1/models` |
| `src/sync/sources/direct.ts` | Fetch model lists from direct providers that expose one: OpenAI `/v1/models`, Google `models.list`, Groq `/openai/v1/models`, Together `/v1/models`, Fireworks `/v1/models`, Mistral `/v1/models`, DeepSeek `/v1/models`. Anthropic / xAI / Moonshot have no public list endpoint → fall back to static seed entries. |
| `src/sync/cache.ts` | Atomic read/write of `/data/catalog-cache.json` |
| `src/sync/cron.ts` | `setInterval`-based scheduler |
| `src/sync/tier-populator.ts` | After sync, mutate `config.tiers[tierName].models[]` to match merged catalog filtered by `tier_price_boundaries` |
| `src/__tests__/registry/canonical.test.ts` | Canonical ID equivalence |
| `src/__tests__/registry/resolver.test.ts` | Cheapest-path + failover |
| `src/__tests__/sync/huggingface.test.ts` | Mocked HF response parse |
| `src/__tests__/sync/vercel.test.ts` | Mocked Vercel response parse |
| `src/__tests__/sync/orchestrator.test.ts` | Merge, partial failure, cache fallback |
| `src/__tests__/sync/tier-populator.test.ts` | Price-boundary filter produces correct tier model lists |
| `src/__tests__/router/snapshot.test.ts` | Pre/post-sync: same default request → same model under default config |

### 5.2 Modified files

| Path | Change |
|---|---|
| `src/registry/index.ts` | Add `getMergedRegistry()` + helpers that read from merged source. Existing helpers (`getModelCost`, `getModelSpeed`, etc.) read from merged registry too. |
| `src/registry/models.ts` | Slim from 56 entries down to a re-export of `static.ts` (6 seed entries). Existing import call sites continue working. |
| `src/providers/index.ts` | Register HF + Vercel as `openai-compat` instances |
| `config/pharos.default.yaml` | Add `sync:`, `tier_price_boundaries:`, `resolver:`, plus `huggingface` and `vercel_gateway` provider entries |
| `src/config/schema.ts` | Add Zod schemas for `sync`, `tier_price_boundaries`, `resolver` config sections |
| `src/server.ts` | Boot: call sync orchestrator post-startup, schedule cron |
| `.env.example` | Add `HUGGINGFACE_API_KEY`, `VERCEL_AI_GATEWAY_KEY` |

### 5.3 Deleted

| Path / item | Why |
|---|---|
| 50 entries of `models.ts` array | Replaced by dynamic sync; 6 emergency entries kept in `static.ts` |
| Unused capability-tag logic | Only if audit confirms unused. Otherwise leave. |

## 6. Configuration

### 6.1 Environment variables (added to `.env.example`)

```
HUGGINGFACE_API_KEY=hf_xxxxx       # optional; source skipped if absent
VERCEL_AI_GATEWAY_KEY=vck_xxxxx    # optional; source skipped if absent
```

### 6.2 `config/pharos.default.yaml`

```yaml
sync:
  enabled: true
  interval_hours: 24
  cache_file: ./data/catalog-cache.json
  sources:
    huggingface:
      enabled: true
      endpoint: https://router.huggingface.co/v1/models
    vercel:
      enabled: true
      endpoint: https://ai-gateway.vercel.sh/v1/models
    direct:
      enabled: true

tier_price_boundaries:
  free:        { tier: [1, 3], max_input_per_million: 0.10,  max_output_per_million: 0.40 }
  economical:  { tier: [4, 6], max_input_per_million: 1.00,  max_output_per_million: 4.00 }
  premium:     { tier: [7, 8], max_input_per_million: 5.00,  max_output_per_million: 20.00 }
  frontier:    { tier: [9, 10], max_input_per_million: 999,  max_output_per_million: 999 }

resolver:
  preference: [direct, huggingface, vercel]

providers:
  huggingface:
    type: openai-compat
    base_url: https://router.huggingface.co/v1
    api_key_env: HUGGINGFACE_API_KEY
    enabled_when_key_present: true
  vercel_gateway:
    type: openai-compat
    base_url: https://ai-gateway.vercel.sh/v1
    api_key_env: VERCEL_AI_GATEWAY_KEY
    enabled_when_key_present: true
```

Numeric boundaries are initial seeds; tune during build against real synced pricing data before merge.

### 6.3 Fly.io secrets

```
fly secrets set HUGGINGFACE_API_KEY=hf_xxxxx
fly secrets set VERCEL_AI_GATEWAY_KEY=vck_xxxxx
```

## 7. Testing

### 7.1 New tests (must pass)

- Canonical ID normalization: same model via Groq / Together / HF → one canonical entry.
- Resolver: prefers `direct` when key configured; falls through to `huggingface` then `vercel`.
- HF source parser: mocked response → expected normalized entries.
- Vercel source parser: same.
- Orchestrator: partial source failure → merge succeeded sources, registry healthy.
- Orchestrator: total failure + no cache → registry = static seed; alert logged.
- Orchestrator: total failure + cache present → registry = cache.
- Tier-by-price boundary mapping: tier 5 query selects model in correct price range.
- Snapshot: default-config request routes to same model pre- and post-refactor.

### 7.2 Existing tests (must stay green)

- All 1120 tests pass.

### 7.3 Verification gates before merge

1. `npm test` — all green.
2. `npm run lint` — clean.
3. `npm run build` — clean TypeScript.
4. Deploy to Fly staging environment; `GET /v1/models` returns merged catalog including HF + Vercel entries.
5. Send identical chat request to staging and main; verify same model selected under default config.
6. Remove `HUGGINGFACE_API_KEY` + `VERCEL_AI_GATEWAY_KEY` from staging; redeploy; confirm Pharos boots and serves on static seed.

### 7.4 Goal verification

Add synthetic model to mocked HF response in integration test; assert it appears in merged registry and is eligible for the tier matching its price.

## 8. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Tier boundary mis-calibration changes routing behavior unexpectedly | Medium | Snapshot test pre/post; tune boundaries during build using synced pricing; review log of "tier X → model Y" decisions in staging before flipping prod |
| HF or Vercel `/models` schema differs from expectation | Low | Mock-based unit tests; runtime Zod validation per source |
| Wallet balance debits regress | Low | Wallet code untouched; specific wallet-debit integration test included in green-bar check |
| Increased latency from sync calls on boot | Low | Sync is async post-boot; serving begins before sync completes |
| Conversation tier floor breaks when registry shape changes | Medium | Audit `conversation-tracker.ts`; surgical edit only if needed; existing tests stay green as gate |

## 9. Open questions

None blocking implementation start. Two parameters to finalize during build, using data from the first successful sync against staging:

1. Numeric tier price boundaries in `tier_price_boundaries`. Seed values in §6.2 are guesses; replace with values derived from real synced pricing.
2. Whether to keep capability tags. Audit during build will determine if any router or registry consumer reads them; if not, drop them from the dynamic schema.

## 10. Out-of-scope follow-ups

- Slice A2: classifier learns cheapest-provider-per-task-type from telemetry.
- Slice B: database migration (Fly Managed Postgres) — when multi-instance or concurrency demand justifies.
- Slice C: per-app API keys, budgets, webhooks for automation use cases.
- Streaming `tool_use` parity (memory S2372) — separate spec.
- Image / video / TTS / STT model sync.
