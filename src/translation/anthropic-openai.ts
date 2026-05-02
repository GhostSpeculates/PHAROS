import type {
    AnthropicMessagesRequest,
    AnthropicMessage,
    OpenAIChatRequestShape,
} from './types.js';
import type { ChatMessage } from '../providers/types.js';

/**
 * Translate an Anthropic Messages API request to OpenAI chat-completions shape.
 * The output is what Pharos's existing chat router consumes.
 *
 * Pure function — no I/O. Same input always produces same output.
 */
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
