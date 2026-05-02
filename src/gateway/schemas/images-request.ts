import { z } from 'zod';

/**
 * Zod schema for /v1/images/generations.
 *
 * Mirrors OpenAI's request shape for portability + adds Pharos's actual product
 * wedge: `quality: "best" | "balanced" | "cheapest"` — the only image-gen
 * aggregator API parameter that auto-selects per-request.
 *
 * Model field accepts:
 *   - "pharos-image:auto"        → quality-tier routing (default tier: balanced)
 *   - "pharos-image:<agent-id>"  → same routing, agent-id used for tracking + rate limit
 */

export const ImagesRequestSchema = z.object({
    model: z.string().default('pharos-image:auto'),
    prompt: z.string().min(1).max(4000),
    n: z.number().int().min(1).max(10).optional(),
    size: z.enum(['1024x1024', '1024x1792', '1792x1024', '512x512', '256x256']).optional(),
    response_format: z.enum(['url', 'b64_json']).optional(),
    user: z.string().optional(),
    /** Pharos extension — drives quality-tier routing. Defaults to "balanced". */
    quality: z.enum(['cheapest', 'balanced', 'best']).optional(),
    /** Optional reproducibility seed (not all providers honor it). */
    seed: z.number().int().optional(),
});

export type ImagesRequest = z.infer<typeof ImagesRequestSchema>;
