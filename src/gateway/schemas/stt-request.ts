import { z } from 'zod';

/**
 * Zod schema for OpenAI-compatible /v1/audio/transcriptions form fields.
 *
 * Applied AFTER multipart parsing — call this on a plain object of parsed
 * form fields, NOT on request.body directly (multipart bodies bypass JSON
 * body parsing).
 *
 * The model field accepts colon-suffix agent IDs:
 *   "pharos-stt:auto"       → default Groq routing
 *   "pharos-stt:my-agent"   → same routing, agent tracked
 *
 * Pharos extensions (not in OpenAI spec):
 *   realtime  → true routes to Deepgram (latency-tier-1)
 *   streaming → true routes to Cartesia (streaming mode)
 */
export const STTRequestSchema = z.object({
    // Required
    model: z.string().default('pharos-stt:auto'),

    // Optional — OpenAI spec fields
    language: z.string().optional(),
    prompt: z.string().optional(),
    response_format: z.enum(['json', 'text', 'verbose_json', 'srt', 'vtt']).default('json'),
    temperature: z.coerce.number().min(0).max(1).optional(),

    // Pharos extensions
    realtime: z
        .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
        .transform((v) => v === true || v === 'true' || v === '1')
        .optional(),
    streaming: z
        .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
        .transform((v) => v === true || v === 'true' || v === '1')
        .optional(),
});

export type STTRequest = z.infer<typeof STTRequestSchema>;
