// src/translation/types.ts
import { z } from 'zod';

// ─── Anthropic content blocks ───
const TextBlockSchema = z.object({
    type: z.literal('text'),
    text: z.string().max(500000),
});

// `input` here = arguments the model supplied for the tool call.
// (Compare with `AnthropicToolSchema.input_schema` = JSON Schema definition of the tool.)
const ToolUseBlockSchema = z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.record(z.unknown()),
});

const ToolResultBlockSchema = z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.union([
        z.string(),
        z.array(z.object({ type: z.literal('text'), text: z.string() })),
    ]),
    is_error: z.boolean().optional(),
});

const ImageBlockSchema = z.object({
    type: z.literal('image'),
    source: z.union([
        z.object({
            type: z.literal('base64'),
            media_type: z.string(),
            data: z.string(),
        }),
        z.object({ type: z.literal('url'), url: z.string() }),
    ]),
});

const ContentBlockSchema = z.union([
    TextBlockSchema,
    ToolUseBlockSchema,
    ToolResultBlockSchema,
    ImageBlockSchema,
]);

const AnthropicMessageSchema = z.object({
    role: z.enum(['user', 'assistant']),
    content: z.union([z.string().max(500000), z.array(ContentBlockSchema)]),
});

const AnthropicToolSchema = z.object({
    name: z.string(),
    description: z.string().optional(),
    input_schema: z.record(z.unknown()),
});

const AnthropicToolChoiceSchema = z.union([
    z.object({ type: z.literal('auto') }),
    z.object({ type: z.literal('any') }),
    z.object({ type: z.literal('tool'), name: z.string() }),
    z.object({ type: z.literal('none') }),
]);

const AnthropicSystemSchema = z.union([
    z.string().max(500000),
    z.array(z.object({ type: z.literal('text'), text: z.string().max(500000) })),
]);

const AnthropicThinkingSchema = z.union([
    z.object({ type: z.literal('enabled'), budget_tokens: z.number().int().positive() }),
    z.object({ type: z.literal('disabled') }),
]);

export const AnthropicMessagesRequestSchema = z.object({
    model: z.string(),
    max_tokens: z.number().int().positive(),
    messages: z.array(AnthropicMessageSchema).min(1).max(500),
    system: AnthropicSystemSchema.optional(),
    tools: z.array(AnthropicToolSchema).optional(),
    tool_choice: AnthropicToolChoiceSchema.optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    top_k: z.number().int().positive().optional(),
    stop_sequences: z.array(z.string()).optional(),
    stream: z.boolean().default(false),
    thinking: AnthropicThinkingSchema.optional(),
    metadata: z.object({ user_id: z.string().optional() }).optional(),
});

export type AnthropicMessagesRequest = z.infer<typeof AnthropicMessagesRequestSchema>;
export type AnthropicContentBlock = z.infer<typeof ContentBlockSchema>;
export type AnthropicMessage = z.infer<typeof AnthropicMessageSchema>;

// Response/stream shapes are output-only — no inbound Zod validation needed.
export interface AnthropicMessagesResponse {
    id: string;
    type: 'message';
    role: 'assistant';
    content: AnthropicContentBlock[];
    model: string;
    stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
    stop_sequence: string | null;
    usage: {
        input_tokens: number;
        output_tokens: number;
    };
}

// ─── Anthropic stream events ───
export type AnthropicStreamEvent =
    | { type: 'message_start'; message: AnthropicMessagesResponse }
    | { type: 'content_block_start'; index: number; content_block: AnthropicContentBlock }
    | {
          type: 'content_block_delta';
          index: number;
          delta:
              | { type: 'text_delta'; text: string }
              | { type: 'input_json_delta'; partial_json: string };
      }
    | { type: 'content_block_stop'; index: number }
    | {
          type: 'message_delta';
          delta: {
              stop_reason: AnthropicMessagesResponse['stop_reason'];
              stop_sequence: string | null;
          };
          usage: { output_tokens: number };
      }
    | { type: 'message_stop' }
    | { type: 'ping' };
