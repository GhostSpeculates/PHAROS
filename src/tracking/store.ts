import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { RequestRecord, CostSummary } from './types.js';
import type { Logger } from '../utils/logger.js';

/**
 * SQLite store for tracking all requests, costs, and savings.
 *
 * Every request that flows through Pharos gets a row in this database.
 * This powers the cost dashboard and savings calculations.
 */
export class TrackingStore {
    private db: Database.Database;
    private insertStmt: Database.Statement;
    private logger: Logger;
    private closed = false;

    constructor(dbPath: string, logger: Logger, retentionDays: number = 30) {
        this.logger = logger;

        // Ensure directory exists
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL'); // Better concurrent performance

        // Create tables
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        tier TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        classification_score INTEGER NOT NULL,
        classification_type TEXT NOT NULL,
        classification_latency_ms INTEGER NOT NULL,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        estimated_cost REAL NOT NULL DEFAULT 0,
        baseline_cost REAL NOT NULL DEFAULT 0,
        savings REAL NOT NULL DEFAULT 0,
        total_latency_ms INTEGER NOT NULL DEFAULT 0,
        stream INTEGER NOT NULL DEFAULT 0,
        is_direct_route INTEGER NOT NULL DEFAULT 0,
        user_message_preview TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp);
      CREATE INDEX IF NOT EXISTS idx_requests_tier ON requests(tier);
      CREATE INDEX IF NOT EXISTS idx_requests_provider ON requests(provider);
    `);

        // Migrate existing databases: add columns that may not exist yet
        const columns = this.db.prepare("PRAGMA table_info(requests)").all() as Array<{ name: string }>;
        const columnNames = new Set(columns.map(c => c.name));

        if (!columnNames.has('user_message_preview')) {
            this.db.exec('ALTER TABLE requests ADD COLUMN user_message_preview TEXT');
        }
        if (!columnNames.has('classifier_provider')) {
            this.db.exec("ALTER TABLE requests ADD COLUMN classifier_provider TEXT DEFAULT 'unknown'");
        }
        if (!columnNames.has('status')) {
            this.db.exec("ALTER TABLE requests ADD COLUMN status TEXT DEFAULT 'success'");
        }
        if (!columnNames.has('error_message')) {
            this.db.exec('ALTER TABLE requests ADD COLUMN error_message TEXT');
        }

        // Index on classifier_provider — must run after migration adds the column
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_requests_classifier_provider ON requests(classifier_provider)');
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status)');

        this.insertStmt = this.db.prepare(`
      INSERT INTO requests (
        id, timestamp, tier, provider, model,
        classification_score, classification_type, classification_latency_ms,
        classifier_provider,
        tokens_in, tokens_out, estimated_cost, baseline_cost, savings,
        total_latency_ms, stream, is_direct_route, user_message_preview,
        status, error_message
      ) VALUES (
        @id, @timestamp, @tier, @provider, @model,
        @classificationScore, @classificationType, @classificationLatencyMs,
        @classifierProvider,
        @tokensIn, @tokensOut, @estimatedCost, @baselineCost, @savings,
        @totalLatencyMs, @stream, @isDirectRoute, @userMessagePreview,
        @status, @errorMessage
      )
    `);

        // Clean up entries older than the retention period on startup
        this.purgeOldRecords(retentionDays);

        this.logger.debug({ dbPath }, 'Tracking store initialized');
    }

    /**
     * Delete tracking records older than the given number of days.
     * Runs once at startup to keep the database lean.
     */
    private purgeOldRecords(days: number): void {
        try {
            const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
            const result = this.db.prepare('DELETE FROM requests WHERE timestamp < ?').run(cutoff);
            if (result.changes > 0) {
                this.logger.info({ deleted: result.changes, olderThan: `${days} days` }, 'Purged old tracking records');
            }
        } catch (error) {
            this.logger.error({ error }, 'Failed to purge old tracking records');
        }
    }

    /**
     * Record a completed request.
     */
    record(record: RequestRecord): void {
        if (this.closed) {
            this.logger.warn({ recordId: record.id }, 'Tracking record dropped — store already closed');
            return;
        }
        try {
            this.insertStmt.run({
                ...record,
                classifierProvider: record.classifierProvider ?? 'unknown',
                stream: record.stream ? 1 : 0,
                isDirectRoute: record.isDirectRoute ? 1 : 0,
                userMessagePreview: record.userMessagePreview ?? null,
                status: record.status ?? 'success',
                errorMessage: record.errorMessage ?? null,
            });
        } catch (error) {
            this.logger.error({ error }, 'Failed to record request');
        }
    }

    /**
     * Get a cost summary for a time period.
     */
    getSummary(since?: string): CostSummary {
        const whereClause = since ? 'WHERE timestamp >= ?' : '';
        const params = since ? [since] : [];

        const totals = this.db
            .prepare(
                `SELECT
          COUNT(*) as total_requests,
          COALESCE(SUM(estimated_cost), 0) as total_cost,
          COALESCE(SUM(baseline_cost), 0) as total_baseline_cost,
          COALESCE(SUM(savings), 0) as total_savings,
          COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) as total_errors
        FROM requests ${whereClause}`,
            )
            .get(...params) as Record<string, number>;

        const byTier = this.db
            .prepare(
                `SELECT tier, COUNT(*) as count, COALESCE(SUM(estimated_cost), 0) as cost
        FROM requests ${whereClause}
        GROUP BY tier`,
            )
            .all(...params) as Array<{ tier: string; count: number; cost: number }>;

        const byProvider = this.db
            .prepare(
                `SELECT provider, COUNT(*) as count, COALESCE(SUM(estimated_cost), 0) as cost
        FROM requests ${whereClause}
        GROUP BY provider`,
            )
            .all(...params) as Array<{ provider: string; count: number; cost: number }>;

        const totalCost = totals.total_cost;
        const totalBaselineCost = totals.total_baseline_cost;
        const totalErrors = totals.total_errors;
        const totalRequests = totals.total_requests;

        return {
            totalRequests,
            totalCost,
            totalBaselineCost,
            totalSavings: totals.total_savings,
            savingsPercent: totalBaselineCost > 0 ? ((totalBaselineCost - totalCost) / totalBaselineCost) * 100 : 0,
            totalErrors,
            errorRate: totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0,
            byTier: Object.fromEntries(byTier.map((r) => [r.tier, { count: r.count, cost: r.cost }])),
            byProvider: Object.fromEntries(
                byProvider.map((r) => [r.provider, { count: r.count, cost: r.cost }]),
            ),
        };
    }

    /**
     * Get the most recent N requests.
     */
    getRecent(limit: number = 25): Array<{
        timestamp: string;
        preview: string | null;
        score: number;
        type: string;
        tier: string;
        provider: string;
        model: string;
        tokens: number;
        cost: number;
        latencyMs: number;
        stream: boolean;
        classifierProvider: string;
        status: string;
        errorMessage: string | null;
    }> {
        const rows = this.db
            .prepare(
                `SELECT
                    timestamp, user_message_preview, classification_score, classification_type,
                    tier, provider, model, tokens_in + tokens_out as tokens,
                    estimated_cost, total_latency_ms, stream, classifier_provider,
                    status, error_message
                FROM requests
                ORDER BY timestamp DESC
                LIMIT ?`,
            )
            .all(limit) as Array<Record<string, any>>;

        return rows.map((r) => ({
            timestamp: r.timestamp,
            preview: r.user_message_preview ?? null,
            score: r.classification_score,
            type: r.classification_type,
            tier: r.tier,
            provider: r.provider,
            model: r.model,
            tokens: r.tokens,
            cost: r.estimated_cost,
            latencyMs: r.total_latency_ms,
            stream: !!r.stream,
            classifierProvider: r.classifier_provider ?? 'unknown',
            status: r.status ?? 'success',
            errorMessage: r.error_message ?? null,
        }));
    }

    /**
     * Close the database connection.
     * Safe to call multiple times; subsequent calls are no-ops.
     */
    close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.db.close();
    }
}
