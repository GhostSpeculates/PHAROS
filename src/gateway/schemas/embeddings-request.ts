import { z } from 'zod';

/**
 * Zod schema for OpenAI-compatible /v1/embeddings requests.
 *
 * Matches OpenAI's input shape so any OpenAI SDK client works against
 * Pharos with a swapped baseURL. The model field accepts:
 *   - "pharos-embed:auto"        → cost-priority routing
 *   - "pharos-embed:<agent-id>"  → same routing, agent-id used for tracking + rate limiting
 */

export const EmbeddingsRequestSchema = z.object({
    model: z.string().default('pharos-embed:auto'),
    input: z.union([
        z.string().max(500_000),
        z.array(z.string().max(500_000)).min(1).max(2048),
    ]),
    user: z.string().optional(),
    encoding_format: z.enum(['float', 'base64']).optional(),
    dimensions: z.number().int().positive().optional(),
});

export type EmbeddingsRequest = z.infer<typeof EmbeddingsRequestSchema>;
