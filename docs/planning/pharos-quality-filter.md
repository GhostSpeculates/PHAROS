# Pharos Quality Filter

> Cheap models generate the response. A lightweight judge scores it. Bad responses auto-retry one tier up. The user always gets a smart answer, but 80-90% of cost stays on cheap models.

## What It Does

Right now Pharos classifies a request, picks a tier, and sends it to whatever model is available. If the model returns garbage, the user gets garbage. The quality filter adds a checkpoint between "model responds" and "user sees response."

Flow:
1. Request comes in. Classifier picks tier (usually free or economical).
2. Cheap model generates response.
3. **NEW: Quality judge** (Gemini Flash or Groq Llama -- both free/near-free) scores the response 1-10 on coherence, completeness, and accuracy.
4. Score >= 7: pass through. Done.
5. Score < 7: auto-regenerate with one tier higher. Log the escalation.
6. Score < 4 on retry: escalate again (max 2 retries total, never past frontier).

The user never sees the scoring. They just get better responses from cheap models.

## Why It Matters

Nobody else does this. Every LLM router (LiteLLM, Martian, Portkey, Unify) picks a model and hopes for the best. Pharos would be the first to self-verify output quality before returning it.

This turns Pharos from "smart routing" into "guaranteed quality routing." That's a real product differentiator if you ever open-source or sell it.

For NOIR specifically: every Discord agent running through Pharos (Lens, Sentinel, Prospector, Marketing, Vault, Ops) gets smarter answers without touching their code.

## Where It Goes in the Codebase

Pharos structure (from `~/pharos/dist/`):

```
gateway/router.js  <-- main request handler (Validate -> Classify -> Route -> Execute -> Respond)
router/index.js    <-- ModelRouter class (route + routeDirect methods)
router/failover.js <-- findAvailableModel, tier escalation
```

The quality filter plugs in at the gateway level, between Execute and Respond:

```
gateway/
  quality-filter.ts  <-- NEW: QualityFilter class
    - scoreResponse(prompt, response, taskType) -> { score, reasoning }
    - shouldEscalate(score, currentTier) -> boolean
    - escalateTier(currentTier) -> nextTier

gateway/router.ts   <-- MODIFY: after getting response, call qualityFilter.scoreResponse()
                         if score < threshold, re-route through ModelRouter at higher tier
```

Config addition to `pharos.yaml`:
```yaml
qualityFilter:
  enabled: true
  threshold: 7          # minimum acceptable score
  maxRetries: 2         # max tier escalations per request
  judgeProvider: groq   # free, fast (Llama 3.3 70B)
  judgeModel: llama-3.3-70b-versatile
  excludeTiers: [premium, frontier]  # don't judge expensive models
  cacheTtlMs: 60000     # cache identical prompt scores
```

## Cost Math

**Without quality filter** (everything on Sonnet for safety):
- 1,000 requests/day at ~500 tokens avg
- Sonnet: $3/M in + $15/M out = ~$8/day = ~$240/month

**With quality filter** (cheap first, judge, escalate ~15%):
- 850 requests stay on free/economical: ~$0.50/day
- 150 escalate to premium: ~$1.20/day
- 1,000 judge calls on Groq Llama (free): $0
- Total: ~$1.70/day = ~$51/month

**Savings: ~$189/month (79%)**

Even if escalation rate is 30% instead of 15%, you're still at ~$100/month vs $240. The judge call is free on Groq.

Worst case (everything escalates): you're paying the same as before plus free judge calls. There's no scenario where this costs more.

## Build Effort

**Noir builds: ~3-4 hours**
- `QualityFilter` class with scoring prompt (~1 hour)
- Gateway integration + retry logic (~1 hour)
- YAML config schema update (~30 min)
- Tests + edge cases (streaming responses, timeouts) (~1 hour)

**Ghost does: nothing.** This is pure backend. Ghost won't see any difference except better responses from cheap agents.

**Risk: low.** Feature is behind `enabled: true` config flag. If scoring adds too much latency, flip it off. Groq responds in <500ms so total added latency for passing responses is ~500ms. For escalated responses, add the retry time (~2-3s).

## Edge Cases

- **Streaming responses**: Buffer the full response before scoring. This means non-streaming mode only for quality-filtered requests. Streaming stays as-is.
- **Judge model down**: Skip scoring, pass through. Same as today.
- **Infinite escalation**: Hard cap at 2 retries. Frontier tier is never re-judged.
- **Gaming**: The judge sees both the prompt and response, so it can't be tricked by a response that sounds confident but is wrong. But it's not perfect -- this catches incoherence, not factual errors.

## Priority

**Build later.** This is product polish, not revenue. Pharos already works. The quality filter makes it better, but nobody is paying for Pharos today. Build this when:
- Pharos gets external users (open-source launch)
- Discord agents start returning noticeably bad responses
- Ghost has a free evening and wants a quick win

If you're looking for a 3-hour project on a slow night, this is a good one. But it's behind Nex Labs revenue work, the showstopper site, and trading system.
