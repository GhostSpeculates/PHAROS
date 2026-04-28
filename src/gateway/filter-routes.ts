/**
 * filter-routes.ts — Pharos Filter advisor mode (Wave 4 / 3.8).
 *
 * Per D5 of `~/.claude/plans/real-current-failures-in-robust-pizza.md`:
 *
 *   "Filter operates in two modes:
 *     - Enforcer (when calling through Pharos as provider): Filter intercepts,
 *       auto-rewrites the request to the right tier, debits wallet.
 *     - Advisor (when running on Max subscription, today): Filter exposes
 *       /v1/filter endpoint that returns strategy JSON. Bot/script reads it,
 *       adjusts --effort / --model flags before spawning claude -p.
 *
 *    Don't over-engineer. Advisor mode = one endpoint, one JSON shape, dead
 *    simple."
 *
 * This route does ZERO inference of the actual request. It only classifies
 * and emits a strategy. Caller (Discord bot, script) decides what to do
 * with the strategy.
 *
 * Response shape (locked):
 * {
 *   "task_class": "trading|reasoning|code|creative|analysis|conversation|classify|...",
 *   "complexity_score": 1-10,
 *   "needs_tool": boolean,        // when true, do NOT auto-degrade to T3
 *   "recommended_tier": "free|economical|premium|frontier",
 *   "recommended_model": "<provider>/<model>",  // best in tier
 *   "recommended_effort": "low|med|max",         // claude -p --effort hint
 *   "rationale": "one-line plain-English reason"
 * }
 */

import type { FastifyInstance } from 'fastify';
import type { Logger } from '../utils/logger.js';

interface FilterRequestBody {
    prompt?: string;
    messages?: Array<{ role: string; content: string }>;
    hints?: { vertical?: string; channel?: string; agent?: string };
}

interface FilterResponse {
    task_class: string;
    complexity_score: number;
    needs_tool: boolean;
    recommended_tier: 'free' | 'economical' | 'premium' | 'frontier';
    recommended_model: string;
    recommended_effort: 'low' | 'med' | 'max';
    rationale: string;
}

export function registerFilterRoutes(opts: {
    fastify: FastifyInstance;
    classifier?: { classify: (messages: Array<{ role: string; content: unknown }>) => Promise<{ score: number; type: string }> };
    logger: Logger;
}): void {
    const { fastify, classifier, logger } = opts;

    fastify.post('/v1/filter', async (req, reply) => {
        const body = (req.body ?? {}) as FilterRequestBody;
        const text = body.prompt ?? body.messages?.map(m => m.content).join('\n') ?? '';

        if (!text.trim()) {
            reply.status(400);
            return { error: 'empty prompt — provide either `prompt` or `messages`' };
        }

        // Heuristic owns needsTool detection in both classifier-present and -absent paths.
        const needsTool = detectNeedsTool(text);

        // Try real classifier first; fall back to full heuristic if it errors.
        let classification: { score: number; type: string; needsTool: boolean };
        if (classifier) {
            try {
                const messages = body.messages
                    ?? [{ role: 'user', content: body.prompt ?? '' }];
                const result = await classifier.classify(messages);
                classification = { score: result.score, type: result.type, needsTool };
            } catch (e) {
                logger.warn({ err: e }, '[filter] classifier failed, falling back to heuristic');
                classification = heuristic(text);
            }
        } else {
            classification = heuristic(text);
        }

        const out = strategyFromClassification(classification, body.hints);
        return out;
    });

    logger.info('[filter] route registered: POST /v1/filter (advisor mode, no inference)');
}

function detectNeedsTool(text: string): boolean {
    const lower = text.toLowerCase();
    return /\b(read|write|edit|search|fetch|browse|navigate|click|run|execute|deploy|commit)\b/.test(lower)
        || /https?:\/\//.test(lower);
}

function heuristic(text: string): { score: number; type: string; needsTool: boolean } {
    const lower = text.toLowerCase();
    const len = text.length;

    const needsTool = detectNeedsTool(text);

    // Task classification heuristics
    let type = 'conversation';
    if (/\b(trade|trading|nq|es|ym|futures|risk|pnl)\b/.test(lower)) type = 'trading';
    else if (/\b(refactor|implement|function|class|method|bug|fix|test)\b/.test(lower)) type = 'code';
    else if (/\b(why|reason|analyze|compare|evaluate|design)\b/.test(lower)) type = 'reasoning';
    else if (/\b(write|draft|copy|email|post|tweet|caption)\b/.test(lower)) type = 'creative';
    else if (/\b(summary|summarize|extract|classify|tag)\b/.test(lower)) type = 'classify';

    // Complexity: short trivia → low score, long multi-paragraph → high
    let score = 3;
    if (len > 2000) score += 3;
    if (len > 6000) score += 2;
    if (type === 'trading' || type === 'reasoning') score += 2;
    if (needsTool) score += 1;
    score = Math.max(1, Math.min(10, score));

    return { score, type, needsTool };
}

function strategyFromClassification(
    cls: { score: number; type: string; needsTool: boolean },
    hints: { vertical?: string; channel?: string; agent?: string } = {},
): FilterResponse {
    const score = cls.score;
    const needsTool = cls.needsTool;

    // Tier mapping (matches pharos.yaml tier policies)
    let tier: FilterResponse['recommended_tier'];
    let effort: FilterResponse['recommended_effort'];
    let model: string;

    if (score <= 3 && !needsTool) {
        tier = 'free';
        effort = 'low';
        model = 'groq/llama-3.3-70b-versatile';
    } else if (score <= 6) {
        tier = 'economical';
        effort = 'med';
        model = cls.type === 'code' ? 'deepseek/deepseek-chat' : 'moonshot/kimi-latest';
    } else if (score <= 8) {
        tier = 'premium';
        effort = 'med';
        model = 'anthropic/claude-sonnet-4-6';
    } else {
        tier = 'frontier';
        effort = 'max';
        // Wave 5 follow-up: swap to claude-opus-4-7-* once docs publish the dated id.
        // Using Opus 4.7 family (priced $5/$25) — see V2 hygiene tracker P1.
        model = 'anthropic/claude-opus-4-7';
    }

    // Trading channel always gets max effort + frontier (D2 — money on the line).
    if (hints.channel === 'trading' || hints.agent === 'quant') {
        tier = 'frontier';
        effort = 'max';
        model = 'anthropic/claude-opus-4-7';
    }

    const rationale = `score=${score}, type=${cls.type}, needs_tool=${needsTool} → ${tier} tier @ ${effort} effort`;

    return {
        task_class: cls.type,
        complexity_score: score,
        needs_tool: needsTool,
        recommended_tier: tier,
        recommended_model: model,
        recommended_effort: effort,
        rationale,
    };
}
