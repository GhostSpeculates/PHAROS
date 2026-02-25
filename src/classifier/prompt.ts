/**
 * Classification prompt for scoring query complexity.
 * This runs on a lightweight classifier model for every incoming request.
 */

import type { Logger } from '../utils/logger.js';

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
  Examples: "Design a microservices architecture for an e-commerce platform with 10M DAUs", "Implement a lock-free concurrent hash map in C++ using atomic operations", "Implement a B-tree in C with delete operations", "Write a comprehensive comparison of Raft vs Paxos", "Design a compiler optimization pipeline", "Deep technical analysis of the CAP theorem and its implications for distributed databases"
  Rule: Advanced system design (even at massive scale), complex data structure implementations (B-trees, lock-free structures, skip lists), deep technical analyses (CAP theorem, consensus algorithms, type theory), compiler/interpreter design, strategic planning, lengthy creative writing. This is the CEILING for ALL standard engineering work, no matter how complex. If the topic exists in textbooks, university courses, or established engineering practice, it scores 8 AT MOST.

9 — FRONTIER (frontier tier — RARE)
  Examples: "Derive a novel proof connecting information theory to neural network generalization bounds", "Design a formally verified distributed consensus protocol with Byzantine fault tolerance proofs"
  Rule: ONLY when the task requires NOVEL THEORETICAL SYNTHESIS that does not exist in textbooks or established literature. This means creating genuinely new theory, not applying known theory. DO NOT score 9 just because a task is long, detailed, or touches multiple topics. Standard engineering tasks score 7-8 no matter how complex. Score 9 only when the task requires inventing something new at a PhD-research level — combining multiple academic specialties in ways that haven't been done before, or demanding formal mathematical proofs that bridge unrelated fields. Ask yourself: could a knowledgeable engineer answer this by studying existing resources? If yes, score 7-8.

10 — EXCEPTIONAL (frontier tier — EXTREMELY RARE)
  Examples: "Unify RLHF with mechanism design theory using Arrow's impossibility theorem and provide formal proofs", "Derive new bounds on transformer expressiveness using circuit complexity theory"
  Rule: Publishable-quality novel research synthesis across 3+ academic disciplines with formal mathematical rigor. Almost nothing scores 10.

Task types: greeting | lookup | analysis | planning | creative | code | reasoning | tool_use

CRITICAL RULES:
- Consider the SYSTEM message too. A system prompt like "You are a senior architect" signals higher complexity.
- Consider the FULL conversation context, not just the last message.
- If multiple messages exist, weight the most recent user message most heavily.
- Default to 5 if truly uncertain — never over-classify.
- 99% of tasks should score 1-8. Score 9-10 is for genuinely unprecedented research questions only.
- A long or detailed prompt does NOT automatically mean high complexity. "Design a REST API with 10 endpoints" is still 7-8, not 9-10.
- Having a complex system prompt (like an AI agent persona) does NOT push the score to 9-10 — judge the USER's actual question.

COMMON OVER-CLASSIFICATION MISTAKES (these are NOT 9-10):
- "Design a microservices architecture for a platform with 10M DAUs" → 7-8 (well-established engineering, covered in every system design textbook)
- "Implement a lock-free concurrent hash map in C++" → 8 (challenging but a known technique with published implementations)
- "Design a compiler optimization pipeline" → 8 (computer science curriculum, well-documented in textbooks like the Dragon Book)
- "Analyze the CAP theorem and its tradeoffs" → 7-8 (well-documented topic with decades of literature)
- "Analyze game theory in cryptocurrency mining pools" → 7-8 (applied game theory, published research exists)
- "Write a detailed technical analysis of distributed consensus" → 7-8 (standard distributed systems topic)
All of these are complex and valuable tasks, but they have KNOWN SOLUTIONS and EXISTING LITERATURE. They belong in premium (7-8), not frontier (9-10).

Respond ONLY with JSON (no markdown, no explanation):
{"score": N, "type": "..."}`;

/** Max characters per individual message sent to the classifier. */
const MAX_PER_MESSAGE = 1000;

/** Max total characters for the classifier input. */
const MAX_TOTAL = 4000;

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
 * Truncate a string to a max length, adding a marker if truncated.
 */
function truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + '...[truncated]';
}

/**
 * Build the classification input from the messages array.
 *
 * Keeps the classifier input small to avoid hitting provider token limits:
 * - System messages: first one only, truncated to 1000 chars
 * - User messages: last 3 only, each truncated to 1000 chars
 * - Total output capped at 4000 chars
 */
export function buildClassificationInput(
    messages: Array<{ role: string; content: unknown }>,
    logger?: Logger,
): string {
    const parts: string[] = [];
    let truncated = false;

    // Include first system message (truncated)
    const systemMsg = messages.find((m) => m.role === 'system');
    if (systemMsg) {
        const text = extractTextContent(systemMsg.content);
        if (text.length > MAX_PER_MESSAGE) truncated = true;
        parts.push(`[SYSTEM]: ${truncate(text, MAX_PER_MESSAGE)}`);
    }

    // Include last 3 user messages (each truncated)
    const userMsgs = messages.filter((m) => m.role === 'user');
    const recentUsers = userMsgs.slice(-3);
    for (const msg of recentUsers) {
        const text = extractTextContent(msg.content);
        if (text.length > MAX_PER_MESSAGE) truncated = true;
        parts.push(`[USER]: ${truncate(text, MAX_PER_MESSAGE)}`);
    }

    const combined = parts.join('\n\n');

    // Final safety cap
    if (combined.length > MAX_TOTAL) {
        truncated = true;
        const result = combined.slice(0, MAX_TOTAL) + '\n[...truncated]';
        if (logger && truncated) {
            logger.debug(
                { originalLength: combined.length, maxTotal: MAX_TOTAL },
                'Classifier input truncated (total cap exceeded)',
            );
        }
        return result;
    }

    if (logger && truncated) {
        logger.debug(
            { messageCount: messages.length, maxPerMessage: MAX_PER_MESSAGE },
            'Classifier input truncated (individual message cap exceeded)',
        );
    }

    return combined;
}
