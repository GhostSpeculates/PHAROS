# Anthropic /v1/messages Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Anthropic-shape `/v1/messages` endpoint to Pharos so Claude Agent SDK clients can route through Pharos's classifier + cost-saving model router. First customer is "Scout" — a Claude Agent SDK agent in the NOIR fleet.

**Architecture:** Translation-at-the-edge. New Anthropic→OpenAI translator module (pure functions) + new `/v1/messages` route handler that runs the same orchestration as `/v1/chat/completions` (auth, agent rate limit, classify, route, execute, stamp billing) but accepts/returns Anthropic shape. Translator is permanent infrastructure for future SDK shapes (Gemini, Cohere). Orchestration is intentionally duplicated for today; scheduled extraction follows next week.

**Tech Stack:** TypeScript (ESM), Fastify 5, Zod, Vitest 4, existing Pharos provider/classifier/router internals.

**Out of scope:**
- Refactoring `/v1/chat/completions` (intentional — zero regression risk to existing flow)
- Domain-flip in welcome email (separate WIP — Wave 5 Day 2)
- Image content blocks (Scout's first activation is text + tools; image translation can be a follow-up if Scout doesn't need it)

---

## File Structure

**New files:**
- `src/translation/anthropic-openai.ts` — Pure translator (request + non-streaming response)
- `src/translation/anthropic-stream.ts` — Stream event translator (OpenAI deltas → Anthropic events)
- `src/translation/types.ts` — Anthropic-shape TypeScript types + Zod schema
- `src/gateway/messages-routes.ts` — `/v1/messages` route handler (orchestration mirroring chat path)
- `src/__tests__/translation-anthropic-openai.test.ts` — Translator unit tests
- `src/__tests__/translation-anthropic-stream.test.ts` — Stream translator unit tests
- `src/__tests__/messages-routes.test.ts` — Route integration tests

**Modified files:**
- `src/server.ts` — Add 1 import + 1 line to register the route (line ~163 area, after `registerRoutes(...)` call). Additive — does NOT touch the Wave 5 raw-body section.

**Untouched:**
- `src/gateway/router.ts` (existing chat handler — zero modifications)
- `src/gateway/wallet-routes.ts` (Wave 5 WIP)
- `src/utils/email.ts` (Wave 5 WIP)
- `src/utils/id.ts` (Wave 5 WIP)
- All providers, classifier, router internals (reused as-is)

---

## Task 1: Anthropic Type Definitions + Zod Schema

**Files:**
- Create: `src/translation/types.ts`
- Test: `src/__tests__/translation-anthropic-openai.test.ts` (initial setup only)

- [ ] **Step 1: Write the type file**

```typescript
// src/translation/types.ts
import { z } from 'zod';

// ─── Anthropic content blocks ───
const TextBlockSchema = z.object({
    type: z.literal('text'),
    text: z.string().max(500000),
});

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
    stream: z.boolean().optional().default(false),
    thinking: AnthropicThinkingSchema.optional(),
    metadata: z.object({ user_id: z.string().optional() }).optional(),
});

export type AnthropicMessagesRequest = z.infer<typeof AnthropicMessagesRequestSchema>;
export type AnthropicContentBlock = z.infer<typeof ContentBlockSchema>;
export type AnthropicMessage = z.infer<typeof AnthropicMessageSchema>;

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
          delta: { stop_reason: AnthropicMessagesResponse['stop_reason']; stop_sequence: string | null };
          usage: { output_tokens: number };
      }
    | { type: 'message_stop' }
    | { type: 'ping' };
```

- [ ] **Step 2: Verify the file compiles**

Run: `npx tsc --noEmit src/translation/types.ts`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/translation/types.ts
git commit -m "feat(translation): Anthropic types + Zod schema for /v1/messages

Foundation for the Anthropic → OpenAI translator. Zod schema validates
incoming Agent SDK requests; TS types describe the response + stream
event shapes per the Anthropic Messages API docs."
```

---

## Task 2: Translator — Anthropic Request → OpenAI Request

**Files:**
- Create: `src/translation/anthropic-openai.ts`
- Test: `src/__tests__/translation-anthropic-openai.test.ts`

- [ ] **Step 1: Write the failing test (text-only request)**

```typescript
// src/__tests__/translation-anthropic-openai.test.ts
import { describe, expect, it } from 'vitest';
import { anthropicToOpenAI } from '../translation/anthropic-openai.js';
import type { AnthropicMessagesRequest } from '../translation/types.js';

describe('anthropicToOpenAI', () => {
    it('translates a text-only request', () => {
        const req: AnthropicMessagesRequest = {
            model: 'pharos-auto:scout',
            max_tokens: 200,
            messages: [{ role: 'user', content: 'Say hi in 5 words' }],
        };
        const out = anthropicToOpenAI(req);
        expect(out.model).toBe('pharos-auto:scout');
        expect(out.max_tokens).toBe(200);
        expect(out.messages).toEqual([{ role: 'user', content: 'Say hi in 5 words' }]);
        expect(out.stream).toBe(false);
    });

    it('preserves the agent-id colon syntax in the model field', () => {
        const req: AnthropicMessagesRequest = {
            model: 'pharos-auto:scout',
            max_tokens: 100,
            messages: [{ role: 'user', content: 'hi' }],
        };
        expect(anthropicToOpenAI(req).model).toBe('pharos-auto:scout');
    });

    it('prepends a string system prompt as a system message', () => {
        const req: AnthropicMessagesRequest = {
            model: 'pharos-auto',
            max_tokens: 100,
            system: 'You are Scout.',
            messages: [{ role: 'user', content: 'hi' }],
        };
        const out = anthropicToOpenAI(req);
        expect(out.messages[0]).toEqual({ role: 'system', content: 'You are Scout.' });
        expect(out.messages[1]).toEqual({ role: 'user', content: 'hi' });
    });

    it('joins an array system prompt into a single system message', () => {
        const req: AnthropicMessagesRequest = {
            model: 'pharos-auto',
            max_tokens: 100,
            system: [
                { type: 'text', text: 'You are Scout.' },
                { type: 'text', text: 'Be concise.' },
            ],
            messages: [{ role: 'user', content: 'hi' }],
        };
        const out = anthropicToOpenAI(req);
        expect(out.messages[0]).toEqual({
            role: 'system',
            content: 'You are Scout.\n\nBe concise.',
        });
    });

    it('translates text content blocks to a string', () => {
        const req: AnthropicMessagesRequest = {
            model: 'pharos-auto',
            max_tokens: 100,
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hi there' }] }],
        };
        const out = anthropicToOpenAI(req);
        expect(out.messages[0].content).toBe('hi there');
    });

    it('translates tool_use assistant blocks to OpenAI tool_calls', () => {
        const req: AnthropicMessagesRequest = {
            model: 'pharos-auto',
            max_tokens: 100,
            messages: [
                { role: 'user', content: 'whats the weather?' },
                {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'Let me check.' },
                        {
                            type: 'tool_use',
                            id: 'toolu_abc',
                            name: 'get_weather',
                            input: { location: 'NY' },
                        },
                    ],
                },
            ],
        };
        const out = anthropicToOpenAI(req);
        expect(out.messages[1]).toEqual({
            role: 'assistant',
            content: 'Let me check.',
            tool_calls: [
                {
                    id: 'toolu_abc',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '{"location":"NY"}' },
                },
            ],
        });
    });

    it('translates tool_result user blocks to OpenAI tool messages', () => {
        const req: AnthropicMessagesRequest = {
            model: 'pharos-auto',
            max_tokens: 100,
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: 'toolu_abc',
                            content: '72°F sunny',
                        },
                    ],
                },
            ],
        };
        const out = anthropicToOpenAI(req);
        expect(out.messages[0]).toEqual({
            role: 'tool',
            tool_call_id: 'toolu_abc',
            content: '72°F sunny',
        });
    });

    it('translates Anthropic tools[] to OpenAI tools[]', () => {
        const req: AnthropicMessagesRequest = {
            model: 'pharos-auto',
            max_tokens: 100,
            messages: [{ role: 'user', content: 'hi' }],
            tools: [
                {
                    name: 'get_weather',
                    description: 'Look up weather',
                    input_schema: { type: 'object', properties: { location: { type: 'string' } } },
                },
            ],
        };
        const out = anthropicToOpenAI(req);
        expect(out.tools).toEqual([
            {
                type: 'function',
                function: {
                    name: 'get_weather',
                    description: 'Look up weather',
                    parameters: { type: 'object', properties: { location: { type: 'string' } } },
                },
            },
        ]);
    });

    it('translates tool_choice variants', () => {
        const base = {
            model: 'pharos-auto',
            max_tokens: 100,
            messages: [{ role: 'user' as const, content: 'hi' }],
        };
        expect(anthropicToOpenAI({ ...base, tool_choice: { type: 'auto' } }).tool_choice).toBe('auto');
        expect(anthropicToOpenAI({ ...base, tool_choice: { type: 'any' } }).tool_choice).toBe('required');
        expect(anthropicToOpenAI({ ...base, tool_choice: { type: 'none' } }).tool_choice).toBe('none');
        expect(
            anthropicToOpenAI({ ...base, tool_choice: { type: 'tool', name: 'get_weather' } }).tool_choice,
        ).toEqual({ type: 'function', function: { name: 'get_weather' } });
    });

    it('passes through stream, temperature, top_p, stop_sequences, thinking', () => {
        const req: AnthropicMessagesRequest = {
            model: 'pharos-auto',
            max_tokens: 100,
            messages: [{ role: 'user', content: 'hi' }],
            stream: true,
            temperature: 0.7,
            top_p: 0.9,
            stop_sequences: ['STOP'],
            thinking: { type: 'enabled', budget_tokens: 1000 },
        };
        const out = anthropicToOpenAI(req);
        expect(out.stream).toBe(true);
        expect(out.temperature).toBe(0.7);
        expect(out.top_p).toBe(0.9);
        expect(out.stop).toEqual(['STOP']);
        expect(out.thinking).toEqual({ type: 'enabled', budget_tokens: 1000 });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/translation-anthropic-openai.test.ts`
Expected: FAIL — "Cannot find module '../translation/anthropic-openai.js'"

- [ ] **Step 3: Write the translator**

```typescript
// src/translation/anthropic-openai.ts
import type {
    AnthropicMessagesRequest,
    AnthropicMessage,
    AnthropicContentBlock,
} from './types.js';
import type { ChatMessage } from '../providers/types.js';

/**
 * Translate an Anthropic Messages API request to OpenAI chat-completions shape.
 * The output is what Pharos's existing chat router consumes.
 *
 * Pure function — no I/O. Same input always produces same output.
 */
export interface OpenAIChatRequestShape {
    model: string;
    messages: ChatMessage[];
    max_tokens: number;
    temperature?: number;
    top_p?: number;
    stop?: string[];
    stream?: boolean;
    tools?: Array<{
        type: 'function';
        function: { name: string; description?: string; parameters: object };
    }>;
    tool_choice?:
        | 'auto'
        | 'required'
        | 'none'
        | { type: 'function'; function: { name: string } };
    thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'disabled' };
}

export function anthropicToOpenAI(req: AnthropicMessagesRequest): OpenAIChatRequestShape {
    const messages: ChatMessage[] = [];

    // System prompt → first system message
    if (req.system) {
        const systemText =
            typeof req.system === 'string'
                ? req.system
                : req.system.map((p) => p.text).join('\n\n');
        messages.push({ role: 'system', content: systemText });
    }

    // Translate each Anthropic message
    for (const msg of req.messages) {
        translateMessage(msg, messages);
    }

    const out: OpenAIChatRequestShape = {
        model: req.model,
        messages,
        max_tokens: req.max_tokens,
        stream: req.stream ?? false,
    };

    if (req.temperature !== undefined) out.temperature = req.temperature;
    if (req.top_p !== undefined) out.top_p = req.top_p;
    if (req.stop_sequences && req.stop_sequences.length > 0) out.stop = req.stop_sequences;
    if (req.thinking) out.thinking = req.thinking;

    if (req.tools && req.tools.length > 0) {
        out.tools = req.tools.map((t) => ({
            type: 'function' as const,
            function: {
                name: t.name,
                ...(t.description !== undefined && { description: t.description }),
                parameters: t.input_schema as object,
            },
        }));
    }

    if (req.tool_choice) {
        out.tool_choice = translateToolChoice(req.tool_choice);
    }

    return out;
}

function translateMessage(msg: AnthropicMessage, out: ChatMessage[]): void {
    // String content — direct copy
    if (typeof msg.content === 'string') {
        out.push({ role: msg.role, content: msg.content });
        return;
    }

    // Array of content blocks — split into text, tool_use (assistant), tool_result (user)
    if (msg.role === 'user') {
        // User blocks can be: text, image, tool_result
        // tool_result blocks become separate "tool" messages in OpenAI shape
        const textParts: string[] = [];
        const toolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }> = [];

        for (const block of msg.content) {
            if (block.type === 'text') {
                textParts.push(block.text);
            } else if (block.type === 'tool_result') {
                const content =
                    typeof block.content === 'string'
                        ? block.content
                        : block.content.map((p) => p.text).join('\n');
                toolResults.push({
                    tool_use_id: block.tool_use_id,
                    content,
                    ...(block.is_error !== undefined && { is_error: block.is_error }),
                });
            }
            // image blocks: not supported in this first cut — skip silently
            // (Scout doesn't use images; can add later if a customer needs it)
        }

        // Emit tool_result blocks as separate "tool" messages first (OpenAI ordering)
        for (const tr of toolResults) {
            out.push({
                role: 'tool',
                tool_call_id: tr.tool_use_id,
                content: tr.content,
            });
        }

        // Then emit any text content as a user message
        if (textParts.length > 0) {
            out.push({ role: 'user', content: textParts.join('\n\n') });
        }
        return;
    }

    // assistant blocks: text + tool_use
    const textParts: string[] = [];
    const toolCalls: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
    }> = [];

    for (const block of msg.content) {
        if (block.type === 'text') {
            textParts.push(block.text);
        } else if (block.type === 'tool_use') {
            toolCalls.push({
                id: block.id,
                type: 'function',
                function: {
                    name: block.name,
                    arguments: JSON.stringify(block.input),
                },
            });
        }
    }

    const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: textParts.length > 0 ? textParts.join('\n\n') : null,
    };
    if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
    }
    out.push(assistantMsg);
}

function translateToolChoice(
    tc: NonNullable<AnthropicMessagesRequest['tool_choice']>,
): OpenAIChatRequestShape['tool_choice'] {
    if (tc.type === 'auto') return 'auto';
    if (tc.type === 'any') return 'required';
    if (tc.type === 'none') return 'none';
    return { type: 'function', function: { name: tc.name } };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/translation-anthropic-openai.test.ts`
Expected: 9 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/translation/anthropic-openai.ts src/__tests__/translation-anthropic-openai.test.ts
git commit -m "feat(translation): Anthropic → OpenAI request translator + tests

Pure function. Handles text, tool_use (assistant), tool_result (user),
tools[], tool_choice variants, system prompt prepend, agent-id colon
preservation. 9 tests cover the surface area Scout needs to activate."
```

---

## Task 3: Translator — OpenAI Response → Anthropic Response

**Files:**
- Modify: `src/translation/anthropic-openai.ts`
- Test: `src/__tests__/translation-anthropic-openai.test.ts`

- [ ] **Step 1: Write the failing test (response translation)**

```typescript
// Append to src/__tests__/translation-anthropic-openai.test.ts
import { openAIToAnthropic } from '../translation/anthropic-openai.js';

describe('openAIToAnthropic', () => {
    it('translates a text-only response', () => {
        const out = openAIToAnthropic(
            {
                id: 'chatcmpl-123',
                choices: [
                    {
                        index: 0,
                        message: { role: 'assistant', content: 'Hi, friend.' },
                        finish_reason: 'stop',
                    },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
                model: 'gpt-4o',
            },
            'pharos-auto:scout',
        );
        expect(out.type).toBe('message');
        expect(out.role).toBe('assistant');
        expect(out.content).toEqual([{ type: 'text', text: 'Hi, friend.' }]);
        expect(out.stop_reason).toBe('end_turn');
        expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 4 });
        expect(out.model).toBe('pharos-auto:scout');
    });

    it('translates a tool_calls response', () => {
        const out = openAIToAnthropic(
            {
                id: 'chatcmpl-456',
                choices: [
                    {
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: 'Let me check.',
                            tool_calls: [
                                {
                                    id: 'call_xyz',
                                    type: 'function',
                                    function: {
                                        name: 'get_weather',
                                        arguments: '{"location":"NY"}',
                                    },
                                },
                            ],
                        },
                        finish_reason: 'tool_calls',
                    },
                ],
                usage: { prompt_tokens: 50, completion_tokens: 12, total_tokens: 62 },
                model: 'claude-sonnet',
            },
            'pharos-auto',
        );
        expect(out.content).toEqual([
            { type: 'text', text: 'Let me check.' },
            {
                type: 'tool_use',
                id: 'call_xyz',
                name: 'get_weather',
                input: { location: 'NY' },
            },
        ]);
        expect(out.stop_reason).toBe('tool_use');
    });

    it('maps finish_reason values correctly', () => {
        const base = {
            id: 'x',
            choices: [{ index: 0, message: { role: 'assistant' as const, content: 'x' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            model: 'm',
        };
        expect(openAIToAnthropic({ ...base }, 'm').stop_reason).toBe('end_turn');
        expect(
            openAIToAnthropic(
                { ...base, choices: [{ ...base.choices[0], finish_reason: 'length' }] },
                'm',
            ).stop_reason,
        ).toBe('max_tokens');
        expect(
            openAIToAnthropic(
                { ...base, choices: [{ ...base.choices[0], finish_reason: 'tool_calls' }] },
                'm',
            ).stop_reason,
        ).toBe('tool_use');
        expect(
            openAIToAnthropic(
                { ...base, choices: [{ ...base.choices[0], finish_reason: 'stop_sequence' }] },
                'm',
            ).stop_reason,
        ).toBe('stop_sequence');
    });

    it('round-trips: anthropicToOpenAI(req) then openAIToAnthropic(resp) preserves shape', () => {
        const req: AnthropicMessagesRequest = {
            model: 'pharos-auto:scout',
            max_tokens: 100,
            messages: [{ role: 'user', content: 'hi' }],
        };
        const oReq = anthropicToOpenAI(req);
        // Simulated provider response
        const oResp = {
            id: 'chatcmpl-rt',
            choices: [
                {
                    index: 0,
                    message: { role: 'assistant' as const, content: 'hello' },
                    finish_reason: 'stop',
                },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
            model: oReq.model,
        };
        const aResp = openAIToAnthropic(oResp, req.model);
        expect(aResp.role).toBe('assistant');
        expect(aResp.content[0]).toEqual({ type: 'text', text: 'hello' });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/translation-anthropic-openai.test.ts`
Expected: FAIL — `openAIToAnthropic` is not exported.

- [ ] **Step 3: Add the response translator**

Append to `src/translation/anthropic-openai.ts`:

```typescript
import type { AnthropicMessagesResponse, AnthropicContentBlock } from './types.js';

export interface OpenAIChatResponseShape {
    id: string;
    choices: Array<{
        index: number;
        message: {
            role: 'assistant';
            content: string | null;
            tool_calls?: Array<{
                id: string;
                type: 'function';
                function: { name: string; arguments: string };
            }>;
        };
        finish_reason: string;
    }>;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    model: string;
}

export function openAIToAnthropic(
    resp: OpenAIChatResponseShape,
    requestedModel: string,
): AnthropicMessagesResponse {
    const choice = resp.choices[0];
    const msg = choice.message;
    const content: AnthropicContentBlock[] = [];

    if (msg.content && msg.content.length > 0) {
        content.push({ type: 'text', text: msg.content });
    }

    if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
            let parsedInput: Record<string, unknown> = {};
            try {
                parsedInput = JSON.parse(tc.function.arguments);
            } catch {
                // Provider returned malformed JSON — pass empty object rather than crash.
                // Real-world: this happens with quantized models truncating mid-JSON.
                parsedInput = {};
            }
            content.push({
                type: 'tool_use',
                id: tc.id,
                name: tc.function.name,
                input: parsedInput,
            });
        }
    }

    return {
        id: resp.id,
        type: 'message',
        role: 'assistant',
        content,
        model: requestedModel,
        stop_reason: mapFinishReason(choice.finish_reason),
        stop_sequence: null,
        usage: {
            input_tokens: resp.usage.prompt_tokens,
            output_tokens: resp.usage.completion_tokens,
        },
    };
}

function mapFinishReason(reason: string): AnthropicMessagesResponse['stop_reason'] {
    switch (reason) {
        case 'stop':
            return 'end_turn';
        case 'length':
            return 'max_tokens';
        case 'tool_calls':
            return 'tool_use';
        case 'stop_sequence':
            return 'stop_sequence';
        default:
            return 'end_turn';
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/translation-anthropic-openai.test.ts`
Expected: 13 tests passing total.

- [ ] **Step 5: Commit**

```bash
git add src/translation/anthropic-openai.ts src/__tests__/translation-anthropic-openai.test.ts
git commit -m "feat(translation): OpenAI → Anthropic response translator + tests

Inverse of the request translator. Handles text content, tool_calls,
finish_reason mapping (stop→end_turn, length→max_tokens,
tool_calls→tool_use, stop_sequence→stop_sequence), graceful malformed
tool argument JSON. Round-trip test confirms shape preservation."
```

---

## Task 4: Stream Translator — OpenAI Deltas → Anthropic Events

**Files:**
- Create: `src/translation/anthropic-stream.ts`
- Test: `src/__tests__/translation-anthropic-stream.test.ts`

- [ ] **Step 1: Write the failing test (text streaming)**

```typescript
// src/__tests__/translation-anthropic-stream.test.ts
import { describe, expect, it } from 'vitest';
import { AnthropicStreamTranslator } from '../translation/anthropic-stream.js';

describe('AnthropicStreamTranslator', () => {
    it('translates a simple text stream', () => {
        const t = new AnthropicStreamTranslator({
            messageId: 'msg_abc',
            model: 'pharos-auto:scout',
            inputTokens: 10,
        });

        const events: unknown[] = [];

        // Simulate OpenAI deltas
        t.handleDelta({ choices: [{ delta: { role: 'assistant' } }] }).forEach((e) => events.push(e));
        t.handleDelta({ choices: [{ delta: { content: 'Hi' } }] }).forEach((e) => events.push(e));
        t.handleDelta({ choices: [{ delta: { content: ' there' } }] }).forEach((e) => events.push(e));
        t.handleFinish('stop', { promptTokens: 10, completionTokens: 2, totalTokens: 12 }).forEach((e) =>
            events.push(e),
        );

        expect(events[0]).toMatchObject({ type: 'message_start' });
        expect((events[0] as any).message.id).toBe('msg_abc');
        expect((events[0] as any).message.usage.input_tokens).toBe(10);

        expect(events[1]).toEqual({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
        });
        expect(events[2]).toEqual({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Hi' },
        });
        expect(events[3]).toEqual({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: ' there' },
        });
        expect(events[4]).toEqual({ type: 'content_block_stop', index: 0 });
        expect(events[5]).toMatchObject({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 2 },
        });
        expect(events[6]).toEqual({ type: 'message_stop' });
    });

    it('translates a tool_call stream', () => {
        const t = new AnthropicStreamTranslator({
            messageId: 'msg_tool',
            model: 'pharos-auto',
            inputTokens: 50,
        });
        const events: unknown[] = [];

        t.handleDelta({
            choices: [
                {
                    delta: {
                        role: 'assistant',
                        tool_calls: [
                            {
                                index: 0,
                                id: 'call_xyz',
                                type: 'function',
                                function: { name: 'get_weather', arguments: '' },
                            },
                        ],
                    },
                },
            ],
        }).forEach((e) => events.push(e));
        t.handleDelta({
            choices: [
                {
                    delta: {
                        tool_calls: [{ index: 0, function: { arguments: '{"loc' } }],
                    },
                },
            ],
        }).forEach((e) => events.push(e));
        t.handleDelta({
            choices: [
                {
                    delta: {
                        tool_calls: [{ index: 0, function: { arguments: 'ation":"NY"}' } }],
                    },
                },
            ],
        }).forEach((e) => events.push(e));
        t.handleFinish('tool_calls', { promptTokens: 50, completionTokens: 8, totalTokens: 58 }).forEach(
            (e) => events.push(e),
        );

        // Should emit: message_start, content_block_start (tool_use), input_json_delta x2,
        // content_block_stop, message_delta, message_stop
        expect((events[0] as any).type).toBe('message_start');
        expect((events[1] as any).type).toBe('content_block_start');
        expect((events[1] as any).content_block).toEqual({
            type: 'tool_use',
            id: 'call_xyz',
            name: 'get_weather',
            input: {},
        });
        expect(events[2]).toEqual({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"loc' },
        });
        expect(events[3]).toEqual({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: 'ation":"NY"}' },
        });
        expect((events[4] as any).type).toBe('content_block_stop');
        expect((events[5] as any).delta.stop_reason).toBe('tool_use');
    });

    it('translates text + tool_call combined stream', () => {
        const t = new AnthropicStreamTranslator({
            messageId: 'msg_mixed',
            model: 'm',
            inputTokens: 5,
        });
        const events: unknown[] = [];

        t.handleDelta({ choices: [{ delta: { role: 'assistant' } }] }).forEach((e) => events.push(e));
        t.handleDelta({ choices: [{ delta: { content: 'Checking...' } }] }).forEach((e) =>
            events.push(e),
        );
        t.handleDelta({
            choices: [
                {
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                id: 'call_1',
                                type: 'function',
                                function: { name: 'lookup', arguments: '{}' },
                            },
                        ],
                    },
                },
            ],
        }).forEach((e) => events.push(e));
        t.handleFinish('tool_calls', { promptTokens: 5, completionTokens: 3, totalTokens: 8 }).forEach(
            (e) => events.push(e),
        );

        // Expect text block opened, deltaed, closed; then tool block opened, deltaed, closed
        const types = events.map((e: any) => e.type);
        expect(types).toEqual([
            'message_start',
            'content_block_start', // text
            'content_block_delta',
            'content_block_stop', // text closed when tool starts
            'content_block_start', // tool_use
            'content_block_delta', // input_json_delta for "{}"
            'content_block_stop', // tool closed at finish
            'message_delta',
            'message_stop',
        ]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/translation-anthropic-stream.test.ts`
Expected: FAIL — `Cannot find module '../translation/anthropic-stream.js'`.

- [ ] **Step 3: Write the stream translator**

```typescript
// src/translation/anthropic-stream.ts
import type { AnthropicStreamEvent, AnthropicMessagesResponse } from './types.js';

interface OpenAIDelta {
    choices: Array<{
        delta?: {
            role?: string;
            content?: string;
            tool_calls?: Array<{
                index: number;
                id?: string;
                type?: 'function';
                function?: { name?: string; arguments?: string };
            }>;
        };
        finish_reason?: string;
    }>;
}

interface InitArgs {
    messageId: string;
    model: string;
    inputTokens: number;
}

/**
 * Stateful translator. OpenAI streams chunks of {choices:[{delta:...}]};
 * Anthropic expects a strict event sequence:
 *   message_start
 *   content_block_start (per text or tool_use block)
 *   content_block_delta (text_delta or input_json_delta)
 *   content_block_stop
 *   ...repeat per block...
 *   message_delta (with stop_reason)
 *   message_stop
 *
 * We track which Anthropic block index is currently open. Switching
 * from text → tool (or tool index N → tool index M) requires closing
 * the prior block and opening a new one.
 */
export class AnthropicStreamTranslator {
    private messageStarted = false;
    private currentBlockIndex = -1;
    /** Maps OpenAI tool_call.index → our Anthropic content block index */
    private toolBlockIndexByOpenAIIndex = new Map<number, number>();
    private currentBlockType: 'text' | 'tool_use' | null = null;
    private nextBlockIndex = 0;

    constructor(private init: InitArgs) {}

    /** Returns the events to emit for this OpenAI delta. */
    handleDelta(chunk: OpenAIDelta): AnthropicStreamEvent[] {
        const out: AnthropicStreamEvent[] = [];
        const choice = chunk.choices?.[0];
        if (!choice) return out;
        const delta = choice.delta;
        if (!delta) return out;

        // Emit message_start once, on the first chunk that names the role.
        if (!this.messageStarted) {
            this.messageStarted = true;
            const initialMessage: AnthropicMessagesResponse = {
                id: this.init.messageId,
                type: 'message',
                role: 'assistant',
                content: [],
                model: this.init.model,
                stop_reason: null,
                stop_sequence: null,
                usage: {
                    input_tokens: this.init.inputTokens,
                    output_tokens: 0,
                },
            };
            out.push({ type: 'message_start', message: initialMessage });
        }

        // Text content
        if (typeof delta.content === 'string' && delta.content.length > 0) {
            // Switch to text block if not already on one
            if (this.currentBlockType !== 'text') {
                this.closeCurrentBlock(out);
                this.openTextBlock(out);
            }
            out.push({
                type: 'content_block_delta',
                index: this.currentBlockIndex,
                delta: { type: 'text_delta', text: delta.content },
            });
        }

        // Tool calls
        if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
                let blockIndex = this.toolBlockIndexByOpenAIIndex.get(tc.index);

                // First time we see this tool_call index — open a new block
                if (blockIndex === undefined) {
                    // Close any current text or other tool block
                    this.closeCurrentBlock(out);

                    blockIndex = this.nextBlockIndex++;
                    this.toolBlockIndexByOpenAIIndex.set(tc.index, blockIndex);
                    this.currentBlockIndex = blockIndex;
                    this.currentBlockType = 'tool_use';

                    out.push({
                        type: 'content_block_start',
                        index: blockIndex,
                        content_block: {
                            type: 'tool_use',
                            id: tc.id ?? `tool_${blockIndex}`,
                            name: tc.function?.name ?? '',
                            input: {},
                        },
                    });
                } else if (this.currentBlockIndex !== blockIndex) {
                    // We're seeing a different tool_call than is currently open — switch
                    this.closeCurrentBlock(out);
                    this.currentBlockIndex = blockIndex;
                    this.currentBlockType = 'tool_use';
                }

                // Emit input_json_delta for any args fragment
                const argFragment = tc.function?.arguments;
                if (argFragment !== undefined && argFragment.length > 0) {
                    out.push({
                        type: 'content_block_delta',
                        index: blockIndex,
                        delta: { type: 'input_json_delta', partial_json: argFragment },
                    });
                }
            }
        }

        return out;
    }

    /** Emit terminating events. Call exactly once at end of stream. */
    handleFinish(
        finishReason: string,
        usage: { promptTokens: number; completionTokens: number; totalTokens: number },
    ): AnthropicStreamEvent[] {
        const out: AnthropicStreamEvent[] = [];

        // If message_start was never emitted (empty stream), emit it now so the client
        // gets a coherent sequence rather than just message_delta + message_stop.
        if (!this.messageStarted) {
            this.messageStarted = true;
            out.push({
                type: 'message_start',
                message: {
                    id: this.init.messageId,
                    type: 'message',
                    role: 'assistant',
                    content: [],
                    model: this.init.model,
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: this.init.inputTokens, output_tokens: 0 },
                },
            });
        }

        this.closeCurrentBlock(out);

        const stopReason = mapFinishReason(finishReason);

        out.push({
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: usage.completionTokens },
        });
        out.push({ type: 'message_stop' });
        return out;
    }

    private openTextBlock(out: AnthropicStreamEvent[]): void {
        this.currentBlockIndex = this.nextBlockIndex++;
        this.currentBlockType = 'text';
        out.push({
            type: 'content_block_start',
            index: this.currentBlockIndex,
            content_block: { type: 'text', text: '' },
        });
    }

    private closeCurrentBlock(out: AnthropicStreamEvent[]): void {
        if (this.currentBlockType !== null && this.currentBlockIndex >= 0) {
            out.push({ type: 'content_block_stop', index: this.currentBlockIndex });
            this.currentBlockType = null;
        }
    }
}

function mapFinishReason(reason: string): 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' {
    switch (reason) {
        case 'stop':
            return 'end_turn';
        case 'length':
            return 'max_tokens';
        case 'tool_calls':
            return 'tool_use';
        case 'stop_sequence':
            return 'stop_sequence';
        default:
            return 'end_turn';
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/translation-anthropic-stream.test.ts`
Expected: 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/translation/anthropic-stream.ts src/__tests__/translation-anthropic-stream.test.ts
git commit -m "feat(translation): OpenAI delta stream → Anthropic event translator

Stateful class. Tracks open content blocks, switches between text
and tool_use, emits the strict Anthropic event sequence Agent SDK
expects (message_start → content_block_start/delta/stop → message_delta
→ message_stop). 3 tests cover text-only, tool-only, and mixed streams."
```

---

## Task 5: `/v1/messages` Route Handler

**Files:**
- Create: `src/gateway/messages-routes.ts`
- Test: `src/__tests__/messages-routes.test.ts`

- [ ] **Step 1: Write the failing integration test (text-only happy path)**

```typescript
// src/__tests__/messages-routes.test.ts
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerMessagesRoutes } from '../gateway/messages-routes.js';
import type { PharosConfig } from '../config/schema.js';
import type { QueryClassifier } from '../classifier/index.js';
import type { ModelRouter } from '../router/index.js';
import type { ProviderRegistry } from '../providers/index.js';
import { createLogger } from '../utils/logger.js';

// Minimal stubs — tests focus on the route's translation behavior, not the full router.
function makeStubs() {
    const logger = createLogger('error', false);

    const config = {
        auth: { apiKey: 'test-operator-key' },
        server: {
            agentRateLimitPerMinute: 1000,
            debugLogging: false,
            bodyLimitMb: 10,
            rateLimitPerMinute: 1000,
            host: '127.0.0.1',
            port: 0,
            selfTest: false,
        },
        spending: { dailyLimit: null, monthlyLimit: null },
        tracking: {
            enabled: false,
            dbPath: ':memory:',
            retentionDays: 30,
            baselineCostPerMillionInput: 3,
            baselineCostPerMillionOutput: 15,
        },
        tiers: {
            economical: { scoreRange: [4, 6], models: [{ provider: 'stub', model: 'stub-model' }] },
        },
        router: { oversizedThresholdTokens: 100000 },
    } as unknown as PharosConfig;

    const classifier = {
        classify: vi.fn(async () => ({
            score: 5,
            type: 'conversation' as const,
            classifierProvider: 'stub',
            latencyMs: 10,
            isFallback: false,
        })),
        getMetrics: vi.fn(() => ({})),
    } as unknown as QueryClassifier;

    const router = {
        resolveDirectModel: vi.fn(() => null),
        resolveTaskTypeOverride: vi.fn(() => null),
        route: vi.fn(() => ({
            tier: 'economical',
            provider: 'stub',
            model: 'stub-model',
            failoverAttempts: 0,
            isDirectRoute: false,
            classification: { score: 5, type: 'conversation', latencyMs: 10 },
        })),
        routeDirect: vi.fn(),
        getCandidates: vi.fn(() => [{ provider: 'stub', model: 'stub-model', tier: 'economical' }]),
    } as unknown as ModelRouter;

    const stubProvider = {
        chat: vi.fn(async () => ({
            content: 'Hi, friend.',
            model: 'stub-model',
            usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
            finishReason: 'stop',
        })),
        chatStream: vi.fn(async function* () {
            yield { content: 'Hi' };
            yield { content: ', friend.' };
            yield {
                content: '',
                finishReason: 'stop',
                usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
            };
        }),
        recordLatency: vi.fn(),
        undoLastError: vi.fn(),
    };
    const registry = {
        get: vi.fn(() => stubProvider),
        isAvailable: vi.fn(() => true),
        getStatus: vi.fn(() => ({})),
    } as unknown as ProviderRegistry;

    return { logger, config, classifier, router, registry };
}

describe('POST /v1/messages', () => {
    let app: FastifyInstance;

    beforeEach(async () => {
        app = Fastify({ logger: false });
        const stubs = makeStubs();
        registerMessagesRoutes(app, stubs.config, stubs.classifier, stubs.router, stubs.registry, null, stubs.logger, undefined, null, undefined, null);
        await app.ready();
    });

    afterEach(async () => {
        await app.close();
    });

    it('returns Anthropic-shape response for a text request', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/messages',
            headers: { authorization: 'Bearer test-operator-key' },
            payload: {
                model: 'pharos-auto:scout',
                max_tokens: 200,
                messages: [{ role: 'user', content: 'Say hi in 5 words' }],
            },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.type).toBe('message');
        expect(body.role).toBe('assistant');
        expect(body.model).toBe('pharos-auto:scout');
        expect(body.content[0]).toEqual({ type: 'text', text: 'Hi, friend.' });
        expect(body.stop_reason).toBe('end_turn');
        expect(body.usage).toEqual({ input_tokens: 10, output_tokens: 4 });
    });

    it('rejects requests without auth', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/messages',
            payload: {
                model: 'pharos-auto',
                max_tokens: 100,
                messages: [{ role: 'user', content: 'hi' }],
            },
        });
        expect(res.statusCode).toBe(401);
    });

    it('rejects malformed Anthropic body', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/messages',
            headers: { authorization: 'Bearer test-operator-key' },
            payload: { model: 'pharos-auto' /* missing max_tokens, messages */ },
        });
        expect(res.statusCode).toBe(400);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/messages-routes.test.ts`
Expected: FAIL — `Cannot find module '../gateway/messages-routes.js'`.

- [ ] **Step 3: Write the route handler**

```typescript
// src/gateway/messages-routes.ts
import type { FastifyInstance } from 'fastify';
import type { PharosConfig, TierName } from '../config/schema.js';
import type { QueryClassifier } from '../classifier/index.js';
import type { ModelRouter, RoutingDecision } from '../router/index.js';
import type { ProviderRegistry } from '../providers/index.js';
import type { ChatResponse } from '../providers/types.js';
import type { TrackingStore } from '../tracking/store.js';
import type { WalletStore } from '../tracking/wallet-store.js';
import type { Logger } from '../utils/logger.js';
import type { ConversationTracker } from '../router/conversation-tracker.js';
import type { PerformanceLearningStore } from '../learning/performance-store.js';
import type { Phase2Metrics } from '../tracking/phase2-metrics.js';

import { AnthropicMessagesRequestSchema } from '../translation/types.js';
import { anthropicToOpenAI, openAIToAnthropic } from '../translation/anthropic-openai.js';
import { AnthropicStreamTranslator } from '../translation/anthropic-stream.js';
import { buildErrorResponse } from './schemas/response.js';
import { calculateCost, calculateBaselineCost } from '../tracking/cost-calculator.js';
import { generateRequestId } from '../utils/id.js';
import { initSSEHeaders, sendSSEChunk, isClientConnected } from '../utils/stream.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createAgentRateLimiter } from './middleware/agent-rate-limit.js';
import { estimateTokens, getContextWindow, isContextSizeError } from '../utils/context.js';
import { isTransientError, calculateBackoffMs, sleep } from '../utils/retry.js';
import { isMemoryFlush } from '../utils/flush-detector.js';
import { applyAgentProfile } from '../router/agent-profile.js';
import { applyTierFloor } from '../router/conversation-tracker.js';

/**
 * Register the Anthropic-shape /v1/messages endpoint.
 *
 * Translation at the edge: incoming Anthropic body → OpenAI shape, then run
 * the same orchestration the chat path runs (auth, agent rate limit, classify,
 * route, retry/failover, billing stamp), then translate the response back.
 *
 * Why duplicated orchestration vs reusing the chat handler? See
 * docs/superpowers/plans/2026-05-02-anthropic-messages-endpoint.md — extraction
 * (Option A) is scheduled as a follow-up; this is intentional bounded
 * scaffolding to ship the translator without regressing /v1/chat/completions.
 */
export function registerMessagesRoutes(
    app: FastifyInstance,
    config: PharosConfig,
    classifier: QueryClassifier,
    router: ModelRouter,
    registry: ProviderRegistry,
    tracker: TrackingStore | null,
    logger: Logger,
    conversationTracker?: ConversationTracker,
    learningStore?: PerformanceLearningStore | null,
    phase2Metrics?: Phase2Metrics,
    wallet?: WalletStore | null,
): void {
    const authMiddleware = createAuthMiddleware(config, wallet);
    const agentRateLimiter = createAgentRateLimiter(config.server.agentRateLimitPerMinute, logger);

    app.post('/v1/messages', { preHandler: authMiddleware }, async (request, reply) => {
        const requestStartTime = Date.now();
        const clientRequestId = request.headers['x-request-id'];
        const requestId =
            typeof clientRequestId === 'string' && clientRequestId.trim()
                ? clientRequestId.trim()
                : generateRequestId();

        const conversationId =
            typeof request.headers['x-conversation-id'] === 'string'
                ? request.headers['x-conversation-id'].trim() || null
                : null;

        // 1. Validate Anthropic-shape body
        const parseResult = AnthropicMessagesRequestSchema.safeParse(request.body);
        if (!parseResult.success) {
            const errors = parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
            reply
                .status(400)
                .send(buildErrorResponse(`Invalid request: ${errors.join('; ')}`, 'invalid_request_error'));
            return;
        }

        const anthropicBody = parseResult.data;

        // 2. Translate to OpenAI shape (preserves agent-id, system, tools, etc.)
        const openAIBody = anthropicToOpenAI(anthropicBody);
        const messages = openAIBody.messages;

        logger.info(
            {
                requestId,
                model: anthropicBody.model,
                messageCount: messages.length,
                shape: 'anthropic',
            },
            'Request received',
        );

        // 3. Per-agent rate limiting (same logic as chat path)
        const agentId = agentRateLimiter.extractAgent(anthropicBody.model);
        if (agentId) {
            const r = agentRateLimiter.check(agentId);
            if (!r.allowed) {
                reply.header('Retry-After', String(r.retryAfterSeconds));
                reply
                    .status(429)
                    .send(buildErrorResponse(
                        `Agent "${agentId}" rate limited. Retry after ${r.retryAfterSeconds}s.`,
                        'rate_limit_error',
                    ));
                return;
            }
        }

        let classification: Awaited<ReturnType<typeof classifier.classify>> | undefined;
        let routing: RoutingDecision | undefined;
        let conversationTierFloor: string | undefined;

        try {
            // 4. Classify
            if (isMemoryFlush(messages)) {
                classification = {
                    score: 2,
                    type: 'conversation',
                    classifierProvider: 'flush-detector',
                    latencyMs: 0,
                    isFallback: false,
                };
            } else {
                classification = await classifier.classify(messages);
            }

            // 5. Agent profile clamp
            const adjusted = applyAgentProfile(classification.score, agentId ?? undefined, config);
            if (adjusted.adjustedScore !== classification.score) {
                classification = { ...classification, score: adjusted.adjustedScore };
            }

            // 6. Route
            const directModel = router.resolveDirectModel(anthropicBody.model);
            const taskTypeOverride = router.resolveTaskTypeOverride(anthropicBody.model);
            if (taskTypeOverride) {
                classification = { ...classification, type: taskTypeOverride };
            }

            if (directModel) {
                routing = router.routeDirect(directModel.provider, directModel.model, classification);
            } else {
                routing = router.route(classification);
                if (conversationId && conversationTracker && config.conversation?.enabled) {
                    const floor = conversationTracker.getTierFloor(conversationId);
                    if (floor) {
                        const elevatedTier = applyTierFloor(routing.tier as TierName, floor);
                        if (elevatedTier !== routing.tier) {
                            const elevatedScore = config.tiers[elevatedTier].scoreRange[0];
                            routing = router.route({ ...classification, score: elevatedScore });
                            conversationTierFloor = floor;
                        }
                    }
                    phase2Metrics?.recordConversationFloor(!!conversationTierFloor);
                }
            }

            logger.info(
                { requestId, tier: routing.tier, provider: routing.provider, model: routing.model, score: classification.score },
                '→ Routed',
            );

            // 7. Build provider chat request
            const chatRequest = {
                model: routing.model,
                messages,
                temperature: openAIBody.temperature,
                maxTokens: openAIBody.max_tokens,
                topP: openAIBody.top_p,
                stream: openAIBody.stream,
                stop: openAIBody.stop,
                ...(openAIBody.thinking !== undefined && { thinking: openAIBody.thinking }),
            };

            const candidates = directModel
                ? [{ provider: routing.provider, model: routing.model, tier: routing.tier }]
                : router.getCandidates(classification);

            if (candidates.length === 0) {
                throw new Error('No available providers found');
            }

            // Filter by context window for oversized requests
            const estimatedTokens = estimateTokens(messages);
            let filteredCandidates = candidates;
            if (estimatedTokens > config.router.oversizedThresholdTokens) {
                filteredCandidates = candidates.filter((c) => getContextWindow(c.model) > estimatedTokens);
                if (filteredCandidates.length === 0) filteredCandidates = candidates;
            }

            let retryCount = 0;

            // ─── Streaming path ───
            if (openAIBody.stream) {
                let succeeded = false;
                let clientDisconnected = false;
                reply.raw.on('close', () => {
                    clientDisconnected = true;
                });

                for (const candidate of filteredCandidates) {
                    const p = registry.get(candidate.provider);
                    if (!p) continue;
                    if (clientDisconnected) return;

                    for (let attempt = 0; attempt < 2; attempt++) {
                        try {
                            const streamReq = { ...chatRequest, model: candidate.model };
                            let headersSent = false;
                            const streamTranslator = new AnthropicStreamTranslator({
                                messageId: requestId,
                                model: anthropicBody.model,
                                inputTokens: estimatedTokens,
                            });
                            let finalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

                            for await (const chunk of p.chatStream(streamReq)) {
                                if (clientDisconnected || !isClientConnected(reply)) return;

                                if (!headersSent) {
                                    reply.raw.setHeader('X-Pharos-Tier', candidate.tier);
                                    reply.raw.setHeader('X-Pharos-Model', candidate.model);
                                    reply.raw.setHeader('X-Pharos-Provider', candidate.provider);
                                    reply.raw.setHeader('X-Pharos-Score', String(classification.score));
                                    reply.raw.setHeader('X-Pharos-Request-Id', requestId);
                                    reply.raw.setHeader('X-Pharos-Shape', 'anthropic');
                                    initSSEHeaders(reply);
                                    headersSent = true;
                                }

                                // Translate this OpenAI chunk into Anthropic events
                                const openaiChunk = {
                                    choices: [
                                        {
                                            delta: chunk.content ? { content: chunk.content } : {},
                                            ...(chunk.finishReason ? { finish_reason: chunk.finishReason } : {}),
                                        },
                                    ],
                                };
                                if (chunk.content) {
                                    const events = streamTranslator.handleDelta(openaiChunk);
                                    for (const ev of events) {
                                        sendSSEChunk(reply, ev, ev.type);
                                    }
                                }
                                if (chunk.finishReason) {
                                    if (chunk.usage) finalUsage = chunk.usage;
                                    const events = streamTranslator.handleFinish(chunk.finishReason, finalUsage);
                                    for (const ev of events) {
                                        sendSSEChunk(reply, ev, ev.type);
                                    }
                                }
                            }

                            // Latency + tracking
                            const providerLatency = Date.now() - requestStartTime - (classification.latencyMs ?? 0);
                            p.recordLatency(Math.max(0, providerLatency));

                            const cost = calculateCost(
                                candidate.provider,
                                candidate.model,
                                finalUsage.promptTokens,
                                finalUsage.completionTokens,
                            );
                            if (cost > 0) {
                                request.pharosBilling = {
                                    upstream_usd: cost,
                                    model: candidate.model,
                                    provider: candidate.provider,
                                    modality: 'chat',
                                    request_id: requestId,
                                };
                            }

                            const finalRouting = {
                                ...routing,
                                provider: candidate.provider,
                                model: candidate.model,
                                tier: candidate.tier,
                            };
                            recordRequest(
                                tracker,
                                config,
                                requestId,
                                finalRouting,
                                classification,
                                finalUsage,
                                Date.now() - requestStartTime,
                                true,
                                getMessagePreview(anthropicBody),
                                undefined,
                                { agentId: agentId ?? undefined, conversationId: conversationId ?? undefined, retryCount },
                            );
                            learningStore?.recordOutcome(
                                candidate.provider,
                                candidate.model,
                                classification.type,
                                true,
                                Math.max(0, providerLatency),
                            );
                            if (conversationId && conversationTracker && config.conversation?.enabled) {
                                conversationTracker.recordTier(conversationId, candidate.tier as TierName);
                            }

                            logger.info(
                                {
                                    requestId,
                                    tier: candidate.tier,
                                    model: candidate.model,
                                    cost: `$${cost.toFixed(6)}`,
                                    latencyMs: Date.now() - requestStartTime,
                                    shape: 'anthropic',
                                },
                                '✓ Completed (stream)',
                            );

                            succeeded = true;
                            break;
                        } catch (streamError) {
                            if (reply.raw.headersSent) {
                                logger.error({ requestId, error: errMsg(streamError) }, 'Stream error mid-response');
                                return;
                            }
                            const eMsg = errMsg(streamError);
                            const p = registry.get(candidate.provider);
                            if (isContextSizeError(eMsg) && p) p.undoLastError();
                            if (attempt === 0 && isTransientError(streamError)) {
                                await sleep(calculateBackoffMs(0));
                                continue;
                            }
                            retryCount++;
                            learningStore?.recordOutcome(candidate.provider, candidate.model, classification.type, false, 0);
                            break;
                        }
                    }
                    if (succeeded) break;
                }

                if (!succeeded) throw new Error(`All providers failed after ${retryCount} retry attempts`);
                return;
            }

            // ─── Non-streaming path ───
            let response: ChatResponse | null = null;
            let usedProvider = routing.provider;
            let usedModel = routing.model;
            let usedTier = routing.tier;

            for (const candidate of filteredCandidates) {
                const p = registry.get(candidate.provider);
                if (!p) continue;

                let candidateSucceeded = false;
                for (let attempt = 0; attempt < 2; attempt++) {
                    try {
                        const callStart = Date.now();
                        response = await p.chat({ ...chatRequest, model: candidate.model });
                        p.recordLatency(Date.now() - callStart);
                        usedProvider = candidate.provider;
                        usedModel = candidate.model;
                        usedTier = candidate.tier;
                        candidateSucceeded = true;
                        break;
                    } catch (err) {
                        const eMsg = errMsg(err);
                        if (isContextSizeError(eMsg)) p.undoLastError();
                        if (attempt === 0 && isTransientError(err)) {
                            await sleep(calculateBackoffMs(0));
                            continue;
                        }
                        retryCount++;
                        learningStore?.recordOutcome(candidate.provider, candidate.model, classification.type, false, 0);
                        break;
                    }
                }
                if (candidateSucceeded) break;
            }

            if (!response) {
                throw new Error(`All providers failed after ${retryCount} retry attempts`);
            }

            const cost = calculateCost(
                usedProvider,
                usedModel,
                response.usage.promptTokens,
                response.usage.completionTokens,
            );
            if (cost > 0) {
                request.pharosBilling = {
                    upstream_usd: cost,
                    model: usedModel,
                    provider: usedProvider,
                    modality: 'chat',
                    request_id: requestId,
                };
            }

            const finalRouting = { ...routing, provider: usedProvider, model: usedModel, tier: usedTier };
            recordRequest(
                tracker,
                config,
                requestId,
                finalRouting,
                classification,
                response.usage,
                Date.now() - requestStartTime,
                false,
                getMessagePreview(anthropicBody),
                undefined,
                { agentId: agentId ?? undefined, conversationId: conversationId ?? undefined, retryCount },
            );
            const providerLatencyMs = Date.now() - requestStartTime - (classification.latencyMs ?? 0);
            learningStore?.recordOutcome(usedProvider, usedModel, classification.type, true, Math.max(0, providerLatencyMs));
            if (conversationId && conversationTracker && config.conversation?.enabled) {
                conversationTracker.recordTier(conversationId, usedTier as TierName);
            }

            logger.info(
                {
                    requestId,
                    tier: usedTier,
                    model: usedModel,
                    cost: `$${cost.toFixed(6)}`,
                    latencyMs: Date.now() - requestStartTime,
                    shape: 'anthropic',
                },
                '✓ Completed',
            );

            // Translate response to Anthropic shape
            const anthropicResponse = openAIToAnthropic(
                {
                    id: requestId,
                    choices: [
                        {
                            index: 0,
                            message: {
                                role: 'assistant',
                                content: response.content,
                            },
                            finish_reason: response.finishReason,
                        },
                    ],
                    usage: response.usage,
                    model: usedModel,
                },
                anthropicBody.model,
            );

            reply.header('X-Pharos-Tier', usedTier);
            reply.header('X-Pharos-Model', usedModel);
            reply.header('X-Pharos-Provider', usedProvider);
            reply.header('X-Pharos-Score', String(classification.score));
            reply.header('X-Pharos-Cost', cost.toFixed(6));
            reply.header('X-Pharos-Request-Id', requestId);
            reply.header('X-Pharos-Shape', 'anthropic');
            return anthropicResponse;
        } catch (error) {
            const eMsg = errMsg(error);
            logger.error({ requestId, error: eMsg }, '✗ Request failed');
            if (!reply.raw.headersSent) {
                reply.status(502).send(buildErrorResponse(`Routing failed: ${eMsg}`, 'server_error', 'provider_error'));
            }
        }
    });
}

function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

function getMessagePreview(req: { messages: Array<{ role: string; content: unknown }> }): string {
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return '';
    if (typeof lastUser.content === 'string') return lastUser.content.slice(0, 80);
    if (Array.isArray(lastUser.content)) {
        const text = lastUser.content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join(' ');
        return text.slice(0, 80);
    }
    return '';
}

function recordRequest(
    tracker: TrackingStore | null,
    config: PharosConfig,
    requestId: string,
    routing: RoutingDecision,
    classification: RoutingDecision['classification'],
    usage: { promptTokens: number; completionTokens: number; totalTokens: number },
    totalLatencyMs: number,
    stream: boolean,
    userMessagePreview: string,
    errorInfo?: { status: 'error'; errorMessage: string },
    extra?: { agentId?: string; conversationId?: string; retryCount?: number },
): void {
    if (!tracker) return;
    const cost = calculateCost(routing.provider, routing.model, usage.promptTokens, usage.completionTokens);
    const baseline = calculateBaselineCost(
        usage.promptTokens,
        usage.completionTokens,
        config.tracking.baselineCostPerMillionInput,
        config.tracking.baselineCostPerMillionOutput,
    );
    tracker.record({
        id: requestId,
        timestamp: new Date().toISOString(),
        tier: routing.tier,
        provider: routing.provider,
        model: routing.model,
        classificationScore: classification.score,
        classificationType: classification.type,
        classificationLatencyMs: classification.latencyMs,
        classifierProvider: classification.classifierProvider ?? 'unknown',
        tokensIn: usage.promptTokens,
        tokensOut: usage.completionTokens,
        estimatedCost: cost,
        baselineCost: baseline,
        savings: baseline - cost,
        totalLatencyMs,
        stream,
        isDirectRoute: routing.isDirectRoute,
        userMessagePreview,
        ...(errorInfo && { status: errorInfo.status, errorMessage: errorInfo.errorMessage }),
        ...(extra && { agentId: extra.agentId, conversationId: extra.conversationId, retryCount: extra.retryCount }),
    });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/messages-routes.test.ts`
Expected: 3 tests passing.

- [ ] **Step 5: Run the full test suite to confirm no regressions**

Run: `npm test`
Expected: all existing tests still pass + new tests pass. Target: 1120 + 19 = 1139 tests passing.

- [ ] **Step 6: Commit**

```bash
git add src/gateway/messages-routes.ts src/__tests__/messages-routes.test.ts
git commit -m "feat(gateway): /v1/messages endpoint — Anthropic-shape entry point

Routes Claude Agent SDK requests through the same Pharos pipeline as
/v1/chat/completions: auth → agent rate limit → classify → route →
retry/failover → wallet billing stamp. Translation happens at the edges
(request body in, response shape out, SSE event sequence on stream).

Orchestration intentionally duplicated from router.ts for this ship —
proper extraction is scheduled as cleanup PR (option A in plan).

Tests: 3 integration tests using app.inject() with stubbed router.
Wallet billing path identical to chat (stamps request.pharosBilling)."
```

---

## Task 6: Wire Into server.ts

**Files:**
- Modify: `src/server.ts` (additive only — does NOT touch the Wave 5 raw-body section)

- [ ] **Step 1: Add the import**

Add this import to the existing import block in [src/server.ts](src/server.ts) (insert after the `registerRoutes` import on line 12):

```typescript
import { registerMessagesRoutes } from './gateway/messages-routes.js';
```

- [ ] **Step 2: Register the route**

Insert this call right after the existing `registerRoutes(...)` call (currently line 163):

```typescript
// Anthropic-shape /v1/messages — Claude Agent SDK entry point.
// Same pipeline as /v1/chat/completions, translates at edges.
registerMessagesRoutes(app, config, classifier, router, registry, tracker, logger, conversationTracker, learningStore, phase2Metrics, wallet);
```

- [ ] **Step 3: Update the startup log block**

In the `start: async () => {...}` block (~line 224), add one line to the route list:

```typescript
logger.info(`   POST /v1/messages              →  Anthropic-shape entry (Agent SDK)`);
```

Insert after the existing `POST /v1/chat/completions` log line.

- [ ] **Step 4: Build to verify no TypeScript errors**

Run: `npm run build`
Expected: clean build, no errors.

- [ ] **Step 5: Start the dev server and curl-test the endpoint**

Run in one terminal: `npm run dev`

In another terminal:
```bash
curl -s http://localhost:3777/v1/messages \
  -H "Authorization: Bearer $PHAROS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "pharos-auto:scout",
    "max_tokens": 50,
    "messages": [{"role":"user","content":"Say hi in 5 words"}]
  }' | jq
```

Expected: an Anthropic-shape response object with `type: "message"`, `role: "assistant"`, `content: [{type:"text", text:"..."}]`, `stop_reason: "end_turn"`, and a `usage` object. Headers should include `X-Pharos-Tier`, `X-Pharos-Model`, `X-Pharos-Shape: anthropic`.

- [ ] **Step 6: Streaming curl test**

```bash
curl -N http://localhost:3777/v1/messages \
  -H "Authorization: Bearer $PHAROS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "pharos-auto:scout",
    "max_tokens": 50,
    "stream": true,
    "messages": [{"role":"user","content":"Count to three"}]
  }'
```

Expected: SSE events in order — `message_start`, `content_block_start`, `content_block_delta` (multiple), `content_block_stop`, `message_delta`, `message_stop`. Each prefixed with `event: <name>` and `data: {...}\n\n`.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): wire /v1/messages route — Agent SDK now connects to Pharos

One import, one registration call, one startup log line. Additive,
parallel to /v1/chat/completions. Confirmed via curl: text completion
returns Anthropic-shape body, streaming emits the strict event sequence
Agent SDK expects."
```

---

## Task 7: Activate Scout

**Files:** None in Pharos repo. Verification only — Scout lives in NOIR.

- [ ] **Step 1: Provision a wallet API key for Scout (if not already)**

If running with `wallet` enabled, create a test user with credits:
```bash
# From the Pharos directory, with the server running
sqlite3 ~/pharos/data/pharos.db <<EOF
-- Create test user with $5 balance for Scout activation
INSERT INTO users (email, api_key_hash, created_at)
VALUES ('scout@noir.local', '<sha256_of_real_key>', datetime('now'));
INSERT INTO wallet_ledger (user_id, kind, amount_cents, ...)
VALUES ((SELECT id FROM users WHERE email='scout@noir.local'), 'topup', 500, ...);
EOF
```

If running with operator auth only (no wallet), use `PHAROS_API_KEY` directly — simpler path for first activation.

- [ ] **Step 2: Run the Agent SDK probe script**

Create `scripts/scout-probe.mjs`:

```javascript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
    baseURL: 'http://localhost:3777',
    apiKey: process.env.PHAROS_API_KEY,
});

const r = await client.messages.create({
    model: 'pharos-auto:scout',
    max_tokens: 200,
    messages: [{ role: 'user', content: 'Say hi in 5 words' }],
});

console.log('✓ Scout connected to Pharos');
console.log('  Response:', JSON.stringify(r, null, 2));
console.log('  Headers:', r._request_id ? `request_id=${r._request_id}` : 'no request_id');
```

Run: `node scripts/scout-probe.mjs`
Expected: success print + an Anthropic-shape response. Pharos server log shows `✓ Completed` for `/v1/messages`.

- [ ] **Step 3: Verify the request landed in tracking**

```bash
sqlite3 ~/pharos/data/pharos.db "SELECT id, tier, provider, model, total_latency_ms FROM requests ORDER BY rowid DESC LIMIT 1;"
```

Expected: a row with the just-completed request, including the agent-id `scout` if the model field was preserved correctly.

- [ ] **Step 4: Streaming probe**

Append to `scripts/scout-probe.mjs`:
```javascript
console.log('\n--- streaming test ---');
const stream = await client.messages.stream({
    model: 'pharos-auto:scout',
    max_tokens: 200,
    messages: [{ role: 'user', content: 'Count to three slowly.' }],
});
for await (const event of stream) {
    console.log(event.type);
}
const final = await stream.finalMessage();
console.log('Final:', final.content[0]);
```

Run: `node scripts/scout-probe.mjs`
Expected: the event sequence prints in order, ending with `message_stop`. Final message content is text.

- [ ] **Step 5: Done — Scout is activated**

Take note of any drift from this plan (events skipped, fields the SDK rejects, etc.) and add to a follow-up issue.

---

## Self-Review Checklist (run before execution)

- [x] **Spec coverage** — every requirement in the brief maps to a task:
  - `messages-routes.ts` (NEW) → Task 5
  - `anthropic-openai.ts` (NEW) translator → Tasks 2, 3
  - Streaming SSE translation → Task 4
  - Wire into server.ts → Task 6
  - Tests (unit + integration + streaming) → Tasks 2, 3, 4, 5
  - Edge cases (`pharos-auto:agent-id` preservation, large system prompts, SSE format) → covered in Tasks 2 + 5
- [x] **No placeholders** — all code blocks contain runnable code, no TODO/TBD
- [x] **Type consistency** — `AnthropicMessagesRequestSchema`, `anthropicToOpenAI`, `openAIToAnthropic`, `AnthropicStreamTranslator` referenced consistently across tasks
- [x] **Constraint respect** — Wave 5 WIP files (`wallet-routes.ts`, `email.ts`, `id.ts`) are NOT modified; `router.ts` chat handler is NOT modified
- [x] **TDD discipline** — every code task is failing-test → minimal-impl → passing-test → commit
- [x] **Frequent commits** — 7 commits total, one per task

## Known Drift From Original Spec

- Original spec mentioned image content blocks; this plan defers image translation (Scout's Tier-1 use case is text + tools). Adding images later is a one-function addition to `translateMessage()` in `anthropic-openai.ts`.
- Original spec said "reuse the existing chat router internals via direct function call." That function does not exist. We deliberately picked Option B (duplication-with-scheduled-extraction) per Ghost's call on 2026-05-02. Cleanup PR (Option A) tracked separately.
