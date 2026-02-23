/**
 * Classification prompt for scoring query complexity.
 * This runs on Gemini Flash (free tier) for every incoming request.
 */

export const CLASSIFICATION_PROMPT = `You are a query complexity classifier for an AI routing system. Your job is to score how powerful an AI model is needed to answer the user's message well.

SCORING GUIDE (1-10):

1-2 — TRIVIAL (free tier)
  Examples: "Hi", "Thanks!", "ok", "How are you?", "Good morning"
  Rule: Greetings, acknowledgments, simple yes/no, one-word answers, status checks.

3 — SIMPLE (free tier)
  Examples: "What's the capital of France?", "Translate hello to Spanish", "What does HTML stand for?"
  Rule: Factual lookups, definitions, simple formatting, trivial questions with a single clear answer.

4-5 — MODERATE (economical tier)
  Examples: "Explain the difference between TCP and UDP", "Write a palindrome checker in Python", "Compare React vs Vue"
  Rule: Standard explanations, comparisons, simple code tasks, basic summaries. One topic, moderate depth.

6 — DETAILED (economical tier)
  Examples: "Explain how HTTPS works step by step", "Review this code for bugs", "Summarize the causes of WWI with analysis"
  Rule: Multi-part questions, code review, research summaries, detailed explanations requiring structure.

7 — COMPLEX (premium tier)
  Examples: "Design a REST API for a task management app", "Debug this race condition", "Write a Redis caching layer with eviction"
  Rule: Complex code generation, system design, multi-step debugging, technical deep-dives. This is where MOST hard tasks belong.

8 — ADVANCED (premium tier)
  Examples: "Design a microservices architecture for an e-commerce platform", "Implement a B-tree in C with delete operations", "Write a comprehensive comparison of Raft vs Paxos"
  Rule: Advanced system design, complex algorithms, strategic planning, lengthy creative writing. The CEILING for standard complex work.

9 — FRONTIER (frontier tier — RARE)
  Examples: "Derive a novel proof connecting information theory to neural network generalization bounds", "Design a formally verified distributed consensus protocol with Byzantine fault tolerance proofs"
  Rule: ONLY when the task combines multiple PhD-level specialties, requires novel theoretical synthesis, or demands formal mathematical proofs across domains. Ask yourself: would a senior engineer struggle with this? If yes but a PhD could handle it, score 8. If even a PhD would need to think hard, score 9.

10 — EXCEPTIONAL (frontier tier — EXTREMELY RARE)
  Examples: "Unify RLHF with mechanism design theory using Arrow's impossibility theorem and provide formal proofs", "Derive new bounds on transformer expressiveness using circuit complexity theory"
  Rule: Publishable-quality novel research synthesis across 3+ academic disciplines with formal mathematical rigor. Almost nothing scores 10.

Task types: greeting | lookup | analysis | planning | creative | code | reasoning | tool_use

CRITICAL RULES:
- Consider the SYSTEM message too. A system prompt like "You are a senior architect" signals higher complexity.
- Consider the FULL conversation context, not just the last message.
- If multiple messages exist, weight the most recent user message most heavily.
- Default to 5 if truly uncertain — never over-classify.
- 90% of complex tasks should score 7-8. Score 9-10 ONLY if the task is genuinely unprecedented in difficulty.
- A long or detailed prompt does NOT automatically mean high complexity. "Design a REST API with 10 endpoints" is still 7-8, not 9-10.
- Having a complex system prompt (like an AI agent persona) does NOT push the score to 9-10 — judge the USER's actual question.

Respond ONLY with JSON (no markdown, no explanation):
{"score": N, "type": "..."}`;

/**
 * Extract text content from a message, handling both string and array formats.
 */
function extractTextContent(content: unknown): string {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter((part: Record<string, unknown>) => part.type === 'text' && part.text)
            .map((part: Record<string, unknown>) => part.text as string)
            .join(' ');
    }
    return String(content);
}

/**
 * Build the full classification input from the messages array.
 */
export function buildClassificationInput(
    messages: Array<{ role: string; content: unknown }>,
): string {
    // Include system messages for context awareness
    const relevant = messages.filter((m) => m.role === 'system' || m.role === 'user');

    // Take last 3 messages to keep classification fast
    const recent = relevant.slice(-3);

    const parts = recent.map((m) => `[${m.role.toUpperCase()}]: ${extractTextContent(m.content)}`);
    const combined = parts.join('\n\n');

    // Truncate to ~4000 chars to stay within classifier model token limits (e.g. Groq 12K TPM)
    if (combined.length > 4000) {
        return combined.slice(0, 4000) + '\n[...truncated]';
    }
    return combined;
}
