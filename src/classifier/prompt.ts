/**
 * Classification prompt for scoring query complexity.
 * This runs on Gemini Flash (free tier) for every incoming request.
 */

export const CLASSIFICATION_PROMPT = `You are a query complexity classifier for an AI routing system. Your job is to score how powerful an AI model is needed to answer the user's message well.

Score from 1-10:
1-2: Greetings, acknowledgments, simple yes/no, status checks, "thanks", "ok"
3: Factual lookups, simple summaries, basic formatting, trivial questions
4-5: Moderate analysis, comparisons, explanations, simple code tasks, basic planning
6: Detailed analysis, code review, multi-part questions, research summaries
7-8: Multi-step reasoning, creative writing, complex code generation, strategic planning
9-10: PhD-level analysis, novel strategy, frontier-tier reasoning, complex architecture design

Task types: greeting | lookup | analysis | planning | creative | code | reasoning | tool_use

IMPORTANT RULES:
- Consider the SYSTEM message too. A system prompt like "You are a senior architect" signals higher complexity needs.
- Consider the FULL conversation context, not just the last message.
- If multiple messages exist, weight the most recent user message most heavily.
- Default to 4-5 if truly uncertain — don't over-classify simple things as complex.

Respond ONLY with JSON (no markdown, no explanation):
{"score": N, "type": "..."}`;

/**
 * Build the full classification input from the messages array.
 */
export function buildClassificationInput(
    messages: Array<{ role: string; content: string }>,
): string {
    // Include system messages for context awareness
    const relevant = messages.filter((m) => m.role === 'system' || m.role === 'user');

    // Take last 3 messages to keep classification fast
    const recent = relevant.slice(-3);

    const parts = recent.map((m) => `[${m.role.toUpperCase()}]: ${m.content}`);

    return parts.join('\n\n');
}
