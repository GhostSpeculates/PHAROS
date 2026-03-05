/**
 * Phase 2 in-memory metrics — tracks activation rates for Phase 2 features.
 * Resets on restart (operational counters, not historical data).
 */

export interface Phase2Summary {
    promptEnhancement: {
        activationRate: number;
        totalActivated: number;
        totalRequests: number;
        byTaskType: Record<string, number>;
    };
    performanceLearning: {
        enabled: boolean;
        modelsTracked: number;
        topPerformers: Array<{
            provider: string;
            model: string;
            taskType: string;
            weight: number;
            successRate: number;
        }>;
        worstPerformers: Array<{
            provider: string;
            model: string;
            taskType: string;
            weight: number;
            successRate: number;
        }>;
    };
    agentProfiles: {
        activeAgents: number;
        adjustmentRate: number;
        totalAdjusted: number;
        totalRequests: number;
    };
    conversationFloor: {
        applicationRate: number;
        totalApplied: number;
        totalRequests: number;
    };
}

export class Phase2Metrics {
    // Prompt enhancement
    private promptEnhancedCount = 0;
    private promptTotalCount = 0;
    private promptByTaskType = new Map<string, number>();

    // Agent profiles
    private agentAdjustedCount = 0;
    private agentTotalCount = 0;
    private activeAgents = new Set<string>();

    // Conversation floor
    private conversationFloorApplied = 0;
    private conversationFloorTotal = 0;

    recordPromptEnhancement(activated: boolean, taskType: string): void {
        this.promptTotalCount++;
        if (activated) {
            this.promptEnhancedCount++;
            this.promptByTaskType.set(
                taskType,
                (this.promptByTaskType.get(taskType) ?? 0) + 1,
            );
        }
    }

    recordAgentAdjustment(agentId: string, adjusted: boolean): void {
        this.agentTotalCount++;
        this.activeAgents.add(agentId);
        if (adjusted) {
            this.agentAdjustedCount++;
        }
    }

    recordConversationFloor(applied: boolean): void {
        this.conversationFloorTotal++;
        if (applied) {
            this.conversationFloorApplied++;
        }
    }

    getSummary(learningEnabled: boolean, modelsTracked: number, topPerformers: Phase2Summary['performanceLearning']['topPerformers'], worstPerformers: Phase2Summary['performanceLearning']['worstPerformers']): Phase2Summary {
        return {
            promptEnhancement: {
                activationRate: this.promptTotalCount > 0
                    ? this.promptEnhancedCount / this.promptTotalCount
                    : 0,
                totalActivated: this.promptEnhancedCount,
                totalRequests: this.promptTotalCount,
                byTaskType: Object.fromEntries(this.promptByTaskType),
            },
            performanceLearning: {
                enabled: learningEnabled,
                modelsTracked,
                topPerformers,
                worstPerformers,
            },
            agentProfiles: {
                activeAgents: this.activeAgents.size,
                adjustmentRate: this.agentTotalCount > 0
                    ? this.agentAdjustedCount / this.agentTotalCount
                    : 0,
                totalAdjusted: this.agentAdjustedCount,
                totalRequests: this.agentTotalCount,
            },
            conversationFloor: {
                applicationRate: this.conversationFloorTotal > 0
                    ? this.conversationFloorApplied / this.conversationFloorTotal
                    : 0,
                totalApplied: this.conversationFloorApplied,
                totalRequests: this.conversationFloorTotal,
            },
        };
    }
}
