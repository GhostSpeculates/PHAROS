import type { Sql } from 'postgres';
import type { RequestRecord, CostSummary } from './types.js';
import type { Logger } from '../utils/logger.js';

export interface TrackingStoreOptions {
    sql: Sql;
    logger: Logger;
}

/**
 * Postgres store for tracking all requests, costs, and savings.
 *
 * Every request that flows through Pharos gets a row in the `requests` table.
 * This powers the cost dashboard and savings calculations.
 */
export class TrackingStore {
    private sql: Sql;
    private logger: Logger;

    constructor(opts: TrackingStoreOptions) {
        this.sql = opts.sql;
        this.logger = opts.logger;
    }

    /**
     * Record a completed request.
     * Fire-and-forget safe: callers may void-wrap and catch.
     */
    async record(rec: RequestRecord): Promise<void> {
        await this.sql`
            INSERT INTO requests (
                id, timestamp, tier, provider, model,
                classification_score, classification_type, classification_latency_ms,
                classifier_provider, tokens_in, tokens_out, estimated_cost,
                baseline_cost, savings, total_latency_ms, provider_latency_ms,
                stream, is_direct_route, status, error_message,
                user_message_preview, debug_input, debug_output,
                agent_id, conversation_id, retry_count
            ) VALUES (
                ${rec.id}, ${rec.timestamp}, ${rec.tier}, ${rec.provider}, ${rec.model},
                ${rec.classificationScore}, ${rec.classificationType}, ${rec.classificationLatencyMs},
                ${rec.classifierProvider ?? 'unknown'},
                ${rec.tokensIn}, ${rec.tokensOut}, ${rec.estimatedCost},
                ${rec.baselineCost}, ${rec.savings}, ${rec.totalLatencyMs},
                ${rec.providerLatencyMs ?? null},
                ${rec.stream ? 1 : 0}, ${rec.isDirectRoute ? 1 : 0},
                ${rec.status ?? 'success'}, ${rec.errorMessage ?? null},
                ${rec.userMessagePreview ?? null}, ${rec.debugInput ?? null}, ${rec.debugOutput ?? null},
                ${rec.agentId ?? null}, ${rec.conversationId ?? null}, ${rec.retryCount ?? 0}
            )
        `;
    }

    /**
     * Get a cost summary for a time period.
     */
    async getSummary(since?: string): Promise<CostSummary> {
        type TotalsRow = { total_requests: string; total_cost: string; total_baseline_cost: string; total_savings: string; total_errors: string };
        type TierRow = { tier: string; count: string; cost: string };
        type ProviderRow = { provider: string; count: string; cost: string };

        let totalsRows: TotalsRow[];
        let byTierRows: TierRow[];
        let byProviderRows: ProviderRow[];

        if (since) {
            [totalsRows, byTierRows, byProviderRows] = await Promise.all([
                this.sql<TotalsRow[]>`
                    SELECT
                        COUNT(*)::text AS total_requests,
                        COALESCE(SUM(estimated_cost), 0)::text AS total_cost,
                        COALESCE(SUM(baseline_cost), 0)::text AS total_baseline_cost,
                        COALESCE(SUM(savings), 0)::text AS total_savings,
                        COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0)::text AS total_errors
                    FROM requests WHERE timestamp >= ${since}
                `,
                this.sql<TierRow[]>`
                    SELECT tier, COUNT(*)::text AS count, COALESCE(SUM(estimated_cost), 0)::text AS cost
                    FROM requests WHERE timestamp >= ${since}
                    GROUP BY tier
                `,
                this.sql<ProviderRow[]>`
                    SELECT provider, COUNT(*)::text AS count, COALESCE(SUM(estimated_cost), 0)::text AS cost
                    FROM requests WHERE timestamp >= ${since}
                    GROUP BY provider
                `,
            ]);
        } else {
            [totalsRows, byTierRows, byProviderRows] = await Promise.all([
                this.sql<TotalsRow[]>`
                    SELECT
                        COUNT(*)::text AS total_requests,
                        COALESCE(SUM(estimated_cost), 0)::text AS total_cost,
                        COALESCE(SUM(baseline_cost), 0)::text AS total_baseline_cost,
                        COALESCE(SUM(savings), 0)::text AS total_savings,
                        COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0)::text AS total_errors
                    FROM requests
                `,
                this.sql<TierRow[]>`
                    SELECT tier, COUNT(*)::text AS count, COALESCE(SUM(estimated_cost), 0)::text AS cost
                    FROM requests GROUP BY tier
                `,
                this.sql<ProviderRow[]>`
                    SELECT provider, COUNT(*)::text AS count, COALESCE(SUM(estimated_cost), 0)::text AS cost
                    FROM requests GROUP BY provider
                `,
            ]);
        }

        const t = totalsRows[0];
        const totalRequests = parseInt(t.total_requests, 10);
        const totalCost = parseFloat(t.total_cost);
        const totalBaselineCost = parseFloat(t.total_baseline_cost);
        const totalSavings = parseFloat(t.total_savings);
        const totalErrors = parseInt(t.total_errors, 10);

        return {
            totalRequests,
            totalCost,
            totalBaselineCost,
            totalSavings,
            savingsPercent: totalBaselineCost > 0 ? ((totalBaselineCost - totalCost) / totalBaselineCost) * 100 : 0,
            totalErrors,
            errorRate: totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0,
            byTier: Object.fromEntries(
                byTierRows.map(r => [r.tier, { count: parseInt(r.count, 10), cost: parseFloat(r.cost) }]),
            ),
            byProvider: Object.fromEntries(
                byProviderRows.map(r => [r.provider, { count: parseInt(r.count, 10), cost: parseFloat(r.cost) }]),
            ),
        };
    }

    /**
     * Get the most recent N requests.
     */
    async getRecent(limit: number = 25): Promise<Array<{
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
    }>> {
        const rows = await this.sql<Array<{
            timestamp: string;
            user_message_preview: string | null;
            classification_score: number;
            classification_type: string;
            tier: string;
            provider: string;
            model: string;
            tokens: string;
            estimated_cost: number;
            total_latency_ms: number;
            stream: number;
            classifier_provider: string | null;
            status: string | null;
            error_message: string | null;
        }>>`
            SELECT
                timestamp, user_message_preview, classification_score, classification_type,
                tier, provider, model, (tokens_in + tokens_out)::text AS tokens,
                estimated_cost, total_latency_ms, stream, classifier_provider,
                status, error_message
            FROM requests
            ORDER BY timestamp DESC
            LIMIT ${limit}
        `;

        return rows.map(r => ({
            timestamp: r.timestamp,
            preview: r.user_message_preview ?? null,
            score: r.classification_score,
            type: r.classification_type,
            tier: r.tier,
            provider: r.provider,
            model: r.model,
            tokens: parseInt(r.tokens, 10),
            cost: r.estimated_cost,
            latencyMs: r.total_latency_ms,
            stream: r.stream === 1,
            classifierProvider: r.classifier_provider ?? 'unknown',
            status: r.status ?? 'success',
            errorMessage: r.error_message ?? null,
        }));
    }

    /**
     * Get total spending for today (UTC).
     */
    async getDailySpend(): Promise<number> {
        const today = new Date().toISOString().slice(0, 10);
        const [row] = await this.sql<Array<{ total: string }>>`
            SELECT COALESCE(SUM(estimated_cost), 0)::text AS total
            FROM requests WHERE timestamp >= ${`${today}T00:00:00.000Z`}
        `;
        return parseFloat(row.total);
    }

    /**
     * Get total spending for the current month (UTC).
     */
    async getMonthlySpend(): Promise<number> {
        const monthStart = new Date().toISOString().slice(0, 7) + '-01';
        const [row] = await this.sql<Array<{ total: string }>>`
            SELECT COALESCE(SUM(estimated_cost), 0)::text AS total
            FROM requests WHERE timestamp >= ${`${monthStart}T00:00:00.000Z`}
        `;
        return parseFloat(row.total);
    }

    /**
     * Get per-agent cost summary.
     */
    async getAgentSummary(): Promise<Array<{ agentId: string; count: number; cost: number }>> {
        const rows = await this.sql<Array<{ agent_id: string; count: string; cost: string }>>`
            SELECT agent_id, COUNT(*)::text AS count, COALESCE(SUM(estimated_cost), 0)::text AS cost
            FROM requests
            WHERE agent_id IS NOT NULL
            GROUP BY agent_id
            ORDER BY cost DESC
        `;
        return rows.map(r => ({
            agentId: r.agent_id,
            count: parseInt(r.count, 10),
            cost: parseFloat(r.cost),
        }));
    }

    /**
     * Find a single request row by its tracking id. Returns null if not found.
     */
    async findByRequestId(requestId: string): Promise<RequestRecord | null> {
        const rows = await this.sql<Array<Record<string, unknown>>>`
            SELECT * FROM requests WHERE id = ${requestId}
        `;
        if (rows.length === 0) return null;
        const row = rows[0];
        return {
            id: row.id as string,
            timestamp: row.timestamp as string,
            tier: row.tier as string,
            provider: row.provider as string,
            model: row.model as string,
            classificationScore: row.classification_score as number,
            classificationType: row.classification_type as string,
            classificationLatencyMs: row.classification_latency_ms as number,
            classifierProvider: (row.classifier_provider as string | null) ?? 'unknown',
            tokensIn: row.tokens_in as number,
            tokensOut: row.tokens_out as number,
            estimatedCost: row.estimated_cost as number,
            baselineCost: row.baseline_cost as number,
            savings: row.savings as number,
            totalLatencyMs: row.total_latency_ms as number,
            stream: (row.stream as number) === 1,
            isDirectRoute: (row.is_direct_route as number) === 1,
            userMessagePreview: (row.user_message_preview as string | null) ?? undefined,
            status: (row.status as 'success' | 'error' | null) ?? 'success',
            errorMessage: (row.error_message as string | null) ?? undefined,
            debugInput: (row.debug_input as string | null) ?? undefined,
            debugOutput: (row.debug_output as string | null) ?? undefined,
            agentId: (row.agent_id as string | null) ?? undefined,
            conversationId: (row.conversation_id as string | null) ?? undefined,
            retryCount: (row.retry_count as number | null) ?? 0,
            providerLatencyMs: (row.provider_latency_ms as number | null) ?? undefined,
        };
    }

    /**
     * No-op — connection lifecycle owned by the postgres.js singleton.
     * Kept for API compat; callers that called close() continue to work.
     */
    close(): void {
        // Connection pool is managed externally — nothing to close here.
    }
}
