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

    constructor(dbPath: string, logger: Logger) {
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

        this.insertStmt = this.db.prepare(`
      INSERT INTO requests (
        id, timestamp, tier, provider, model,
        classification_score, classification_type, classification_latency_ms,
        tokens_in, tokens_out, estimated_cost, baseline_cost, savings,
        total_latency_ms, stream, is_direct_route, user_message_preview
      ) VALUES (
        @id, @timestamp, @tier, @provider, @model,
        @classificationScore, @classificationType, @classificationLatencyMs,
        @tokensIn, @tokensOut, @estimatedCost, @baselineCost, @savings,
        @totalLatencyMs, @stream, @isDirectRoute, @userMessagePreview
      )
    `);

        // Clean up entries older than 30 days on startup
        this.purgeOldRecords(30);

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
        if (this.closed) return;
        try {
            this.insertStmt.run({
                ...record,
                stream: record.stream ? 1 : 0,
                isDirectRoute: record.isDirectRoute ? 1 : 0,
                userMessagePreview: record.userMessagePreview ?? null,
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
          COALESCE(SUM(savings), 0) as total_savings
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

        return {
            totalRequests: totals.total_requests,
            totalCost,
            totalBaselineCost,
            totalSavings: totals.total_savings,
            savingsPercent: totalBaselineCost > 0 ? ((totalBaselineCost - totalCost) / totalBaselineCost) * 100 : 0,
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
    }> {
        const rows = this.db
            .prepare(
                `SELECT
                    timestamp, user_message_preview, classification_score, classification_type,
                    tier, provider, model, tokens_in + tokens_out as tokens,
                    estimated_cost, total_latency_ms, stream
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
