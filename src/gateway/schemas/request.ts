import { z } from 'zod';

/**
 * Zod schema for validating OpenAI-compatible chat completion requests.
 *
 * Content can be a plain string or an array of content parts (text, image_url)
 * per the OpenAI API spec. Array format is used for multimodal messages.
 */

const ContentPartSchema = z.union([
    z.object({ type: z.literal('text'), text: z.string().max(500000) }),
    z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string(), detail: z.string().optional() }) }),
    // Catch-all for other content part types (e.g. audio, file)
    z.object({ type: z.string() }).passthrough(),
]);

export const ChatMessageSchema = z.object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.union([z.string().max(500000), z.array(ContentPartSchema), z.null()]),
    name: z.string().optional(),
    tool_call_id: z.string().optional(),
    tool_calls: z.array(z.any()).optional(),
});

const ToolDefinitionSchema = z.object({
    type: z.literal('function'),
    function: z.object({
        name: z.string(),
        description: z.string().optional(),
        parameters: z.record(z.unknown()).default({}),
    }),
});

const ToolChoiceSchema = z.union([
    z.enum(['auto', 'required', 'none']),
    z.object({
        type: z.literal('function'),
        function: z.object({ name: z.string() }),
    }),
]);

export const ChatCompletionRequestSchema = z.object({
    model: z.string().default('pharos-auto'),
    messages: z.array(ChatMessageSchema).min(1).max(500),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().optional(),
    top_p: z.number().min(0).max(1).optional(),
    stream: z.boolean().default(false),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    presence_penalty: z.number().optional(),
    frequency_penalty: z.number().optional(),
    user: z.string().optional(),
    // Phase 2.5 Tier 2: tool_use parity with /v1/messages.
    tools: z.array(ToolDefinitionSchema).optional(),
    tool_choice: ToolChoiceSchema.optional(),
    // Anthropic extended thinking — passed through to Anthropic, ignored for other providers
    thinking: z.union([
        z.object({ type: z.literal('enabled'), budget_tokens: z.number().int().positive() }),
        z.object({ type: z.literal('disabled') }),
        z.string(),
    ]).optional(),
});

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;
