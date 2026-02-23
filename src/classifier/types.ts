/**
 * Classification result types for the query classifier.
 */

export const TASK_TYPES = [
    'greeting',
    'lookup',
    'analysis',
    'planning',
    'creative',
    'code',
    'reasoning',
    'tool_use',
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export interface ClassificationResult {
    /** Complexity score from 1-10 */
    score: number;
    /** The classified task type */
    type: TaskType;
    /** How long classification took (ms) */
    latencyMs: number;
    /** Whether this was a fallback (classifier failed) */
    isFallback: boolean;
    /** Which classifier provider handled this request */
    classifierProvider: string;
}
