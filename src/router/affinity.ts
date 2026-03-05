/**
 * Task-type affinity — reorders model candidates based on what each
 * provider is best at for a given task type.
 *
 * When the classifier says "this is a code task", we want DeepSeek
 * (great at code) to be tried before Claude (great at everything but
 * more expensive). This module handles that reordering.
 */

import type { ModelCandidate } from './failover.js';

/**
 * Map of task type → preferred provider order.
 * Providers listed first are tried first within each tier.
 * Providers not listed keep their original config order.
 */
export const DEFAULT_TASK_AFFINITY: Record<string, string[]> = {
    code: ['deepseek', 'together', 'fireworks', 'anthropic'],
    math: ['together', 'openai', 'anthropic', 'deepseek'],
    reasoning: ['anthropic', 'deepseek', 'openai'],
    creative: ['anthropic', 'google', 'openai'],
    conversation: ['groq', 'together', 'fireworks', 'google'],
    analysis: ['deepseek', 'together', 'anthropic', 'openai'],
    planning: ['anthropic', 'openai', 'deepseek'],
    // Types with no strong preference use default config order
    greeting: [],
    lookup: [],
    tool_use: [],
};

/**
 * Sort candidates by task-type affinity.
 *
 * Within each tier group, candidates whose provider appears in the
 * affinity list are moved to the front (in affinity order). Candidates
 * not in the affinity list keep their original relative order and
 * appear after the preferred ones.
 *
 * Tier ordering is preserved — we never move a candidate from a
 * lower-priority tier ahead of a higher-priority one.
 */
export function sortByAffinity(
    candidates: ModelCandidate[],
    taskType: string,
    affinityMap: Record<string, string[]>,
): ModelCandidate[] {
    const preferred = affinityMap[taskType];
    if (!preferred || preferred.length === 0) {
        return candidates; // no affinity for this type, keep config order
    }

    // Group candidates by tier (preserving encounter order)
    const tierGroups = new Map<string, ModelCandidate[]>();
    const tierOrder: string[] = [];

    for (const c of candidates) {
        if (!tierGroups.has(c.tier)) {
            tierGroups.set(c.tier, []);
            tierOrder.push(c.tier);
        }
        tierGroups.get(c.tier)!.push(c);
    }

    // Sort within each tier group
    const result: ModelCandidate[] = [];
    for (const tier of tierOrder) {
        const group = tierGroups.get(tier)!;
        const sorted = sortGroup(group, preferred);
        result.push(...sorted);
    }

    return result;
}

/**
 * Sort a single tier group by provider affinity.
 * Preferred providers come first (in affinity order), rest keep original order.
 */
function sortGroup(group: ModelCandidate[], preferred: string[]): ModelCandidate[] {
    // Build a priority map: provider → index in preferred list
    const priority = new Map<string, number>();
    for (let i = 0; i < preferred.length; i++) {
        priority.set(preferred[i], i);
    }

    // Partition into preferred and rest
    const preferredCandidates: ModelCandidate[] = [];
    const rest: ModelCandidate[] = [];

    for (const c of group) {
        if (priority.has(c.provider)) {
            preferredCandidates.push(c);
        } else {
            rest.push(c);
        }
    }

    // Sort preferred by their affinity order
    preferredCandidates.sort((a, b) => priority.get(a.provider)! - priority.get(b.provider)!);

    return [...preferredCandidates, ...rest];
}
