import { z } from 'zod';

/**
 * Zod schema for POST /v1/videos/generations.
 *
 * No industry standard for video gen API; this shape mirrors OpenAI image API
 * conventions where they apply, plus video-specific fields (duration_seconds,
 * resolution, image_url for image-to-video).
 *
 * Model field accepts:
 *   - "pharos-video:auto"        → quality-tier routing (default tier: balanced)
 *   - "pharos-video:<agent-id>"  → same routing, agent-id used for tracking + rate limit
 */

export const VideosRequestSchema = z.object({
    model: z.string().default('pharos-video:auto'),
    prompt: z.string().min(1).max(4000),
    /** Defaults to 5s — Kling/most providers' minimum and cheapest billing unit. */
    duration_seconds: z.number().int().min(3).max(60).default(5),
    /** Coerced per-provider; we accept the common labels and map internally. */
    resolution: z.enum(['720p', '1080p']).default('1080p'),
    /** Pharos extension — drives quality-tier routing. */
    quality: z.enum(['cheapest', 'balanced', 'best']).optional(),
    /** Optional starting frame for image-to-video. */
    image_url: z.string().url().optional(),
    seed: z.number().int().optional(),
});

export type VideosRequest = z.infer<typeof VideosRequestSchema>;
