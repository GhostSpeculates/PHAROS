/**
 * Types for request tracking and cost calculation.
 */

export interface RequestRecord {
    id: string;
    timestamp: string;
    tier: string;
    provider: string;
    model: string;
    classificationScore: number;
    classificationType: string;
    classificationLatencyMs: number;
    classifierProvider: string;
    tokensIn: number;
    tokensOut: number;
    estimatedCost: number;
    baselineCost: number;
    savings: number;
    totalLatencyMs: number;
    stream: boolean;
    isDirectRoute: boolean;
    userMessagePreview?: string;
    status?: 'success' | 'error';
    errorMessage?: string;
    debugInput?: string;
    debugOutput?: string;
}

export interface CostSummary {
    totalRequests: number;
    totalCost: number;
    totalBaselineCost: number;
    totalSavings: number;
    savingsPercent: number;
    totalErrors: number;
    errorRate: number;
    byTier: Record<string, { count: number; cost: number }>;
    byProvider: Record<string, { count: number; cost: number }>;
    classifier?: {
        providerDistribution: Record<string, number>;
        cacheHits: number;
        cacheMisses: number;
        averageLatencyMs: number;
        rateLimits: number;
    };
}
