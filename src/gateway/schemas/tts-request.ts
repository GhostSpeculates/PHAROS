import { z } from 'zod';

/**
 * Zod schema for OpenAI-compatible /v1/audio/speech requests.
 *
 * Matches OpenAI's input shape for portability + adds Pharos extensions
 * (voice_clone_id, realtime) used by TTSRouter for smart-routing.
 *
 * Model field accepts:
 *   - "pharos-tts:auto"        → cost-priority routing (OpenAI default)
 *   - "pharos-tts:<agent-id>"  → same routing, agent-id for tracking + rate limiting
 */

export const TTSRequestSchema = z.object({
    model: z.string().default('pharos-tts:auto'),
    input: z.string().min(1).max(4096),
    voice: z.string().min(1),
    response_format: z.enum(['mp3', 'wav', 'opus', 'flac', 'pcm', 'aac']).optional(),
    speed: z.number().min(0.25).max(4.0).optional(),
    /** Pharos extension — when set, force route to ElevenLabs and use this as voice_id. */
    voice_clone_id: z.string().optional(),
    /** Pharos extension — when true, force route to Cartesia (sub-100ms latency). */
    realtime: z.boolean().optional(),
});

export type TTSRequest = z.infer<typeof TTSRequestSchema>;
