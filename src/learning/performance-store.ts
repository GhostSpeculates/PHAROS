import type Database from 'better-sqlite3';
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

/**
 * Tracks per-model per-task-type success/failure rates and latencies
 * in SQLite. Computes routing weights that influence candidate ordering.
 */
export class PerformanceLearningStore {
    private db: Database.Database;
    private logger: Logger;
    private config: PerformanceLearningConfig;
    private upsertStmt: Database.Statement;
    private getStmt: Database.Statement;
    private getByTaskTypeStmt: Database.Statement;

    /** Median latency baseline (ms) used as reference in latency factor */
    private static readonly MEDIAN_LATENCY_MS = 2000;

    constructor(db: Database.Database, logger: Logger, config: PerformanceLearningConfig) {
        this.db = db;
        this.logger = logger;
        this.config = config;

        // Create table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS model_performance (
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                task_type TEXT NOT NULL,
                success_count INTEGER NOT NULL DEFAULT 0,
                error_count INTEGER NOT NULL DEFAULT 0,
                total_latency_ms INTEGER NOT NULL DEFAULT 0,
                last_updated TEXT NOT NULL,
                PRIMARY KEY (provider, model, task_type)
            )
        `);

        // Prepare statements
        this.upsertStmt = this.db.prepare(`
            INSERT INTO model_performance (provider, model, task_type, success_count, error_count, total_latency_ms, last_updated)
            VALUES (@provider, @model, @taskType, @successAdd, @errorAdd, @latencyAdd, @now)
            ON CONFLICT(provider, model, task_type) DO UPDATE SET
                success_count = success_count + @successAdd,
                error_count = error_count + @errorAdd,
                total_latency_ms = total_latency_ms + @latencyAdd,
                last_updated = @now
        `);

        this.getStmt = this.db.prepare(`
            SELECT provider, model, task_type, success_count, error_count, total_latency_ms
            FROM model_performance
            WHERE provider = ? AND model = ? AND task_type = ?
        `);

        this.getByTaskTypeStmt = this.db.prepare(`
            SELECT provider, model, task_type, success_count, error_count, total_latency_ms
            FROM model_performance
            WHERE task_type = ?
        `);
    }

    /**
     * Record an outcome after a request completes (or fails).
     */
    recordOutcome(
        provider: string,
        model: string,
        taskType: string,
        success: boolean,
        latencyMs: number,
    ): void {
        try {
            this.upsertStmt.run({
                provider,
                model,
                taskType,
                successAdd: success ? 1 : 0,
                errorAdd: success ? 0 : 1,
                latencyAdd: success ? Math.max(0, Math.round(latencyMs)) : 0,
                now: new Date().toISOString(),
            });
        } catch (err) {
            this.logger.error({ err, provider, model, taskType }, 'Failed to record performance outcome');
        }
    }

    /**
     * Get the routing weight for a specific model + task type.
     * Returns weight 1.0 (neutral) if no data exists.
     */
    getWeight(provider: string, model: string, taskType: string): PerformanceWeight {
        try {
            const row = this.getStmt.get(provider, model, taskType) as
                | { provider: string; model: string; task_type: string; success_count: number; error_count: number; total_latency_ms: number }
                | undefined;

            if (!row) {
                return this.neutralWeight(provider, model, taskType);
            }

            return this.computeWeight(row);
        } catch (err) {
            this.logger.error({ err, provider, model, taskType }, 'Failed to get performance weight');
            return this.neutralWeight(provider, model, taskType);
        }
    }

    /**
     * Get all weights for a given task type. Used to sort an entire candidate list.
     */
    getWeightsForTaskType(taskType: string): PerformanceWeight[] {
        try {
            const rows = this.getByTaskTypeStmt.all(taskType) as Array<{
                provider: string;
                model: string;
                task_type: string;
                success_count: number;
                error_count: number;
                total_latency_ms: number;
            }>;

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
    applyDecay(decayFactor?: number): void {
        const factor = decayFactor ?? this.config.decayFactor;
        try {
            this.db.exec(`
                UPDATE model_performance SET
                    success_count = CAST(success_count * ${factor} AS INTEGER),
                    error_count = CAST(error_count * ${factor} AS INTEGER),
                    total_latency_ms = CAST(total_latency_ms * ${factor} AS INTEGER)
            `);
            // Clean up rows that have decayed to zero
            this.db.exec(`
                DELETE FROM model_performance
                WHERE success_count = 0 AND error_count = 0
            `);
            this.logger.info({ decayFactor: factor }, 'Performance learning data decayed');
        } catch (err) {
            this.logger.error({ err }, 'Failed to apply performance decay');
        }
    }

    /**
     * Reset all learning data. Admin escape hatch.
     */
    reset(): void {
        try {
            this.db.exec('DELETE FROM model_performance');
            this.logger.info('Performance learning data reset');
        } catch (err) {
            this.logger.error({ err }, 'Failed to reset performance data');
        }
    }

    /**
     * Get the total number of tracked model+taskType combinations.
     */
    getTrackedCount(): number {
        try {
            const row = this.db.prepare('SELECT COUNT(*) as count FROM model_performance').get() as { count: number };
            return row.count;
        } catch {
            return 0;
        }
    }

    /**
     * Get top performers (highest weight) across all task types.
     */
    getTopPerformers(limit: number = 5): PerformanceWeight[] {
        try {
            const rows = this.db.prepare(
                'SELECT provider, model, task_type, success_count, error_count, total_latency_ms FROM model_performance WHERE success_count + error_count > 0 ORDER BY CAST(success_count AS REAL) / (success_count + error_count) DESC LIMIT ?',
            ).all(limit) as Array<{
                provider: string;
                model: string;
                task_type: string;
                success_count: number;
                error_count: number;
                total_latency_ms: number;
            }>;
            return rows.map(row => this.computeWeight(row));
        } catch {
            return [];
        }
    }

    /**
     * Get worst performers (lowest weight) across all task types.
     */
    getWorstPerformers(limit: number = 5): PerformanceWeight[] {
        try {
            const rows = this.db.prepare(
                'SELECT provider, model, task_type, success_count, error_count, total_latency_ms FROM model_performance WHERE success_count + error_count > 0 ORDER BY CAST(success_count AS REAL) / (success_count + error_count) ASC LIMIT ?',
            ).all(limit) as Array<{
                provider: string;
                model: string;
                task_type: string;
                success_count: number;
                error_count: number;
                total_latency_ms: number;
            }>;
            return rows.map(row => this.computeWeight(row));
        } catch {
            return [];
        }
    }

    // ─── Private helpers ───

    private computeWeight(row: {
        provider: string;
        model: string;
        task_type: string;
        success_count: number;
        error_count: number;
        total_latency_ms: number;
    }): PerformanceWeight {
        const total = row.success_count + row.error_count;
        if (total === 0) {
            return this.neutralWeight(row.provider, row.model, row.task_type);
        }

        const successRate = row.success_count / total;
        const avgLatencyMs = row.success_count > 0
            ? row.total_latency_ms / row.success_count
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
