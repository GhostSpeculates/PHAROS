import type { ChatMessage } from '../providers/types.js';

/**
 * Known patterns that indicate an OpenClaw memory flush / bookkeeping prompt.
 * These carry full conversation context but are just internal note-taking —
 * no reason to route them to premium models.
 */
const FLUSH_PATTERNS: string[] = [
    'write any lasting notes',
    'save to memory',
    'save important',
    'update memory',
    'add to memory',
    'memory flush',
    'lasting notes',
];

/**
 * Check if the last user messages match a memory flush pattern.
 * Only inspects the last 2 user messages to avoid false positives
 * on older conversational references to "memory".
 */
export function isMemoryFlush(messages: ChatMessage[]): boolean {
    // Extract last 2 user messages
    const userMessages = messages.filter((m) => m.role === 'user').slice(-2);

    for (const msg of userMessages) {
        const text =
            typeof msg.content === 'string'
                ? msg.content
                : Array.isArray(msg.content)
                    ? msg.content
                        .filter((p: any) => p.type === 'text')
                        .map((p: any) => p.text)
                        .join(' ')
                    : String(msg.content ?? '');

        const lower = text.toLowerCase();
        for (const pattern of FLUSH_PATTERNS) {
            if (lower.includes(pattern)) {
                return true;
            }
        }
    }

    return false;
}
