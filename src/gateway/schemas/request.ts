import { z } from 'zod';

/**
 * Zod schema for validating OpenAI-compatible chat completion requests.
 */

export const ChatMessageSchema = z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string().max(500000),
});

export const ChatCompletionRequestSchema = z.object({
    model: z.string().default('pharos-auto'),
    messages: z.array(ChatMessageSchema).min(1).max(100),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().optional(),
    top_p: z.number().min(0).max(1).optional(),
    stream: z.boolean().default(false),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    presence_penalty: z.number().optional(),
    frequency_penalty: z.number().optional(),
    user: z.string().optional(),
});

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;
