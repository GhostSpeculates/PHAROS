/**
 * Prompt Enhancement Layer — makes cheap models smarter.
 *
 * Appends task-type-specific reasoning hints to system messages for
 * free/economical tier models. Costs nothing but dramatically improves
 * output quality on weaker models.
 *
 * Premium/frontier models don't need it — they already reason well.
 * Trivial task types (greeting, lookup) are skipped.
 */

import type { ChatMessage } from '../providers/types.js';
import type { PharosConfig, TierName } from '../config/schema.js';
import type { TaskType } from '../classifier/types.js';

export interface EnhancementResult {
    /** Whether the prompt was enhanced */
    enhanced: boolean;
    /** The (possibly modified) messages array — never mutates the original */
    messages: ChatMessage[];
    /** The hint that was appended, if any */
    hint?: string;
}

/** Default hints per task type */
const DEFAULT_HINTS: Partial<Record<TaskType, string>> = {
    code: 'Think step by step. Consider edge cases and error handling. Write clean, well-documented code.',
    reasoning: 'Break this problem into steps before answering. State your assumptions. Verify your reasoning.',
    math: 'Show your work step by step. Double-check your calculations before giving the final answer.',
    analysis: 'Consider multiple perspectives. Support claims with evidence. Structure your response clearly.',
    planning: 'Structure your plan with numbered steps. Consider risks, alternatives, and dependencies.',
    creative: 'Be creative and original. Consider the audience and tone.',
    conversation: 'Be helpful, concise, and engaging.',
    tool_use: 'Follow the tool\'s expected format precisely. Validate inputs before making calls.',
};

/** Task types that get no enhancement (trivial, no benefit) */
const SKIP_TASK_TYPES: Set<string> = new Set(['greeting', 'lookup']);

/** Tiers that don't need enhancement (already smart enough) */
const DEFAULT_EXCLUDE_TIERS: Set<string> = new Set(['premium', 'frontier']);

/**
 * Enhance the prompt for cheaper models by appending task-specific hints.
 *
 * Rules:
 * - Only activates for free/economical tiers (configurable)
 * - Skips greeting and lookup task types
 * - Appends hint to existing system message or creates one
 * - Never mutates the original messages array
 * - Can be fully disabled via config
 */
export function enhancePrompt(
    messages: ChatMessage[],
    taskType: TaskType,
    tier: TierName,
    config: PharosConfig,
): EnhancementResult {
    const noChange: EnhancementResult = { enhanced: false, messages };

    // Check if feature is enabled
    const enhancementConfig = (config as any).promptEnhancement;
    if (enhancementConfig?.enabled === false) {
        return noChange;
    }

    // Check if this tier should be excluded
    const excludeTiers: Set<string> = enhancementConfig?.excludeTiers
        ? new Set(enhancementConfig.excludeTiers)
        : DEFAULT_EXCLUDE_TIERS;

    if (excludeTiers.has(tier)) {
        return noChange;
    }

    // Skip trivial task types
    if (SKIP_TASK_TYPES.has(taskType)) {
        return noChange;
    }

    // Get the hint for this task type (config overrides > defaults)
    const configHints: Record<string, string> | undefined = enhancementConfig?.hints;
    const hint = configHints?.[taskType] ?? DEFAULT_HINTS[taskType];

    if (!hint) {
        return noChange;
    }

    // Clone messages and append hint to system message
    const enhanced = [...messages];
    const systemIndex = enhanced.findIndex(m => m.role === 'system');

    if (systemIndex >= 0) {
        // Append to existing system message
        const existing = enhanced[systemIndex];
        const existingContent = typeof existing.content === 'string'
            ? existing.content
            : '';

        enhanced[systemIndex] = {
            ...existing,
            content: existingContent + '\n\n' + hint,
        };
    } else {
        // No system message — prepend one
        enhanced.unshift({ role: 'system', content: hint });
    }

    return { enhanced: true, messages: enhanced, hint };
}
