# Scout ↔ Pharos Handoff

Scout uses `@anthropic-ai/sdk` pointed at Pharos. Pharos translates to OpenAI-shape internally, classifies the query, routes to the cheapest model that can handle it.

**Status:** Live in production on Mac Mini (`localhost:3777`). Verified end-to-end via the Scout probe — see [`scripts/scout-probe.mjs`](../scripts/scout-probe.mjs).

---

## Connection

```typescript
import Anthropic from '@anthropic-ai/sdk';

const pharos = new Anthropic({
    baseURL: 'http://localhost:3777',
    apiKey: process.env.PHAROS_API_KEY,
});
```

The SDK's `apiKey` becomes the `X-Api-Key` header on the wire. Pharos accepts that natively. (Pharos also accepts `Authorization: Bearer <key>` for OpenAI-compat clients — both paths land at the same auth middleware.)

---

## Auth — two key types

| Key type | Source | Behavior |
|---|---|---|
| **Operator** | `PHAROS_API_KEY` env var | Bypasses wallet billing. Trusted internal agents. |
| **Wallet user** | Generated against the wallet endpoint | Hits the wallet ledger on every call (auto-debit, 30% markup over upstream cost). |

For Scout's initial dry-runs use the operator key. Switch to a wallet user key when Scout is multi-tenant or runs unattended in production.

---

## Model field — always `pharos-auto:scout`

```typescript
model: 'pharos-auto:scout'
```

Pharos:
1. Classifies the query (1-10 complexity score)
2. Routes to the cheapest tier that can handle it (free → economical → premium → frontier)
3. Tags the call with agent ID `scout` for per-agent cost tracking + rate limiting

You don't need other model forms (`pharos-code`, direct model names like `claude-sonnet-4-5`, etc.) for ICP scoring, pitch drafting, or summary posting. Auto-routing is correct for those.

---

## Calls

### Non-streaming (recommended for tool use)

```typescript
const r = await pharos.messages.create({
    model: 'pharos-auto:scout',
    max_tokens: 1024,
    messages: [{ role: 'user', content: '...' }],
});

console.log(r.content[0].text);
```

### Streaming (text only — see limitations)

```typescript
const stream = pharos.messages.stream({
    model: 'pharos-auto:scout',
    max_tokens: 1024,
    messages: [{ role: 'user', content: '...' }],
});

for await (const event of stream) {
    // event.type: 'message_start' | 'content_block_start' | ...
}
const final = await stream.finalMessage();
```

---

## Tools

Tool definitions go in the SDK call as normal. Pharos translates them to OpenAI shape, runs them through the upstream provider, and translates `tool_use` blocks back. Supports the standard Anthropic tool conventions:

```typescript
const r = await pharos.messages.create({
    model: 'pharos-auto:scout',
    max_tokens: 1024,
    tools: [{
        name: 'lookup_business',
        description: '...',
        input_schema: { type: 'object', properties: { ... } },
    }],
    messages: [...],
});
```

---

## Verification

A successful response returns:

- **Body:** `{type:'message', role:'assistant', content:[...], stop_reason, usage:{input_tokens, output_tokens}, model}`
- **Headers:**
  - `X-Pharos-Tier` — `economical` / `premium` / `frontier`
  - `X-Pharos-Model` — actual upstream model used
  - `X-Pharos-Provider` — actual upstream provider
  - `X-Pharos-Score` — classifier score 1-10
  - `X-Pharos-Cost` — upstream cost in USD (non-stream only)
  - `X-Pharos-Request-Id` — for log correlation

If those land, routing is working.

---

## Known limitations (today's ship)

1. **Streaming + tool_use silently produces zero `tool_use` content blocks.** The provider's stream chunk type doesn't carry tool calls. Use non-streaming if Scout calls tools. Non-streaming tool_use works fully.
2. **Parallel tool calls in a single delta** not handled. Irrelevant unless Scout fires multiple tools concurrently.
3. **Image content blocks** not yet supported in the request translator. Text + tool_use only.

---

## Failure modes

| Status | Meaning | Fix |
|---|---|---|
| 401 | Auth failed | Check `PHAROS_API_KEY` env var |
| 402 | Wallet empty | Top up — or use operator key for now |
| 400 | Anthropic body shape invalid | Verify SDK call matches `messages.create` signature |
| 429 | Rate limited (per-agent or spending cap) | Check `Retry-After` header |
| 502 | All upstream providers failed | `curl localhost:3777/health` to inspect |

For ongoing health: Pharos dashboard at `http://localhost:3777/` (auto-refresh 30s).

---

## Reference

- **Pharos behavior reference:** [`CLAUDE.md`](../CLAUDE.md) in the repo root
- **Implementation plan:** [`docs/superpowers/plans/2026-05-02-anthropic-messages-endpoint.md`](superpowers/plans/2026-05-02-anthropic-messages-endpoint.md)
- **Probe script (smoke test):** [`scripts/scout-probe.mjs`](../scripts/scout-probe.mjs) — run with `PHAROS_API_KEY=<key> node scripts/scout-probe.mjs`
- **Endpoint code:** [`src/gateway/messages-routes.ts`](../src/gateway/messages-routes.ts)
