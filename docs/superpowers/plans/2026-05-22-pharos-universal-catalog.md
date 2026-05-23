# Pharos Universal Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-load every model from supported providers (HF Inference Providers, Vercel AI Gateway, direct provider `/v1/models` endpoints) into Pharos's registry, with tier model lists regenerated from price boundaries after each sync.

**Architecture:** New `src/sync/` module fetches and merges model catalogs from HF, Vercel, and direct providers. New `src/registry/` files expose a merged static-plus-dynamic view. After each sync, a tier populator mutates `config.tiers[tierName].models[]` based on `tier_price_boundaries` so the existing router transparently uses the new catalog. Router/classifier/wallet/tracking untouched.

**Tech Stack:** TypeScript, Fastify, Vitest, Zod, Pino, better-sqlite3 (existing).

**Spec reference:** [docs/superpowers/specs/2026-05-22-pharos-universal-catalog-design.md](../specs/2026-05-22-pharos-universal-catalog-design.md)

---

## File Structure

**New files:**
- `src/registry/static.ts` — 6 emergency-fallback seed entries
- `src/registry/dynamic.ts` — runtime cache of synced models
- `src/registry/canonical.ts` — provider-specific ID → canonical ID
- `src/registry/resolver.ts` — given canonical ID, return ordered list of available provider paths
- `src/sync/index.ts` — orchestrator
- `src/sync/cache.ts` — atomic JSON cache file read/write
- `src/sync/cron.ts` — `setInterval` scheduler
- `src/sync/tier-populator.ts` — mutate `config.tiers[].models[]` post-sync
- `src/sync/sources/huggingface.ts` — HF Inference Providers fetcher
- `src/sync/sources/vercel.ts` — Vercel AI Gateway fetcher
- `src/sync/sources/direct.ts` — direct providers `/v1/models` fetcher
- `src/__tests__/registry/static.test.ts`
- `src/__tests__/registry/canonical.test.ts`
- `src/__tests__/registry/dynamic.test.ts`
- `src/__tests__/registry/resolver.test.ts`
- `src/__tests__/registry/merge.test.ts`
- `src/__tests__/sync/cache.test.ts`
- `src/__tests__/sync/huggingface.test.ts`
- `src/__tests__/sync/vercel.test.ts`
- `src/__tests__/sync/direct.test.ts`
- `src/__tests__/sync/orchestrator.test.ts`
- `src/__tests__/sync/tier-populator.test.ts`
- `src/__tests__/sync/cron.test.ts`
- `src/__tests__/router/snapshot.test.ts`

**Modified files:**
- `src/config/schema.ts` — add `sync`, `tier_price_boundaries`, `resolver` schemas
- `src/registry/index.ts` — expose `getMergedRegistry()`; existing helpers read from merged view
- `src/registry/models.ts` — slim to a re-export of `static.ts`
- `src/providers/index.ts` — register HF + Vercel `openai-compat` instances
- `src/server.ts` — call sync orchestrator post-startup, schedule cron
- `config/pharos.default.yaml` — add new config sections + 2 provider entries
- `.env.example` — add `HUGGINGFACE_API_KEY`, `VERCEL_AI_GATEWAY_KEY`

---

## Task 1: Config schema additions

**Files:**
- Modify: `src/config/schema.ts`
- Create: `src/__tests__/config-schema-sync.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/__tests__/config-schema-sync.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { SyncConfigSchema, TierPriceBoundariesSchema, ResolverConfigSchema } from '../config/schema.js';

describe('sync config schema', () => {
    it('parses valid sync block', () => {
        const parsed = SyncConfigSchema.parse({
            enabled: true,
            intervalHours: 24,
            cacheFile: './data/catalog-cache.json',
            sources: {
                huggingface: { enabled: true, endpoint: 'https://router.huggingface.co/v1/models' },
                vercel: { enabled: true, endpoint: 'https://ai-gateway.vercel.sh/v1/models' },
                direct: { enabled: true },
            },
        });
        expect(parsed.intervalHours).toBe(24);
    });

    it('rejects non-positive intervalHours', () => {
        expect(() =>
            SyncConfigSchema.parse({
                enabled: true,
                intervalHours: 0,
                cacheFile: './x.json',
                sources: { huggingface: { enabled: false, endpoint: 'https://x' }, vercel: { enabled: false, endpoint: 'https://x' }, direct: { enabled: false } },
            }),
        ).toThrow();
    });
});

describe('tier price boundaries schema', () => {
    it('parses valid boundaries', () => {
        const parsed = TierPriceBoundariesSchema.parse({
            free:       { tier: [1, 3], maxInputPerMillion: 0.10, maxOutputPerMillion: 0.40 },
            economical: { tier: [4, 6], maxInputPerMillion: 1.00, maxOutputPerMillion: 4.00 },
            premium:    { tier: [7, 8], maxInputPerMillion: 5.00, maxOutputPerMillion: 20.00 },
            frontier:   { tier: [9, 10], maxInputPerMillion: 999, maxOutputPerMillion: 999 },
        });
        expect(parsed.free.maxInputPerMillion).toBe(0.10);
    });
});

describe('resolver config schema', () => {
    it('parses preference list', () => {
        const parsed = ResolverConfigSchema.parse({ preference: ['direct', 'huggingface', 'vercel'] });
        expect(parsed.preference).toEqual(['direct', 'huggingface', 'vercel']);
    });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
npx vitest run src/__tests__/config-schema-sync.test.ts
```
Expected: FAIL — `SyncConfigSchema`/`TierPriceBoundariesSchema`/`ResolverConfigSchema` not exported.

- [ ] **Step 3: Add schemas to `src/config/schema.ts`**

Locate the section after `ProviderConfigSchema` (around line 30). Insert:

```typescript
// ─── Sync configuration ───
export const SyncSourceSchema = z.object({
    enabled: z.boolean(),
    endpoint: z.string().url().optional(),
});

export const SyncConfigSchema = z.object({
    enabled: z.boolean(),
    intervalHours: z.number().positive(),
    cacheFile: z.string(),
    sources: z.object({
        huggingface: SyncSourceSchema,
        vercel: SyncSourceSchema,
        direct: SyncSourceSchema,
    }),
});
export type SyncConfig = z.infer<typeof SyncConfigSchema>;

// ─── Tier price boundary ───
export const TierBoundarySchema = z.object({
    tier: z.tuple([z.number().min(1), z.number().max(10)]),
    maxInputPerMillion: z.number().min(0),
    maxOutputPerMillion: z.number().min(0),
});

export const TierPriceBoundariesSchema = z.object({
    free: TierBoundarySchema,
    economical: TierBoundarySchema,
    premium: TierBoundarySchema,
    frontier: TierBoundarySchema,
});
export type TierPriceBoundaries = z.infer<typeof TierPriceBoundariesSchema>;

// ─── Resolver configuration ───
export const ResolverConfigSchema = z.object({
    preference: z.array(z.enum(['direct', 'huggingface', 'vercel'])).min(1),
});
export type ResolverConfig = z.infer<typeof ResolverConfigSchema>;
```

Then locate the top-level `PharosConfigSchema` (around line 234) and add optional fields:

```typescript
// Inside the existing PharosConfigSchema z.object({ ... })
    sync: SyncConfigSchema.optional(),
    tierPriceBoundaries: TierPriceBoundariesSchema.optional(),
    resolver: ResolverConfigSchema.optional(),
```

- [ ] **Step 4: Run test, verify pass**

```bash
npx vitest run src/__tests__/config-schema-sync.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts src/__tests__/config-schema-sync.test.ts
git commit -m "feat(config): add sync/tier-price-boundaries/resolver schemas"
```

---

## Task 2: Static seed registry

**Files:**
- Create: `src/registry/static.ts`
- Create: `src/__tests__/registry/static.test.ts`

- [ ] **Step 1: Write failing test**

Create directory + file `src/__tests__/registry/static.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { STATIC_SEED, type StaticSeedEntry } from '../../registry/static.js';

describe('static seed', () => {
    it('contains one entry per direct-key provider', () => {
        const providers = new Set(STATIC_SEED.map(e => e.provider));
        expect(providers).toContain('anthropic');
        expect(providers).toContain('openai');
        expect(providers).toContain('google');
        expect(providers).toContain('groq');
        expect(providers).toContain('moonshot');
        expect(providers).toContain('xai');
    });

    it('every entry has non-zero pricing', () => {
        for (const entry of STATIC_SEED) {
            const total = entry.pricing.inputPerMillion + entry.pricing.outputPerMillion;
            expect(total).toBeGreaterThan(0);
        }
    });

    it('every entry has a canonical id', () => {
        for (const entry of STATIC_SEED) {
            expect(entry.canonicalId).toMatch(/\//);
        }
    });
});
```

- [ ] **Step 2: Run test, verify fails**

```bash
npx vitest run src/__tests__/registry/static.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/registry/static.ts`**

```typescript
/**
 * Emergency-fallback seed entries. Used only when:
 *   - all sync sources fail on cold boot
 *   - AND no cached catalog exists
 *
 * One entry per direct-key provider so Pharos can still serve.
 */

export interface StaticSeedEntry {
    canonicalId: string;
    id: string;
    provider: string;
    displayName: string;
    contextWindow: number;
    pricing: { inputPerMillion: number; outputPerMillion: number };
}

export const STATIC_SEED: StaticSeedEntry[] = [
    {
        canonicalId: 'anthropic/claude-sonnet-4',
        id: 'claude-sonnet-4-20250514',
        provider: 'anthropic',
        displayName: 'Claude Sonnet 4',
        contextWindow: 200_000,
        pricing: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
    },
    {
        canonicalId: 'openai/gpt-4o',
        id: 'gpt-4o',
        provider: 'openai',
        displayName: 'GPT-4o',
        contextWindow: 128_000,
        pricing: { inputPerMillion: 2.5, outputPerMillion: 10.0 },
    },
    {
        canonicalId: 'google/gemini-2.5-flash',
        id: 'gemini-2.5-flash',
        provider: 'google',
        displayName: 'Gemini 2.5 Flash',
        contextWindow: 1_048_576,
        pricing: { inputPerMillion: 0.075, outputPerMillion: 0.30 },
    },
    {
        canonicalId: 'meta-llama/Llama-3.3-70B-Instruct',
        id: 'llama-3.3-70b-versatile',
        provider: 'groq',
        displayName: 'Llama 3.3 70B (Groq)',
        contextWindow: 128_000,
        pricing: { inputPerMillion: 0.59, outputPerMillion: 0.79 },
    },
    {
        canonicalId: 'moonshot/kimi-latest',
        id: 'kimi-latest',
        provider: 'moonshot',
        displayName: 'Kimi Latest',
        contextWindow: 128_000,
        pricing: { inputPerMillion: 0.50, outputPerMillion: 2.00 },
    },
    {
        canonicalId: 'xai/grok-3-mini-fast',
        id: 'grok-3-mini-fast',
        provider: 'xai',
        displayName: 'Grok 3 Mini Fast',
        contextWindow: 131_072,
        pricing: { inputPerMillion: 0.30, outputPerMillion: 0.50 },
    },
];
```

- [ ] **Step 4: Run test, verify pass**

```bash
npx vitest run src/__tests__/registry/static.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/registry/static.ts src/__tests__/registry/static.test.ts
git commit -m "feat(registry): add static seed for emergency boot fallback"
```

---

## Task 3: Canonical ID normalizer

**Files:**
- Create: `src/registry/canonical.ts`
- Create: `src/__tests__/registry/canonical.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/__tests__/registry/canonical.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { toCanonicalId } from '../../registry/canonical.js';

describe('canonical id', () => {
    it('keeps namespace/model format unchanged', () => {
        expect(toCanonicalId('meta-llama/Llama-3.3-70B-Instruct')).toBe('meta-llama/Llama-3.3-70B-Instruct');
    });

    it('namespaces direct anthropic models', () => {
        expect(toCanonicalId('claude-sonnet-4-20250514', 'anthropic')).toBe('anthropic/claude-sonnet-4');
    });

    it('namespaces direct openai models', () => {
        expect(toCanonicalId('gpt-4o', 'openai')).toBe('openai/gpt-4o');
    });

    it('strips together/fireworks vendor prefix', () => {
        expect(toCanonicalId('meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo')).toBe('meta-llama/Meta-Llama-3.1-405B-Instruct');
        expect(toCanonicalId('accounts/fireworks/models/llama-v3p3-70b-instruct')).toBe('meta-llama/Llama-3.3-70B-Instruct');
    });

    it('normalizes groq slugs to HF style', () => {
        expect(toCanonicalId('llama-3.3-70b-versatile', 'groq')).toBe('meta-llama/Llama-3.3-70B-Instruct');
    });

    it('lowercases nothing else (case-sensitive)', () => {
        expect(toCanonicalId('moonshot/Kimi-K2')).toBe('moonshot/Kimi-K2');
    });
});
```

- [ ] **Step 2: Run test, verify fails**

```bash
npx vitest run src/__tests__/registry/canonical.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/registry/canonical.ts`**

```typescript
/**
 * Normalize provider-specific model IDs into canonical IDs.
 *
 * Canonical ID is `<namespace>/<model>`:
 *   - Open-weights: HF-style namespace (e.g. `meta-llama/Llama-3.3-70B-Instruct`)
 *   - Closed providers: `<provider>/<model>` (e.g. `anthropic/claude-sonnet-4`)
 */

const GROQ_TO_HF: Record<string, string> = {
    'llama-3.3-70b-versatile': 'meta-llama/Llama-3.3-70B-Instruct',
    'llama-3.1-70b-versatile': 'meta-llama/Meta-Llama-3.1-70B-Instruct',
    'llama-3.1-8b-instant':    'meta-llama/Meta-Llama-3.1-8B-Instruct',
    'mixtral-8x7b-32768':      'mistralai/Mixtral-8x7B-Instruct-v0.1',
};

const ANTHROPIC_STRIP_DATE = /^(claude-(?:opus|sonnet|haiku)-\d+)-\d{8}$/;

const FIREWORKS_TO_HF: Record<string, string> = {
    'accounts/fireworks/models/llama-v3p3-70b-instruct': 'meta-llama/Llama-3.3-70B-Instruct',
    'accounts/fireworks/models/deepseek-v3':            'deepseek-ai/DeepSeek-V3',
    'accounts/fireworks/models/deepseek-r1':            'deepseek-ai/DeepSeek-R1',
};

const TOGETHER_STRIP_TURBO = /-Turbo$/;

export function toCanonicalId(id: string, provider?: string): string {
    // Already namespaced
    if (id.includes('/')) {
        if (id in FIREWORKS_TO_HF) return FIREWORKS_TO_HF[id];
        // Together turbo suffix → strip
        const stripped = id.replace(TOGETHER_STRIP_TURBO, '');
        return stripped;
    }

    if (provider === 'groq' && id in GROQ_TO_HF) {
        return GROQ_TO_HF[id];
    }

    if (provider === 'anthropic') {
        const m = id.match(ANTHROPIC_STRIP_DATE);
        return `anthropic/${m ? m[1] : id}`;
    }

    if (provider) {
        return `${provider}/${id}`;
    }

    return id;
}
```

- [ ] **Step 4: Run test, verify pass**

```bash
npx vitest run src/__tests__/registry/canonical.test.ts
```
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/registry/canonical.ts src/__tests__/registry/canonical.test.ts
git commit -m "feat(registry): canonical id normalizer"
```

---

## Task 4: Dynamic registry storage

**Files:**
- Create: `src/registry/dynamic.ts`
- Create: `src/__tests__/registry/dynamic.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/__tests__/registry/dynamic.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { DynamicRegistry, type DynamicEntry } from '../../registry/dynamic.js';

const sample: DynamicEntry = {
    canonicalId: 'meta-llama/Llama-3.3-70B-Instruct',
    id: 'llama-3.3-70b-versatile',
    provider: 'groq',
    source: 'direct',
    displayName: 'Llama 3.3 70B',
    contextWindow: 128_000,
    pricing: { inputPerMillion: 0.59, outputPerMillion: 0.79 },
    syncedAt: 1747900800000,
};

describe('DynamicRegistry', () => {
    let reg: DynamicRegistry;
    beforeEach(() => { reg = new DynamicRegistry(); });

    it('stores and retrieves entries by canonical id', () => {
        reg.upsert(sample);
        const found = reg.getByCanonical('meta-llama/Llama-3.3-70B-Instruct');
        expect(found).toHaveLength(1);
        expect(found[0].provider).toBe('groq');
    });

    it('keeps multiple provider entries for the same canonical id', () => {
        reg.upsert(sample);
        reg.upsert({ ...sample, provider: 'together', source: 'huggingface' });
        const found = reg.getByCanonical('meta-llama/Llama-3.3-70B-Instruct');
        expect(found).toHaveLength(2);
    });

    it('replaces same (canonical,provider,source) on upsert', () => {
        reg.upsert(sample);
        reg.upsert({ ...sample, pricing: { inputPerMillion: 0.50, outputPerMillion: 0.70 } });
        const found = reg.getByCanonical('meta-llama/Llama-3.3-70B-Instruct');
        expect(found).toHaveLength(1);
        expect(found[0].pricing.inputPerMillion).toBe(0.50);
    });

    it('replaceAll wipes prior state', () => {
        reg.upsert(sample);
        reg.replaceAll([{ ...sample, canonicalId: 'openai/gpt-4o' }]);
        expect(reg.getByCanonical('meta-llama/Llama-3.3-70B-Instruct')).toEqual([]);
        expect(reg.getByCanonical('openai/gpt-4o')).toHaveLength(1);
    });

    it('listAll returns flat array', () => {
        reg.upsert(sample);
        reg.upsert({ ...sample, provider: 'together', source: 'huggingface' });
        expect(reg.listAll()).toHaveLength(2);
    });
});
```

- [ ] **Step 2: Run test, verify fails**

```bash
npx vitest run src/__tests__/registry/dynamic.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/registry/dynamic.ts`**

```typescript
/**
 * Runtime cache of synced models.
 *
 * Keyed by (canonicalId, provider, source). Multiple providers can host
 * the same canonical model — each is its own entry.
 */

export type SyncSource = 'direct' | 'huggingface' | 'vercel';

export interface DynamicEntry {
    canonicalId: string;
    id: string;            // provider-specific id used to call the provider
    provider: string;      // provider name as configured (e.g. "groq", "huggingface")
    source: SyncSource;
    displayName: string;
    contextWindow: number;
    pricing: { inputPerMillion: number; outputPerMillion: number };
    syncedAt: number;      // epoch ms
}

function keyOf(e: { canonicalId: string; provider: string; source: SyncSource }): string {
    return `${e.canonicalId}::${e.provider}::${e.source}`;
}

export class DynamicRegistry {
    private byKey = new Map<string, DynamicEntry>();

    upsert(entry: DynamicEntry): void {
        this.byKey.set(keyOf(entry), entry);
    }

    replaceAll(entries: DynamicEntry[]): void {
        this.byKey.clear();
        for (const e of entries) this.upsert(e);
    }

    getByCanonical(canonicalId: string): DynamicEntry[] {
        const out: DynamicEntry[] = [];
        for (const e of this.byKey.values()) {
            if (e.canonicalId === canonicalId) out.push(e);
        }
        return out;
    }

    listAll(): DynamicEntry[] {
        return Array.from(this.byKey.values());
    }

    size(): number {
        return this.byKey.size;
    }
}
```

- [ ] **Step 4: Run test, verify pass**

```bash
npx vitest run src/__tests__/registry/dynamic.test.ts
```
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/registry/dynamic.ts src/__tests__/registry/dynamic.test.ts
git commit -m "feat(registry): dynamic runtime catalog store"
```

---

## Task 5: Cache file (atomic JSON I/O)

**Files:**
- Create: `src/sync/cache.ts`
- Create: `src/__tests__/sync/cache.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/__tests__/sync/cache.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCache, readCache } from '../../sync/cache.js';
import type { DynamicEntry } from '../../registry/dynamic.js';

const sample: DynamicEntry[] = [
    {
        canonicalId: 'openai/gpt-4o',
        id: 'gpt-4o',
        provider: 'openai',
        source: 'direct',
        displayName: 'GPT-4o',
        contextWindow: 128_000,
        pricing: { inputPerMillion: 2.5, outputPerMillion: 10 },
        syncedAt: 1747900800000,
    },
];

describe('sync cache file', () => {
    let path: string;
    beforeEach(async () => {
        path = join(tmpdir(), `pharos-cache-${Date.now()}-${Math.random()}.json`);
    });
    afterEach(async () => {
        try { await fs.unlink(path); } catch { /* ignore */ }
    });

    it('writes and reads back entries', async () => {
        await writeCache(path, sample);
        const out = await readCache(path);
        expect(out).toEqual(sample);
    });

    it('returns null when file missing', async () => {
        const out = await readCache('/nonexistent/path/x.json');
        expect(out).toBeNull();
    });

    it('returns null on corrupt JSON', async () => {
        await fs.writeFile(path, '{ not json', 'utf8');
        const out = await readCache(path);
        expect(out).toBeNull();
    });

    it('write is atomic (tmp+rename)', async () => {
        await writeCache(path, sample);
        const dir = path.substring(0, path.lastIndexOf('/'));
        const files = await fs.readdir(dir);
        const leftovers = files.filter(f => f.includes('pharos-cache') && f.endsWith('.tmp'));
        expect(leftovers).toHaveLength(0);
    });
});
```

- [ ] **Step 2: Run test, verify fails**

```bash
npx vitest run src/__tests__/sync/cache.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/sync/cache.ts`**

```typescript
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { DynamicEntry } from '../registry/dynamic.js';

const CACHE_VERSION = 1;

interface CacheShape {
    version: number;
    writtenAt: number;
    entries: DynamicEntry[];
}

export async function writeCache(path: string, entries: DynamicEntry[]): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true });
    const payload: CacheShape = { version: CACHE_VERSION, writtenAt: Date.now(), entries };
    const tmp = `${path}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(payload), 'utf8');
    await fs.rename(tmp, path);
}

export async function readCache(path: string): Promise<DynamicEntry[] | null> {
    let raw: string;
    try {
        raw = await fs.readFile(path, 'utf8');
    } catch {
        return null;
    }
    try {
        const parsed = JSON.parse(raw) as CacheShape;
        if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) return null;
        return parsed.entries;
    } catch {
        return null;
    }
}
```

- [ ] **Step 4: Run test, verify pass**

```bash
npx vitest run src/__tests__/sync/cache.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sync/cache.ts src/__tests__/sync/cache.test.ts
git commit -m "feat(sync): atomic catalog cache file read/write"
```

---

## Task 6: Registry merge (`getMergedRegistry`)

**Files:**
- Modify: `src/registry/index.ts`
- Create: `src/__tests__/registry/merge.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/__tests__/registry/merge.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { getMergedRegistry, setDynamicRegistryForTesting } from '../../registry/index.js';
import { DynamicRegistry, type DynamicEntry } from '../../registry/dynamic.js';

const dynEntry: DynamicEntry = {
    canonicalId: 'deepseek-ai/DeepSeek-V3',
    id: 'deepseek-chat',
    provider: 'deepseek',
    source: 'direct',
    displayName: 'DeepSeek V3',
    contextWindow: 64_000,
    pricing: { inputPerMillion: 0.27, outputPerMillion: 1.10 },
    syncedAt: 1747900800000,
};

describe('merged registry', () => {
    beforeEach(() => {
        const reg = new DynamicRegistry();
        reg.upsert(dynEntry);
        setDynamicRegistryForTesting(reg);
    });

    it('returns static seed entries', () => {
        const all = getMergedRegistry();
        const ids = all.map(e => e.canonicalId);
        expect(ids).toContain('openai/gpt-4o');
        expect(ids).toContain('anthropic/claude-sonnet-4');
    });

    it('returns dynamic entries', () => {
        const all = getMergedRegistry();
        expect(all.find(e => e.canonicalId === 'deepseek-ai/DeepSeek-V3')).toBeDefined();
    });

    it('dedupes by (canonicalId, provider) — dynamic wins over static', () => {
        // Add a dynamic entry shadowing a static one
        const reg = new DynamicRegistry();
        reg.upsert({ ...dynEntry, canonicalId: 'openai/gpt-4o', id: 'gpt-4o', provider: 'openai', pricing: { inputPerMillion: 1.99, outputPerMillion: 7.99 } });
        setDynamicRegistryForTesting(reg);
        const all = getMergedRegistry();
        const gpt = all.filter(e => e.canonicalId === 'openai/gpt-4o' && e.provider === 'openai');
        expect(gpt).toHaveLength(1);
        expect(gpt[0].pricing.inputPerMillion).toBe(1.99); // dynamic price wins
    });
});
```

- [ ] **Step 2: Run test, verify fails**

```bash
npx vitest run src/__tests__/registry/merge.test.ts
```
Expected: FAIL — `getMergedRegistry`/`setDynamicRegistryForTesting` not exported.

- [ ] **Step 3: Modify `src/registry/index.ts`**

Replace the file with this content (preserves all existing exports, adds merge):

```typescript
/**
 * Registry helpers — query model metadata for routing decisions.
 *
 * Backed by:
 *   - static seed (always present)
 *   - dynamic registry (populated by sync; may be empty before first sync)
 */

import { MODEL_REGISTRY, type SpeedTier, type ModelRegistryEntry } from './models.js';
import { STATIC_SEED } from './static.js';
import { DynamicRegistry, type DynamicEntry } from './dynamic.js';

let dynamicRegistry = new DynamicRegistry();

/** For tests only — overwrite the live dynamic registry. */
export function setDynamicRegistryForTesting(reg: DynamicRegistry): void {
    dynamicRegistry = reg;
}

/** Production swap of the dynamic registry (after a successful sync). */
export function setDynamicRegistry(reg: DynamicRegistry): void {
    dynamicRegistry = reg;
}

export interface MergedEntry {
    canonicalId: string;
    id: string;
    provider: string;
    displayName: string;
    contextWindow: number;
    pricing: { inputPerMillion: number; outputPerMillion: number };
    source: 'static' | 'direct' | 'huggingface' | 'vercel';
}

export function getMergedRegistry(): MergedEntry[] {
    const out = new Map<string, MergedEntry>();

    // Static first
    for (const s of STATIC_SEED) {
        const key = `${s.canonicalId}::${s.provider}`;
        out.set(key, {
            canonicalId: s.canonicalId,
            id: s.id,
            provider: s.provider,
            displayName: s.displayName,
            contextWindow: s.contextWindow,
            pricing: s.pricing,
            source: 'static',
        });
    }

    // Dynamic shadows static for same (canonicalId, provider)
    for (const d of dynamicRegistry.listAll()) {
        const key = `${d.canonicalId}::${d.provider}`;
        out.set(key, {
            canonicalId: d.canonicalId,
            id: d.id,
            provider: d.provider,
            displayName: d.displayName,
            contextWindow: d.contextWindow,
            pricing: d.pricing,
            source: d.source,
        });
    }

    return Array.from(out.values());
}

// ─── Existing helpers preserved (now read from merged registry) ───

const SPEED_ORDER: Record<SpeedTier, number> = { fast: 0, medium: 1, slow: 2 };

export function getModelSpeed(provider: string, model: string): SpeedTier | undefined {
    const entry = MODEL_REGISTRY.find(m => m.provider === provider && m.id === model);
    return entry?.speed;
}

export function getModelCost(provider: string, model: string): number | undefined {
    // Try merged registry first (real prices)
    const merged = getMergedRegistry().find(m => m.provider === provider && m.id === model);
    if (merged) return merged.pricing.inputPerMillion + merged.pricing.outputPerMillion;
    // Fallback to legacy static MODEL_REGISTRY
    const entry = MODEL_REGISTRY.find(m => m.provider === provider && m.id === model);
    if (!entry) return undefined;
    return entry.pricing.inputPerMillion + entry.pricing.outputPerMillion;
}

export function getSpeedRank(provider: string, model: string): number {
    const speed = getModelSpeed(provider, model);
    return speed ? SPEED_ORDER[speed] : 1;
}

export function getRegistryEntry(provider: string, model: string): ModelRegistryEntry | undefined {
    return MODEL_REGISTRY.find(m => m.provider === provider && m.id === model);
}
```

- [ ] **Step 4: Run test, verify pass**

```bash
npx vitest run src/__tests__/registry/merge.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Run full existing test suite to confirm no regression**

```bash
npm test
```
Expected: all existing tests still pass; new merge tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/registry/index.ts src/__tests__/registry/merge.test.ts
git commit -m "feat(registry): merged static+dynamic view via getMergedRegistry()"
```

---

## Task 7: Hugging Face source parser

**Files:**
- Create: `src/sync/sources/huggingface.ts`
- Create: `src/__tests__/sync/huggingface.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/__tests__/sync/huggingface.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { fetchHuggingFaceModels } from '../../sync/sources/huggingface.js';

const mockResponse = {
    object: 'list',
    data: [
        {
            id: 'meta-llama/Llama-3.3-70B-Instruct',
            object: 'model',
            owned_by: 'huggingface',
            providers: [
                { provider: 'together', status: 'live', pricing: { input: 0.88, output: 0.88 }, context_length: 128_000 },
                { provider: 'fireworks', status: 'live', pricing: { input: 0.90, output: 0.90 }, context_length: 128_000 },
            ],
        },
        {
            id: 'deepseek-ai/DeepSeek-V3',
            object: 'model',
            owned_by: 'huggingface',
            providers: [
                { provider: 'novita', status: 'live', pricing: { input: 0.27, output: 1.10 }, context_length: 64_000 },
            ],
        },
    ],
};

describe('huggingface source parser', () => {
    it('returns one DynamicEntry per (model, provider)', async () => {
        const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => mockResponse } as Response);
        const entries = await fetchHuggingFaceModels({
            endpoint: 'https://router.huggingface.co/v1/models',
            apiKey: 'hf_test',
            fetchFn,
            timeoutMs: 5000,
        });
        expect(entries).toHaveLength(3);
        const llamaTogether = entries.find(e => e.canonicalId === 'meta-llama/Llama-3.3-70B-Instruct' && e.provider === 'huggingface-together');
        expect(llamaTogether).toBeDefined();
        expect(llamaTogether!.pricing.inputPerMillion).toBe(0.88);
        expect(llamaTogether!.source).toBe('huggingface');
    });

    it('returns empty array when fetch fails', async () => {
        const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response);
        const entries = await fetchHuggingFaceModels({
            endpoint: 'https://router.huggingface.co/v1/models',
            apiKey: 'hf_test',
            fetchFn,
            timeoutMs: 5000,
        });
        expect(entries).toEqual([]);
    });

    it('returns empty array when timeout exceeded', async () => {
        const fetchFn = vi.fn().mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ ok: true, json: async () => mockResponse } as Response), 100)));
        const entries = await fetchHuggingFaceModels({
            endpoint: 'https://router.huggingface.co/v1/models',
            apiKey: 'hf_test',
            fetchFn,
            timeoutMs: 10,
        });
        expect(entries).toEqual([]);
    });
});
```

- [ ] **Step 2: Run test, verify fails**

```bash
npx vitest run src/__tests__/sync/huggingface.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/sync/sources/huggingface.ts`**

```typescript
import type { DynamicEntry } from '../../registry/dynamic.js';
import { toCanonicalId } from '../../registry/canonical.js';

export interface HFFetchOptions {
    endpoint: string;
    apiKey: string;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
}

interface HFProviderEntry {
    provider: string;
    status: string;
    pricing?: { input: number; output: number };
    context_length?: number;
}

interface HFModel {
    id: string;
    providers?: HFProviderEntry[];
}

interface HFResponse {
    data: HFModel[];
}

export async function fetchHuggingFaceModels(opts: HFFetchOptions): Promise<DynamicEntry[]> {
    const fetchFn = opts.fetchFn ?? fetch;
    const timeoutMs = opts.timeoutMs ?? 5_000;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
        res = await fetchFn(opts.endpoint, {
            headers: { Authorization: `Bearer ${opts.apiKey}` },
            signal: controller.signal,
        });
    } catch {
        clearTimeout(timer);
        return [];
    }
    clearTimeout(timer);

    if (!res.ok) return [];

    let body: HFResponse;
    try { body = (await res.json()) as HFResponse; } catch { return []; }
    if (!Array.isArray(body.data)) return [];

    const now = Date.now();
    const out: DynamicEntry[] = [];

    for (const m of body.data) {
        const canonical = toCanonicalId(m.id);
        const providers = m.providers ?? [];
        for (const p of providers) {
            if (p.status !== 'live') continue;
            if (!p.pricing) continue;
            out.push({
                canonicalId: canonical,
                id: m.id,
                provider: `huggingface-${p.provider}`,
                source: 'huggingface',
                displayName: m.id,
                contextWindow: p.context_length ?? 0,
                pricing: { inputPerMillion: p.pricing.input, outputPerMillion: p.pricing.output },
                syncedAt: now,
            });
        }
    }

    return out;
}
```

- [ ] **Step 4: Run test, verify pass**

```bash
npx vitest run src/__tests__/sync/huggingface.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sync/sources/huggingface.ts src/__tests__/sync/huggingface.test.ts
git commit -m "feat(sync): hugging face inference providers source parser"
```

---

## Task 8: Vercel AI Gateway source parser

**Files:**
- Create: `src/sync/sources/vercel.ts`
- Create: `src/__tests__/sync/vercel.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/__tests__/sync/vercel.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { fetchVercelGatewayModels } from '../../sync/sources/vercel.js';

const mockResponse = {
    object: 'list',
    data: [
        {
            id: 'anthropic/claude-sonnet-4',
            object: 'model',
            pricing: { input: 3.0, output: 15.0 },
            context_window: 200_000,
        },
        {
            id: 'openai/gpt-4o',
            object: 'model',
            pricing: { input: 2.5, output: 10.0 },
            context_window: 128_000,
        },
    ],
};

describe('vercel gateway source parser', () => {
    it('returns DynamicEntry list from /models', async () => {
        const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => mockResponse } as Response);
        const entries = await fetchVercelGatewayModels({
            endpoint: 'https://ai-gateway.vercel.sh/v1/models',
            apiKey: 'vck_test',
            fetchFn,
            timeoutMs: 5000,
        });
        expect(entries).toHaveLength(2);
        expect(entries[0].source).toBe('vercel');
        expect(entries[0].provider).toBe('vercel-gateway');
        const sonnet = entries.find(e => e.canonicalId === 'anthropic/claude-sonnet-4');
        expect(sonnet!.pricing.inputPerMillion).toBe(3.0);
    });

    it('returns empty array on non-ok response', async () => {
        const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 401 } as Response);
        const entries = await fetchVercelGatewayModels({
            endpoint: 'https://ai-gateway.vercel.sh/v1/models',
            apiKey: 'bad',
            fetchFn,
            timeoutMs: 5000,
        });
        expect(entries).toEqual([]);
    });
});
```

- [ ] **Step 2: Run test, verify fails**

```bash
npx vitest run src/__tests__/sync/vercel.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Create `src/sync/sources/vercel.ts`**

```typescript
import type { DynamicEntry } from '../../registry/dynamic.js';
import { toCanonicalId } from '../../registry/canonical.js';

export interface VercelFetchOptions {
    endpoint: string;
    apiKey: string;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
}

interface VercelModel {
    id: string;
    pricing?: { input: number; output: number };
    context_window?: number;
}

interface VercelResponse {
    data: VercelModel[];
}

export async function fetchVercelGatewayModels(opts: VercelFetchOptions): Promise<DynamicEntry[]> {
    const fetchFn = opts.fetchFn ?? fetch;
    const timeoutMs = opts.timeoutMs ?? 5_000;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
        res = await fetchFn(opts.endpoint, {
            headers: { Authorization: `Bearer ${opts.apiKey}` },
            signal: controller.signal,
        });
    } catch {
        clearTimeout(timer);
        return [];
    }
    clearTimeout(timer);

    if (!res.ok) return [];

    let body: VercelResponse;
    try { body = (await res.json()) as VercelResponse; } catch { return []; }
    if (!Array.isArray(body.data)) return [];

    const now = Date.now();
    const out: DynamicEntry[] = [];

    for (const m of body.data) {
        if (!m.pricing) continue;
        out.push({
            canonicalId: toCanonicalId(m.id),
            id: m.id,
            provider: 'vercel-gateway',
            source: 'vercel',
            displayName: m.id,
            contextWindow: m.context_window ?? 0,
            pricing: { inputPerMillion: m.pricing.input, outputPerMillion: m.pricing.output },
            syncedAt: now,
        });
    }

    return out;
}
```

- [ ] **Step 4: Run test, verify pass**

```bash
npx vitest run src/__tests__/sync/vercel.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sync/sources/vercel.ts src/__tests__/sync/vercel.test.ts
git commit -m "feat(sync): vercel ai gateway source parser"
```

---

## Task 9: Direct providers source parser

**Files:**
- Create: `src/sync/sources/direct.ts`
- Create: `src/__tests__/sync/direct.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/__tests__/sync/direct.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { fetchDirectProviderModels } from '../../sync/sources/direct.js';

const openaiResponse = { data: [{ id: 'gpt-4o', object: 'model' }, { id: 'o3', object: 'model' }] };
const groqResponse = { data: [{ id: 'llama-3.3-70b-versatile', object: 'model' }] };

describe('direct providers source parser', () => {
    it('fetches /v1/models from configured direct providers', async () => {
        const fetchFn = vi.fn().mockImplementation(async (url: string) => {
            if (url.includes('openai')) return { ok: true, json: async () => openaiResponse } as Response;
            if (url.includes('groq')) return { ok: true, json: async () => groqResponse } as Response;
            return { ok: false, status: 404 } as Response;
        });

        const entries = await fetchDirectProviderModels({
            providers: [
                { name: 'openai', endpoint: 'https://api.openai.com/v1/models', apiKey: 'sk-test', staticPricing: { 'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 } } },
                { name: 'groq',   endpoint: 'https://api.groq.com/openai/v1/models', apiKey: 'gsk-test', staticPricing: { 'llama-3.3-70b-versatile': { inputPerMillion: 0.59, outputPerMillion: 0.79 } } },
            ],
            fetchFn,
            timeoutMs: 5000,
        });

        expect(entries.find(e => e.id === 'gpt-4o')).toBeDefined();
        expect(entries.find(e => e.id === 'llama-3.3-70b-versatile')).toBeDefined();
    });

    it('skips providers without api key', async () => {
        const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => openaiResponse } as Response);
        const entries = await fetchDirectProviderModels({
            providers: [{ name: 'openai', endpoint: 'https://api.openai.com/v1/models', apiKey: '', staticPricing: {} }],
            fetchFn,
            timeoutMs: 5000,
        });
        expect(entries).toEqual([]);
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('continues when one provider fails', async () => {
        const fetchFn = vi.fn().mockImplementation(async (url: string) => {
            if (url.includes('openai')) throw new Error('boom');
            return { ok: true, json: async () => groqResponse } as Response;
        });
        const entries = await fetchDirectProviderModels({
            providers: [
                { name: 'openai', endpoint: 'https://api.openai.com/v1/models', apiKey: 'sk', staticPricing: {} },
                { name: 'groq',   endpoint: 'https://api.groq.com/openai/v1/models', apiKey: 'gsk', staticPricing: { 'llama-3.3-70b-versatile': { inputPerMillion: 0.59, outputPerMillion: 0.79 } } },
            ],
            fetchFn,
            timeoutMs: 5000,
        });
        expect(entries.find(e => e.id === 'llama-3.3-70b-versatile')).toBeDefined();
    });
});
```

- [ ] **Step 2: Run test, verify fails**

```bash
npx vitest run src/__tests__/sync/direct.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Create `src/sync/sources/direct.ts`**

```typescript
import type { DynamicEntry } from '../../registry/dynamic.js';
import { toCanonicalId } from '../../registry/canonical.js';

export interface DirectProviderConfig {
    name: string;
    endpoint: string;
    apiKey: string;
    /** Pricing must be supplied by Pharos (most direct /models endpoints don't include prices). */
    staticPricing: Record<string, { inputPerMillion: number; outputPerMillion: number }>;
}

export interface DirectFetchOptions {
    providers: DirectProviderConfig[];
    fetchFn?: typeof fetch;
    timeoutMs?: number;
}

interface OpenAICompatModel { id: string; object?: string }
interface OpenAICompatResponse { data: OpenAICompatModel[] }

export async function fetchDirectProviderModels(opts: DirectFetchOptions): Promise<DynamicEntry[]> {
    const fetchFn = opts.fetchFn ?? fetch;
    const timeoutMs = opts.timeoutMs ?? 5_000;

    const results = await Promise.all(opts.providers.map(p => fetchOne(p, fetchFn, timeoutMs)));
    return results.flat();
}

async function fetchOne(
    p: DirectProviderConfig,
    fetchFn: typeof fetch,
    timeoutMs: number,
): Promise<DynamicEntry[]> {
    if (!p.apiKey) return [];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
        res = await fetchFn(p.endpoint, {
            headers: { Authorization: `Bearer ${p.apiKey}` },
            signal: controller.signal,
        });
    } catch {
        clearTimeout(timer);
        return [];
    }
    clearTimeout(timer);

    if (!res.ok) return [];

    let body: OpenAICompatResponse;
    try { body = (await res.json()) as OpenAICompatResponse; } catch { return []; }
    if (!Array.isArray(body.data)) return [];

    const now = Date.now();
    const out: DynamicEntry[] = [];
    for (const m of body.data) {
        const pricing = p.staticPricing[m.id];
        if (!pricing) continue; // skip models we don't have a price for
        out.push({
            canonicalId: toCanonicalId(m.id, p.name),
            id: m.id,
            provider: p.name,
            source: 'direct',
            displayName: m.id,
            contextWindow: 0, // unknown from response; can be enriched later
            pricing,
            syncedAt: now,
        });
    }
    return out;
}
```

- [ ] **Step 4: Run test, verify pass**

```bash
npx vitest run src/__tests__/sync/direct.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sync/sources/direct.ts src/__tests__/sync/direct.test.ts
git commit -m "feat(sync): direct providers /v1/models fetcher with static pricing map"
```

---

## Task 10: Sync orchestrator

**Files:**
- Create: `src/sync/index.ts`
- Create: `src/__tests__/sync/orchestrator.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/__tests__/sync/orchestrator.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSync } from '../../sync/index.js';
import type { DynamicEntry } from '../../registry/dynamic.js';

const sample = (canonicalId: string, provider: string, source: DynamicEntry['source']): DynamicEntry => ({
    canonicalId, id: canonicalId.split('/')[1], provider, source,
    displayName: canonicalId, contextWindow: 0,
    pricing: { inputPerMillion: 1, outputPerMillion: 2 }, syncedAt: Date.now(),
});

describe('sync orchestrator', () => {
    let cachePath: string;
    beforeEach(() => { cachePath = join(tmpdir(), `pharos-orch-${Date.now()}-${Math.random()}.json`); });
    afterEach(async () => { try { await fs.unlink(cachePath); } catch { /* ignore */ } });

    it('merges results from all enabled sources', async () => {
        const result = await runSync({
            cachePath,
            sources: {
                huggingface: async () => [sample('a/b', 'hf-x', 'huggingface')],
                vercel: async () => [sample('c/d', 'vercel-gateway', 'vercel')],
                direct: async () => [sample('e/f', 'openai', 'direct')],
            },
        });
        expect(result.entries).toHaveLength(3);
        expect(result.perSource.huggingface).toBe(1);
        expect(result.perSource.vercel).toBe(1);
        expect(result.perSource.direct).toBe(1);
    });

    it('writes merged entries to cache file', async () => {
        await runSync({
            cachePath,
            sources: {
                huggingface: async () => [sample('a/b', 'hf-x', 'huggingface')],
                vercel: async () => [],
                direct: async () => [],
            },
        });
        const raw = await fs.readFile(cachePath, 'utf8');
        expect(raw).toContain('a/b');
    });

    it('falls back to cache when all sources return empty', async () => {
        // Seed cache with one entry
        const seed = [sample('z/y', 'hf-z', 'huggingface')];
        await fs.writeFile(cachePath, JSON.stringify({ version: 1, writtenAt: Date.now(), entries: seed }), 'utf8');

        const result = await runSync({
            cachePath,
            sources: {
                huggingface: async () => [],
                vercel: async () => [],
                direct: async () => [],
            },
        });
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].canonicalId).toBe('z/y');
        expect(result.usedCacheFallback).toBe(true);
    });

    it('returns empty when all sources empty and no cache', async () => {
        const result = await runSync({
            cachePath,
            sources: {
                huggingface: async () => [],
                vercel: async () => [],
                direct: async () => [],
            },
        });
        expect(result.entries).toEqual([]);
        expect(result.usedCacheFallback).toBe(false);
    });

    it('continues if one source throws', async () => {
        const result = await runSync({
            cachePath,
            sources: {
                huggingface: async () => { throw new Error('boom'); },
                vercel: async () => [sample('c/d', 'vercel-gateway', 'vercel')],
                direct: async () => [],
            },
        });
        expect(result.entries).toHaveLength(1);
        expect(result.errors.huggingface).toBeDefined();
    });
});
```

- [ ] **Step 2: Run test, verify fails**

```bash
npx vitest run src/__tests__/sync/orchestrator.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/sync/index.ts`**

```typescript
import { readCache, writeCache } from './cache.js';
import type { DynamicEntry } from '../registry/dynamic.js';

export type SourceFn = () => Promise<DynamicEntry[]>;

export interface RunSyncOptions {
    cachePath: string;
    sources: {
        huggingface: SourceFn;
        vercel: SourceFn;
        direct: SourceFn;
    };
}

export interface SyncResult {
    entries: DynamicEntry[];
    perSource: { huggingface: number; vercel: number; direct: number };
    errors: { huggingface?: string; vercel?: string; direct?: string };
    usedCacheFallback: boolean;
}

async function safe(name: keyof RunSyncOptions['sources'], fn: SourceFn): Promise<{ entries: DynamicEntry[]; error?: string }> {
    try {
        const e = await fn();
        return { entries: e };
    } catch (err) {
        return { entries: [], error: err instanceof Error ? err.message : String(err) };
    }
}

export async function runSync(opts: RunSyncOptions): Promise<SyncResult> {
    const [hf, vercel, direct] = await Promise.all([
        safe('huggingface', opts.sources.huggingface),
        safe('vercel', opts.sources.vercel),
        safe('direct', opts.sources.direct),
    ]);

    const merged = [...hf.entries, ...vercel.entries, ...direct.entries];

    const errors: SyncResult['errors'] = {};
    if (hf.error) errors.huggingface = hf.error;
    if (vercel.error) errors.vercel = vercel.error;
    if (direct.error) errors.direct = direct.error;

    if (merged.length > 0) {
        await writeCache(opts.cachePath, merged);
        return {
            entries: merged,
            perSource: { huggingface: hf.entries.length, vercel: vercel.entries.length, direct: direct.entries.length },
            errors,
            usedCacheFallback: false,
        };
    }

    // All sources returned empty — try cache fallback
    const cached = await readCache(opts.cachePath);
    if (cached && cached.length > 0) {
        return {
            entries: cached,
            perSource: { huggingface: 0, vercel: 0, direct: 0 },
            errors,
            usedCacheFallback: true,
        };
    }

    return {
        entries: [],
        perSource: { huggingface: 0, vercel: 0, direct: 0 },
        errors,
        usedCacheFallback: false,
    };
}
```

- [ ] **Step 4: Run test, verify pass**

```bash
npx vitest run src/__tests__/sync/orchestrator.test.ts
```
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sync/index.ts src/__tests__/sync/orchestrator.test.ts
git commit -m "feat(sync): orchestrator merges sources, persists cache, falls back"
```

---

## Task 11: Resolver

**Files:**
- Create: `src/registry/resolver.ts`
- Create: `src/__tests__/registry/resolver.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/__tests__/registry/resolver.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { resolvePaths } from '../../registry/resolver.js';
import { DynamicRegistry, type DynamicEntry } from '../../registry/dynamic.js';
import { setDynamicRegistryForTesting } from '../../registry/index.js';

const llamaGroq: DynamicEntry = {
    canonicalId: 'meta-llama/Llama-3.3-70B-Instruct', id: 'llama-3.3-70b-versatile',
    provider: 'groq', source: 'direct', displayName: 'Llama 70B',
    contextWindow: 128_000, pricing: { inputPerMillion: 0.59, outputPerMillion: 0.79 },
    syncedAt: 1,
};
const llamaHF: DynamicEntry = {
    canonicalId: 'meta-llama/Llama-3.3-70B-Instruct', id: 'meta-llama/Llama-3.3-70B-Instruct',
    provider: 'huggingface-together', source: 'huggingface', displayName: 'Llama 70B',
    contextWindow: 128_000, pricing: { inputPerMillion: 0.88, outputPerMillion: 0.88 },
    syncedAt: 1,
};
const llamaVercel: DynamicEntry = {
    canonicalId: 'meta-llama/Llama-3.3-70B-Instruct', id: 'meta-llama/Llama-3.3-70B-Instruct',
    provider: 'vercel-gateway', source: 'vercel', displayName: 'Llama 70B',
    contextWindow: 128_000, pricing: { inputPerMillion: 1.00, outputPerMillion: 1.00 },
    syncedAt: 1,
};

describe('resolver', () => {
    beforeEach(() => {
        const reg = new DynamicRegistry();
        reg.upsert(llamaGroq); reg.upsert(llamaHF); reg.upsert(llamaVercel);
        setDynamicRegistryForTesting(reg);
    });

    it('returns paths in preference order direct > huggingface > vercel', () => {
        const paths = resolvePaths('meta-llama/Llama-3.3-70B-Instruct', ['direct', 'huggingface', 'vercel']);
        expect(paths.map(p => p.source)).toEqual(['direct', 'huggingface', 'vercel']);
    });

    it('returns empty when canonicalId unknown', () => {
        expect(resolvePaths('nonexistent/model', ['direct', 'huggingface', 'vercel'])).toEqual([]);
    });

    it('respects custom preference order', () => {
        const paths = resolvePaths('meta-llama/Llama-3.3-70B-Instruct', ['vercel', 'direct', 'huggingface']);
        expect(paths.map(p => p.source)).toEqual(['vercel', 'direct', 'huggingface']);
    });
});
```

- [ ] **Step 2: Run test, verify fails**

```bash
npx vitest run src/__tests__/registry/resolver.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Create `src/registry/resolver.ts`**

```typescript
import { getMergedRegistry } from './index.js';
import type { SyncSource } from './dynamic.js';

export interface ResolvedPath {
    provider: string;
    id: string;
    source: SyncSource | 'static';
    pricing: { inputPerMillion: number; outputPerMillion: number };
}

export function resolvePaths(
    canonicalId: string,
    preference: ('direct' | 'huggingface' | 'vercel')[],
): ResolvedPath[] {
    const all = getMergedRegistry().filter(e => e.canonicalId === canonicalId);
    if (all.length === 0) return [];

    const rank: Record<string, number> = {};
    preference.forEach((p, i) => { rank[p] = i; });
    // static always last unless explicitly listed
    if (!('static' in rank)) rank.static = preference.length;

    const sorted = all.slice().sort((a, b) => {
        const ra = rank[a.source] ?? Number.MAX_SAFE_INTEGER;
        const rb = rank[b.source] ?? Number.MAX_SAFE_INTEGER;
        if (ra !== rb) return ra - rb;
        // tiebreak by cheaper input
        return a.pricing.inputPerMillion - b.pricing.inputPerMillion;
    });

    return sorted.map(e => ({
        provider: e.provider,
        id: e.id,
        source: e.source,
        pricing: e.pricing,
    }));
}
```

- [ ] **Step 4: Run test, verify pass**

```bash
npx vitest run src/__tests__/registry/resolver.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/registry/resolver.ts src/__tests__/registry/resolver.test.ts
git commit -m "feat(registry): resolver picks cheapest available provider path"
```

---

## Task 12: Tier populator

**Files:**
- Create: `src/sync/tier-populator.ts`
- Create: `src/__tests__/sync/tier-populator.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/__tests__/sync/tier-populator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { populateTiers } from '../../sync/tier-populator.js';
import type { MergedEntry } from '../../registry/index.js';
import type { TierPriceBoundaries } from '../../config/schema.js';

const boundaries: TierPriceBoundaries = {
    free:       { tier: [1, 3], maxInputPerMillion: 0.10, maxOutputPerMillion: 0.40 },
    economical: { tier: [4, 6], maxInputPerMillion: 1.00, maxOutputPerMillion: 4.00 },
    premium:    { tier: [7, 8], maxInputPerMillion: 5.00, maxOutputPerMillion: 20.00 },
    frontier:   { tier: [9, 10], maxInputPerMillion: 999,  maxOutputPerMillion: 999 },
};

const sample = (provider: string, id: string, ip: number, op: number): MergedEntry => ({
    canonicalId: `x/${id}`, id, provider,
    displayName: id, contextWindow: 0,
    pricing: { inputPerMillion: ip, outputPerMillion: op },
    source: 'direct',
});

describe('tier populator', () => {
    it('buckets models by input+output price boundaries', () => {
        const merged: MergedEntry[] = [
            sample('google', 'gemini-2.5-flash', 0.075, 0.30),  // free
            sample('groq',   'llama-3.3-70b-versatile', 0.59, 0.79),  // economical
            sample('anthropic', 'claude-sonnet-4-20250514', 3.0, 15.0),  // premium
            sample('anthropic', 'claude-opus-4-20250514', 15.0, 75.0),  // frontier
        ];
        const tiers = populateTiers(merged, boundaries);
        expect(tiers.free.models).toEqual([{ provider: 'google', model: 'gemini-2.5-flash' }]);
        expect(tiers.economical.models).toEqual([{ provider: 'groq', model: 'llama-3.3-70b-versatile' }]);
        expect(tiers.premium.models).toEqual([{ provider: 'anthropic', model: 'claude-sonnet-4-20250514' }]);
        expect(tiers.frontier.models).toEqual([{ provider: 'anthropic', model: 'claude-opus-4-20250514' }]);
    });

    it('sorts each tier ascending by input price', () => {
        const merged: MergedEntry[] = [
            sample('groq',   'llama-3.3-70b-versatile', 0.59, 0.79),
            sample('moonshot','kimi-latest', 0.50, 2.00),
            sample('deepseek','deepseek-chat', 0.27, 1.10),
        ];
        const tiers = populateTiers(merged, boundaries);
        expect(tiers.economical.models[0].provider).toBe('deepseek');
        expect(tiers.economical.models[2].provider).toBe('groq');
    });

    it('produces empty model list if no entry fits a tier', () => {
        const merged: MergedEntry[] = [sample('anthropic', 'claude-opus-4', 15, 75)];
        const tiers = populateTiers(merged, boundaries);
        expect(tiers.free.models).toEqual([]);
        expect(tiers.economical.models).toEqual([]);
        expect(tiers.premium.models).toEqual([]);
        expect(tiers.frontier.models).toHaveLength(1);
    });

    it('returns scoreRange matching boundaries', () => {
        const tiers = populateTiers([], boundaries);
        expect(tiers.free.scoreRange).toEqual([1, 3]);
        expect(tiers.frontier.scoreRange).toEqual([9, 10]);
    });
});
```

- [ ] **Step 2: Run test, verify fails**

```bash
npx vitest run src/__tests__/sync/tier-populator.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/sync/tier-populator.ts`**

```typescript
import type { MergedEntry } from '../registry/index.js';
import type { TierPriceBoundaries, ModelEntry } from '../config/schema.js';

export interface PopulatedTier {
    scoreRange: [number, number];
    models: ModelEntry[];
}

export type PopulatedTiers = Record<'free' | 'economical' | 'premium' | 'frontier', PopulatedTier>;

const TIER_ORDER: (keyof PopulatedTiers)[] = ['free', 'economical', 'premium', 'frontier'];

export function populateTiers(merged: MergedEntry[], boundaries: TierPriceBoundaries): PopulatedTiers {
    const result = {} as PopulatedTiers;

    for (const name of TIER_ORDER) {
        const b = boundaries[name];
        const inTier = merged
            .filter(m =>
                m.pricing.inputPerMillion  <= b.maxInputPerMillion &&
                m.pricing.outputPerMillion <= b.maxOutputPerMillion,
            )
            // for `free`, also exclude models that fit a cheaper tier — already cheapest, no-op
            // for higher tiers, exclude what fits a cheaper tier so each model lives in exactly one tier
            .filter(m => bestTierFor(m, boundaries) === name)
            .sort((a, b2) => a.pricing.inputPerMillion - b2.pricing.inputPerMillion)
            .map(m => ({ provider: m.provider, model: m.id }));

        result[name] = { scoreRange: b.tier, models: inTier };
    }

    return result;
}

function bestTierFor(m: MergedEntry, boundaries: TierPriceBoundaries): keyof PopulatedTiers {
    for (const name of TIER_ORDER) {
        const b = boundaries[name];
        if (m.pricing.inputPerMillion <= b.maxInputPerMillion && m.pricing.outputPerMillion <= b.maxOutputPerMillion) {
            return name;
        }
    }
    return 'frontier';
}
```

- [ ] **Step 4: Run test, verify pass**

```bash
npx vitest run src/__tests__/sync/tier-populator.test.ts
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sync/tier-populator.ts src/__tests__/sync/tier-populator.test.ts
git commit -m "feat(sync): tier populator buckets models by price boundaries"
```

---

## Task 13: Router snapshot test (baseline before integration)

**Files:**
- Create: `src/__tests__/router/snapshot.test.ts`

This test captures current routing behavior so post-integration we can confirm no regression.

- [ ] **Step 1: Write the snapshot test**

Create `src/__tests__/router/snapshot.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../config/loader.js';
import { Logger } from '../../utils/logger.js';
import { ProviderRegistry } from '../../providers/index.js';
import { ModelRouter } from '../../router/index.js';
import type { ClassificationResult } from '../../classifier/types.js';

describe('router snapshot (pre-sync, default config)', () => {
    const config = loadConfig();
    const logger = new Logger({ level: 'silent' });
    const providers = new ProviderRegistry(config, logger);
    const router = new ModelRouter(config, providers, logger);

    it('tier 2 routes to a free-tier model', () => {
        const c: ClassificationResult = { score: 2, type: 'conversation', model: 'kimi-latest', latency: 1, confidence: 1 };
        const decision = router.route(c);
        const tierModels = config.tiers.free.models.map(m => `${m.provider}:${m.model}`);
        expect(tierModels).toContain(`${decision.provider}:${decision.model}`);
    });

    it('tier 5 routes to an economical-tier model', () => {
        const c: ClassificationResult = { score: 5, type: 'conversation', model: 'kimi-latest', latency: 1, confidence: 1 };
        const decision = router.route(c);
        const tierModels = config.tiers.economical.models.map(m => `${m.provider}:${m.model}`);
        expect(tierModels).toContain(`${decision.provider}:${decision.model}`);
    });

    it('tier 10 routes to frontier-tier model', () => {
        const c: ClassificationResult = { score: 10, type: 'reasoning', model: 'kimi-latest', latency: 1, confidence: 1 };
        const decision = router.route(c);
        const tierModels = config.tiers.frontier.models.map(m => `${m.provider}:${m.model}`);
        expect(tierModels).toContain(`${decision.provider}:${decision.model}`);
    });
});
```

- [ ] **Step 2: Run test, confirm it passes against current code**

```bash
npx vitest run src/__tests__/router/snapshot.test.ts
```
Expected: PASS (3 tests). If any FAIL, the `ClassificationResult` shape may differ — check `src/classifier/types.ts` and fix the test stub accordingly.

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/router/snapshot.test.ts
git commit -m "test(router): snapshot baseline before catalog sync integration"
```

---

## Task 14: Cron scheduler

**Files:**
- Create: `src/sync/cron.ts`
- Create: `src/__tests__/sync/cron.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/__tests__/sync/cron.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startSyncCron, stopSyncCron } from '../../sync/cron.js';

describe('sync cron', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); stopSyncCron(); });

    it('invokes job at every interval', async () => {
        const job = vi.fn().mockResolvedValue(undefined);
        startSyncCron({ intervalMs: 1000, job });

        await vi.advanceTimersByTimeAsync(1000);
        expect(job).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1000);
        expect(job).toHaveBeenCalledTimes(2);
    });

    it('stopSyncCron prevents further invocations', async () => {
        const job = vi.fn().mockResolvedValue(undefined);
        startSyncCron({ intervalMs: 1000, job });
        stopSyncCron();
        await vi.advanceTimersByTimeAsync(5000);
        expect(job).not.toHaveBeenCalled();
    });

    it('continues running even if a job throws', async () => {
        const job = vi.fn()
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValue(undefined);
        startSyncCron({ intervalMs: 1000, job });
        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(1000);
        expect(job).toHaveBeenCalledTimes(2);
    });
});
```

- [ ] **Step 2: Run test, verify fails**

```bash
npx vitest run src/__tests__/sync/cron.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Create `src/sync/cron.ts`**

```typescript
type Job = () => Promise<void>;

let timer: ReturnType<typeof setInterval> | null = null;

export interface StartCronOptions {
    intervalMs: number;
    job: Job;
}

export function startSyncCron(opts: StartCronOptions): void {
    stopSyncCron();
    timer = setInterval(() => {
        opts.job().catch(() => { /* swallow; next tick will retry */ });
    }, opts.intervalMs);
}

export function stopSyncCron(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}
```

- [ ] **Step 4: Run test, verify pass**

```bash
npx vitest run src/__tests__/sync/cron.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sync/cron.ts src/__tests__/sync/cron.test.ts
git commit -m "feat(sync): setInterval-based cron scheduler"
```

---

## Task 15: Provider registration + env vars + config

**Files:**
- Modify: `src/providers/index.ts`
- Modify: `config/pharos.default.yaml`
- Modify: `.env.example`

- [ ] **Step 1: Update `.env.example`**

Append to `.env.example`:

```bash

# Hugging Face Inference Providers (Slice A — universal catalog)
HUGGINGFACE_API_KEY=

# Vercel AI Gateway (Slice A — universal catalog)
VERCEL_AI_GATEWAY_KEY=
```

- [ ] **Step 2: Update `config/pharos.default.yaml`**

Append to the existing `providers:` block (preserve existing entries):

```yaml
  huggingface:
    apiKeyEnv: HUGGINGFACE_API_KEY
    baseUrl: https://router.huggingface.co/v1
    timeoutMs: 30000

  vercel_gateway:
    apiKeyEnv: VERCEL_AI_GATEWAY_KEY
    baseUrl: https://ai-gateway.vercel.sh/v1
    timeoutMs: 30000
```

Append at the bottom of the file (after the last existing top-level key):

```yaml

# Universal catalog sync
sync:
  enabled: true
  intervalHours: 24
  cacheFile: ./data/catalog-cache.json
  sources:
    huggingface:
      enabled: true
      endpoint: https://router.huggingface.co/v1/models
    vercel:
      enabled: true
      endpoint: https://ai-gateway.vercel.sh/v1/models
    direct:
      enabled: true

tierPriceBoundaries:
  free:       { tier: [1, 3], maxInputPerMillion: 0.10, maxOutputPerMillion: 0.40 }
  economical: { tier: [4, 6], maxInputPerMillion: 1.00, maxOutputPerMillion: 4.00 }
  premium:    { tier: [7, 8], maxInputPerMillion: 5.00, maxOutputPerMillion: 20.00 }
  frontier:   { tier: [9, 10], maxInputPerMillion: 999,  maxOutputPerMillion: 999 }

resolver:
  preference: [direct, huggingface, vercel]
```

- [ ] **Step 3: Verify config loads cleanly**

```bash
npx tsx -e "import('./src/config/loader.js').then(m => { const c = m.loadConfig(); console.log('OK', !!c.sync, !!c.tierPriceBoundaries, !!c.resolver); })"
```
Expected: `OK true true true`.

- [ ] **Step 4: Update `src/providers/index.ts`**

In `initializeProviders`, no per-provider code change needed — the existing `default` branch in the switch already handles arbitrary `openai-compat` providers including `huggingface` and `vercel_gateway`. Verify by reading the file.

If the config schema requires every provider to be listed in a static union, update the relevant schema to accept the two new keys. (Check `src/config/schema.ts` for any provider-name enum and extend it if found.)

- [ ] **Step 5: Run test suite**

```bash
npm test
```
Expected: all existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add .env.example config/pharos.default.yaml src/providers/index.ts src/config/schema.ts
git commit -m "feat(providers): register hugging face + vercel gateway providers"
```

---

## Task 16: Server boot wiring

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Inspect current `src/server.ts` to find boot-completion hook**

```bash
grep -n "listen\|start\|boot\|init" /Users/ghostfx/PHAROS/src/server.ts | head -20
```

Identify the function that runs after `fastify.listen(...)` resolves successfully.

- [ ] **Step 2: Add sync wiring**

In `src/server.ts`, after the server starts listening and provider registry is constructed, add:

```typescript
import { runSync } from './sync/index.js';
import { fetchHuggingFaceModels } from './sync/sources/huggingface.js';
import { fetchVercelGatewayModels } from './sync/sources/vercel.js';
import { fetchDirectProviderModels, type DirectProviderConfig } from './sync/sources/direct.js';
import { setDynamicRegistry, getMergedRegistry } from './registry/index.js';
import { DynamicRegistry } from './registry/dynamic.js';
import { populateTiers } from './sync/tier-populator.js';
import { startSyncCron } from './sync/cron.js';

// Direct provider catalog config — pricing maps live here until enriched
const DIRECT_PROVIDERS: Omit<DirectProviderConfig, 'apiKey'>[] = [
    { name: 'openai', endpoint: 'https://api.openai.com/v1/models', staticPricing: {
        'gpt-4o':  { inputPerMillion: 2.5, outputPerMillion: 10.0 },
        'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.60 },
        'o3': { inputPerMillion: 2.0, outputPerMillion: 8.0 },
    }},
    { name: 'groq',   endpoint: 'https://api.groq.com/openai/v1/models', staticPricing: {
        'llama-3.3-70b-versatile': { inputPerMillion: 0.59, outputPerMillion: 0.79 },
    }},
    // Anthropic / xAI / Moonshot have no public list — covered by static seed
];

async function performSync(): Promise<void> {
    if (!config.sync?.enabled) return;

    const hfKey = process.env.HUGGINGFACE_API_KEY ?? '';
    const vercelKey = process.env.VERCEL_AI_GATEWAY_KEY ?? '';

    const result = await runSync({
        cachePath: config.sync.cacheFile,
        sources: {
            huggingface: async () => hfKey ? fetchHuggingFaceModels({ endpoint: config.sync!.sources.huggingface.endpoint!, apiKey: hfKey }) : [],
            vercel:      async () => vercelKey ? fetchVercelGatewayModels({ endpoint: config.sync!.sources.vercel.endpoint!, apiKey: vercelKey }) : [],
            direct:      async () => fetchDirectProviderModels({
                providers: DIRECT_PROVIDERS.map(p => ({
                    ...p,
                    apiKey: process.env[`${p.name.toUpperCase()}_API_KEY`] ?? '',
                })),
            }),
        },
    });

    const reg = new DynamicRegistry();
    reg.replaceAll(result.entries);
    setDynamicRegistry(reg);

    if (config.tierPriceBoundaries) {
        const tiers = populateTiers(getMergedRegistry(), config.tierPriceBoundaries);
        // Mutate config in-place so router picks up new lists
        for (const [name, populated] of Object.entries(tiers)) {
            if (populated.models.length > 0 && config.tiers[name as keyof typeof config.tiers]) {
                config.tiers[name as keyof typeof config.tiers].models = populated.models;
            }
        }
    }

    logger.info({
        total: result.entries.length,
        perSource: result.perSource,
        errors: result.errors,
        usedCacheFallback: result.usedCacheFallback,
    }, 'catalog sync complete');
}

// In the boot path, after fastify.listen(...) succeeds:
void performSync().catch(err => logger.error({ err }, 'initial catalog sync failed'));

if (config.sync?.enabled) {
    startSyncCron({
        intervalMs: config.sync.intervalHours * 60 * 60 * 1000,
        job: performSync,
    });
}
```

(Adjust import-of-`config` and `logger` variable names to match what `src/server.ts` already uses — they should already exist in that scope.)

- [ ] **Step 3: Build TypeScript to catch type errors**

```bash
npm run build
```
Expected: clean build.

- [ ] **Step 4: Run full test suite**

```bash
npm test
```
Expected: all tests pass, including the router snapshot from Task 13.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): wire catalog sync into boot path with 24h cron"
```

---

## Task 17: Slim `src/registry/models.ts`

**Files:**
- Modify: `src/registry/models.ts`

- [ ] **Step 1: Inspect current usage**

```bash
grep -rn "MODEL_REGISTRY\|from.*registry/models" /Users/ghostfx/PHAROS/src | grep -v __tests__
```

Identify call sites that read `MODEL_REGISTRY`. If they all go through `src/registry/index.ts`, the array can be reduced to a re-export of static seed.

- [ ] **Step 2: Replace the body of `src/registry/models.ts`**

Preserve the existing types/exports, but slim the array. Keep at least the legacy types used by importers; ensure `MODEL_REGISTRY` itself is derived from `STATIC_SEED`.

```typescript
/**
 * Model Registry — metadata catalog for known models.
 *
 * As of Slice A (universal catalog), this file is intentionally minimal.
 * The 56-entry hand-coded array has been replaced by:
 *   - src/registry/static.ts  (emergency seed, ~6 entries)
 *   - src/registry/dynamic.ts (runtime sync cache)
 *   - src/registry/index.ts   (merged view via getMergedRegistry())
 *
 * MODEL_REGISTRY remains exported as a derived view of static seed
 * so legacy consumers (registry helpers) continue working unchanged.
 */

import { STATIC_SEED } from './static.js';

export type ModelCapability =
    | 'code' | 'math' | 'reasoning' | 'creative' | 'conversation'
    | 'multilingual' | 'embedding' | 'tts' | 'stt' | 'image' | 'video';

export type SpeedTier = 'fast' | 'medium' | 'slow';

export interface ModelPricing {
    inputPerMillion: number;
    outputPerMillion: number;
}

export interface ModelRegistryEntry {
    id: string;
    provider: string;
    displayName: string;
    contextWindow: number;
    capabilities: ModelCapability[];
    pricing: ModelPricing;
    speed: SpeedTier;
}

export const MODEL_REGISTRY: ModelRegistryEntry[] = STATIC_SEED.map(s => ({
    id: s.id,
    provider: s.provider,
    displayName: s.displayName,
    contextWindow: s.contextWindow,
    capabilities: ['conversation'],
    pricing: s.pricing,
    speed: 'medium',
}));
```

- [ ] **Step 3: Run full test suite**

```bash
npm test
```
Expected: all tests pass. Any test that hard-references one of the deleted 50 models needs review — either update the test to use a model in the seed or rely on `getMergedRegistry()`.

- [ ] **Step 4: Run build**

```bash
npm run build
```
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/registry/models.ts
git commit -m "refactor(registry): slim models.ts to static-seed re-export"
```

---

## Task 18: End-to-end integration test (synthetic new model)

**Files:**
- Create: `src/__tests__/sync/e2e-new-model.test.ts`

- [ ] **Step 1: Write the integration test**

Create `src/__tests__/sync/e2e-new-model.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSync } from '../../sync/index.js';
import { setDynamicRegistry, getMergedRegistry } from '../../registry/index.js';
import { DynamicRegistry } from '../../registry/dynamic.js';
import { populateTiers } from '../../sync/tier-populator.js';
import type { TierPriceBoundaries } from '../../config/schema.js';

const boundaries: TierPriceBoundaries = {
    free:       { tier: [1, 3], maxInputPerMillion: 0.10, maxOutputPerMillion: 0.40 },
    economical: { tier: [4, 6], maxInputPerMillion: 1.00, maxOutputPerMillion: 4.00 },
    premium:    { tier: [7, 8], maxInputPerMillion: 5.00, maxOutputPerMillion: 20.00 },
    frontier:   { tier: [9, 10], maxInputPerMillion: 999, maxOutputPerMillion: 999 },
};

describe('e2e: new HF model appears, gets bucketed', () => {
    let cachePath: string;
    beforeEach(() => { cachePath = join(tmpdir(), `pharos-e2e-${Date.now()}.json`); });

    it('synthetic new HF model lands in correct tier', async () => {
        const syntheticModel = {
            canonicalId: 'new-org/Shiny-Cheap-Model',
            id: 'new-org/Shiny-Cheap-Model',
            provider: 'huggingface-novita',
            source: 'huggingface' as const,
            displayName: 'Shiny Cheap',
            contextWindow: 128_000,
            pricing: { inputPerMillion: 0.05, outputPerMillion: 0.10 },
            syncedAt: Date.now(),
        };

        const result = await runSync({
            cachePath,
            sources: {
                huggingface: async () => [syntheticModel],
                vercel: async () => [],
                direct: async () => [],
            },
        });

        const reg = new DynamicRegistry();
        reg.replaceAll(result.entries);
        setDynamicRegistry(reg);

        const merged = getMergedRegistry();
        expect(merged.find(m => m.canonicalId === 'new-org/Shiny-Cheap-Model')).toBeDefined();

        const tiers = populateTiers(merged, boundaries);
        const freeIds = tiers.free.models.map(m => m.model);
        expect(freeIds).toContain('new-org/Shiny-Cheap-Model');

        await fs.unlink(cachePath).catch(() => {});
    });
});
```

- [ ] **Step 2: Run test, verify pass**

```bash
npx vitest run src/__tests__/sync/e2e-new-model.test.ts
```
Expected: PASS (1 test).

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/sync/e2e-new-model.test.ts
git commit -m "test(sync): e2e — new HF model is auto-bucketed into correct tier"
```

---

## Task 19: Verification gates + manual deploy

**Files:** none (verification only)

- [ ] **Step 1: Full local test suite**

```bash
npm test
```
Expected: all tests pass (existing 1120 + new tests added in this plan).

- [ ] **Step 2: Lint**

```bash
npm run lint
```
Expected: clean.

- [ ] **Step 3: TypeScript build**

```bash
npm run build
```
Expected: clean.

- [ ] **Step 4: Deploy to Fly staging**

```bash
fly secrets set HUGGINGFACE_API_KEY=hf_xxxxx -a pharos-staging
fly secrets set VERCEL_AI_GATEWAY_KEY=vck_xxxxx -a pharos-staging
fly deploy -a pharos-staging
```

- [ ] **Step 5: Smoke test `/v1/models` shows HF + Vercel entries**

```bash
curl -s https://pharos-staging.fly.dev/v1/models -H "Authorization: Bearer $PHAROS_STAGING_KEY" | jq '.data[] | select(.id | contains("huggingface") or contains("vercel")) | .id' | head -20
```
Expected: at least several HF + Vercel-sourced IDs returned.

- [ ] **Step 6: Smoke test routing**

```bash
curl -s https://pharos-staging.fly.dev/v1/chat/completions \
  -H "Authorization: Bearer $PHAROS_STAGING_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "model": "pharos-auto", "messages": [{ "role": "user", "content": "say hi" }] }' \
  | jq '.model, .usage'
```
Expected: response returned, `model` field shows a model from the populated tier set.

- [ ] **Step 7: Verify graceful degradation (no keys)**

```bash
fly secrets unset HUGGINGFACE_API_KEY -a pharos-staging
fly secrets unset VERCEL_AI_GATEWAY_KEY -a pharos-staging
fly deploy -a pharos-staging
curl -s https://pharos-staging.fly.dev/v1/models | jq '.data | length'
```
Expected: response returns a non-empty model list sourced from static seed + direct providers; Pharos still serves chat completions.

Re-set secrets after this check.

- [ ] **Step 8: Verify cache fallback**

In staging logs (Sentry or Fly logs), trigger a sync where HF + Vercel are temporarily unreachable (e.g., wrong endpoint in config), confirm:
- log line `catalog sync complete` with `usedCacheFallback: true`
- catalog still healthy

(Optional in this slice — can be deferred to next operational tweak if low-priority.)

- [ ] **Step 9: Final commit + tag**

```bash
git tag slice-a-universal-catalog-shipped
git push origin slice-a-universal-catalog-shipped
```

(Only run `git push` if user explicitly authorizes.)

---

## Self-review

**Spec coverage check:**
- §4.1 component changes — Tasks 2, 4, 6, 11, 12, 14, 15 covered
- §4.2 data flow — Tasks 13, 16 verify
- §4.3 boot flow — Task 16
- §4.4 sync orchestrator — Task 10
- §5.1 new files — all 11 covered (Tasks 2-14)
- §5.2 modified files — Tasks 1 (schema), 6 (registry/index.ts), 15 (providers, config, env), 16 (server), 17 (models.ts)
- §6 configuration — Tasks 1 (schema), 15 (YAML + env)
- §7 testing — every task has tests; Task 18 covers goal verification; Task 19 covers verification gates

**Placeholder scan:** no TBD / TODO / "implement later" remaining; every code block is complete.

**Type consistency:** `DynamicEntry` shape is identical across all sync sources and the cache. `MergedEntry` exported once from `registry/index.ts` and consumed by `tier-populator`. `populateTiers` returns `PopulatedTiers` consumed by `src/server.ts`. Direct-provider static pricing map present in Task 9 source and Task 16 wiring with same shape.

**Open items confirmed:** Tier price boundaries are intentional starting values per spec §6.2; tune at Task 19 step 5 using observed staging data.
