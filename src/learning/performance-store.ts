import type { Sql } from 'postgres';
import type { Logger } from '../utils/logger.js';

export interface PerformanceLearningConfig {
    enabled: boolean;
    minConfidenceSamples: number;
    decayFactor: number;
    maxWeight: number;
    minWeight: number;
}

export interface PerformanceWeight {
    provider: string;
    model: string;
    taskType: string;
    weight: number;
    successRate: number;
    avgLatencyMs: number;
    sampleCount: number;
}

interface PerfRow {
    provider: string;
    model: string;
    task_type: string;
    success_count: number;
    error_count: number;
    total_latency_ms: number;
}

/**
 * Tracks per-model per-task-type success/failure rates and latencies
 * in Postgres. Computes routing weights that influence candidate ordering.
 */
export class PerformanceLearningStore {
    private sql: Sql;
    private logger: Logger;
    private config: PerformanceLearningConfig;

    /** Median latency baseline (ms) used as reference in latency factor */
    private static readonly MEDIAN_LATENCY_MS = 2000;

    constructor(sql: Sql, logger: Logger, config: PerformanceLearningConfig) {
        this.sql = sql;
        this.logger = logger;
        this.config = config;
    }

    /**
     * Record an outcome after a request completes (or fails).
     */
    async recordOutcome(
        provider: string,
        model: string,
        taskType: string,
        success: boolean,
        latencyMs: number,
    ): Promise<void> {
        const successAdd = success ? 1 : 0;
        const errorAdd = success ? 0 : 1;
        const latencyAdd = success ? Math.max(0, Math.round(latencyMs)) : 0;
        const now = new Date().toISOString();
        try {
            await this.sql`
                INSERT INTO model_performance (
                    provider, model, task_type, success_count, error_count, total_latency_ms, last_updated
                ) VALUES (
                    ${provider}, ${model}, ${taskType}, ${successAdd}, ${errorAdd}, ${latencyAdd}, ${now}
                )
                ON CONFLICT (provider, model, task_type) DO UPDATE SET
                    success_count = model_performance.success_count + ${successAdd},
                    error_count   = model_performance.error_count   + ${errorAdd},
                    total_latency_ms = model_performance.total_latency_ms + ${latencyAdd},
                    last_updated  = ${now}
            `;
        } catch (err) {
            this.logger.error({ err, provider, model, taskType }, 'Failed to record performance outcome');
        }
    }

    /**
     * Get the routing weight for a specific model + task type.
     * Returns weight 1.0 (neutral) if no data exists.
     */
    async getWeight(provider: string, model: string, taskType: string): Promise<PerformanceWeight> {
        try {
            const rows = await this.sql<PerfRow[]>`
                SELECT provider, model, task_type, success_count, error_count, total_latency_ms
                FROM model_performance
                WHERE provider = ${provider} AND model = ${model} AND task_type = ${taskType}
            `;
            if (!rows[0]) {
                return this.neutralWeight(provider, model, taskType);
            }
            return this.computeWeight(rows[0]);
        } catch (err) {
            this.logger.error({ err, provider, model, taskType }, 'Failed to get performance weight');
            return this.neutralWeight(provider, model, taskType);
        }
    }

    /**
     * Get all weights for a given task type. Used to sort an entire candidate list.
     */
    async getWeightsForTaskType(taskType: string): Promise<PerformanceWeight[]> {
        try {
            const rows = await this.sql<PerfRow[]>`
                SELECT provider, model, task_type, success_count, error_count, total_latency_ms
                FROM model_performance
                WHERE task_type = ${taskType}
            `;
            return rows.map(row => this.computeWeight(row));
        } catch (err) {
            this.logger.error({ err, taskType }, 'Failed to get performance weights for task type');
            return [];
        }
    }

    /**
     * Decay old data toward baseline. Called on startup.
     * Multiplies all counts by decayFactor (e.g. 0.85).
     * After ~5 restarts, old data contributes <45%.
     */
    async applyDecay(decayFactor?: number): Promise<void> {
        const factor = decayFactor ?? this.config.decayFactor;
        try {
            await this.sql`
                UPDATE model_performance SET
                    success_count    = FLOOR(success_count::FLOAT    * ${factor}),
                    error_count      = FLOOR(error_count::FLOAT      * ${factor}),
                    total_latency_ms = FLOOR(total_latency_ms::FLOAT * ${factor})
            `;
            await this.sql`
                DELETE FROM model_performance
                WHERE success_count = 0 AND error_count = 0
            `;
            this.logger.info({ decayFactor: factor }, 'Performance learning data decayed');
        } catch (err) {
            this.logger.error({ err }, 'Failed to apply performance decay');
        }
    }

    /**
     * Reset all learning data. Admin escape hatch.
     */
    async reset(): Promise<void> {
        try {
            await this.sql`DELETE FROM model_performance`;
            this.logger.info('Performance learning data reset');
        } catch (err) {
            this.logger.error({ err }, 'Failed to reset performance data');
        }
    }

    /**
     * Get the total number of tracked model+taskType combinations.
     */
    async getTrackedCount(): Promise<number> {
        try {
            const rows = await this.sql<{ count: string }[]>`SELECT COUNT(*) AS count FROM model_performance`;
            return Number(rows[0]?.count ?? 0);
        } catch {
            return 0;
        }
    }

    /**
     * Get top performers (highest weight) across all task types.
     */
    async getTopPerformers(limit: number = 5): Promise<PerformanceWeight[]> {
        try {
            const rows = await this.sql<PerfRow[]>`
                SELECT provider, model, task_type, success_count, error_count, total_latency_ms
                FROM model_performance
                WHERE success_count + error_count > 0
                ORDER BY success_count::REAL / (success_count + error_count) DESC
                LIMIT ${limit}
            `;
            return rows.map(row => this.computeWeight(row));
        } catch {
            return [];
        }
    }

    /**
     * Get worst performers (lowest weight) across all task types.
     */
    async getWorstPerformers(limit: number = 5): Promise<PerformanceWeight[]> {
        try {
            const rows = await this.sql<PerfRow[]>`
                SELECT provider, model, task_type, success_count, error_count, total_latency_ms
                FROM model_performance
                WHERE success_count + error_count > 0
                ORDER BY success_count::REAL / (success_count + error_count) ASC
                LIMIT ${limit}
            `;
            return rows.map(row => this.computeWeight(row));
        } catch {
            return [];
        }
    }

    // ─── Private helpers ───

    private computeWeight(row: PerfRow): PerformanceWeight {
        // postgres returns bigint columns as strings — coerce to number
        const successCount = Number(row.success_count);
        const errorCount = Number(row.error_count);
        const totalLatencyMs = Number(row.total_latency_ms);

        const total = successCount + errorCount;
        if (total === 0) {
            return this.neutralWeight(row.provider, row.model, row.task_type);
        }

        const successRate = successCount / total;
        const avgLatencyMs = successCount > 0
            ? totalLatencyMs / successCount
            : PerformanceLearningStore.MEDIAN_LATENCY_MS;

        // Latency factor: faster than median = bonus, slower = penalty
        const latencyFactor = Math.min(
            this.config.maxWeight,
            Math.max(this.config.minWeight, PerformanceLearningStore.MEDIAN_LATENCY_MS / Math.max(avgLatencyMs, 1)),
        );

        const rawWeight = successRate * latencyFactor;

        // Confidence: ramp from 0 to 1 over minConfidenceSamples
        const confidence = Math.min(total / this.config.minConfidenceSamples, 1.0);

        // Blend toward neutral (1.0) when confidence is low
        let weight = 1.0 + (rawWeight - 1.0) * confidence;

        // Clamp
        weight = Math.min(this.config.maxWeight, Math.max(this.config.minWeight, weight));

        // Guard against NaN/Infinity
        if (!Number.isFinite(weight)) {
            weight = 1.0;
        }

        return {
            provider: row.provider,
            model: row.model,
            taskType: row.task_type,
            weight,
            successRate,
            avgLatencyMs: Math.round(avgLatencyMs),
            sampleCount: total,
        };
    }

    private neutralWeight(provider: string, model: string, taskType: string): PerformanceWeight {
        return {
            provider,
            model,
            taskType,
            weight: 1.0,
            successRate: 0,
            avgLatencyMs: 0,
            sampleCount: 0,
        };
    }
}
