import { describe, it, expect, beforeEach } from 'vitest';
import { Phase2Metrics } from '../tracking/phase2-metrics.js';

describe('Phase2Metrics', () => {
    let metrics: Phase2Metrics;

    beforeEach(() => {
        metrics = new Phase2Metrics();
    });

    // ─── Prompt Enhancement ───

    describe('prompt enhancement tracking', () => {
        it('starts with zero counts', () => {
            const s = metrics.getSummary(false, 0, [], []);
            expect(s.promptEnhancement.activationRate).toBe(0);
            expect(s.promptEnhancement.totalActivated).toBe(0);
            expect(s.promptEnhancement.totalRequests).toBe(0);
        });

        it('records activated enhancement', () => {
            metrics.recordPromptEnhancement(true, 'code');
            const s = metrics.getSummary(false, 0, [], []);
            expect(s.promptEnhancement.totalActivated).toBe(1);
            expect(s.promptEnhancement.totalRequests).toBe(1);
            expect(s.promptEnhancement.activationRate).toBe(1.0);
        });

        it('records non-activated enhancement', () => {
            metrics.recordPromptEnhancement(false, 'code');
            const s = metrics.getSummary(false, 0, [], []);
            expect(s.promptEnhancement.totalActivated).toBe(0);
            expect(s.promptEnhancement.totalRequests).toBe(1);
            expect(s.promptEnhancement.activationRate).toBe(0);
        });

        it('calculates correct activation rate', () => {
            metrics.recordPromptEnhancement(true, 'code');
            metrics.recordPromptEnhancement(true, 'math');
            metrics.recordPromptEnhancement(false, 'reasoning');
            metrics.recordPromptEnhancement(false, 'creative');
            const s = metrics.getSummary(false, 0, [], []);
            expect(s.promptEnhancement.activationRate).toBe(0.5);
        });

        it('tracks by task type', () => {
            metrics.recordPromptEnhancement(true, 'code');
            metrics.recordPromptEnhancement(true, 'code');
            metrics.recordPromptEnhancement(true, 'math');
            const s = metrics.getSummary(false, 0, [], []);
            expect(s.promptEnhancement.byTaskType).toEqual({ code: 2, math: 1 });
        });

        it('does not count non-activated in byTaskType', () => {
            metrics.recordPromptEnhancement(false, 'code');
            const s = metrics.getSummary(false, 0, [], []);
            expect(s.promptEnhancement.byTaskType).toEqual({});
        });
    });

    // ─── Agent Profiles ───

    describe('agent profile tracking', () => {
        it('starts with zero counts', () => {
            const s = metrics.getSummary(false, 0, [], []);
            expect(s.agentProfiles.activeAgents).toBe(0);
            expect(s.agentProfiles.adjustmentRate).toBe(0);
        });

        it('records adjusted agent', () => {
            metrics.recordAgentAdjustment('noir', true);
            const s = metrics.getSummary(false, 0, [], []);
            expect(s.agentProfiles.totalAdjusted).toBe(1);
            expect(s.agentProfiles.totalRequests).toBe(1);
            expect(s.agentProfiles.activeAgents).toBe(1);
        });

        it('records non-adjusted agent', () => {
            metrics.recordAgentAdjustment('essence', false);
            const s = metrics.getSummary(false, 0, [], []);
            expect(s.agentProfiles.totalAdjusted).toBe(0);
            expect(s.agentProfiles.totalRequests).toBe(1);
            expect(s.agentProfiles.activeAgents).toBe(1);
        });

        it('deduplicates active agents', () => {
            metrics.recordAgentAdjustment('noir', true);
            metrics.recordAgentAdjustment('noir', false);
            metrics.recordAgentAdjustment('essence', false);
            const s = metrics.getSummary(false, 0, [], []);
            expect(s.agentProfiles.activeAgents).toBe(2);
            expect(s.agentProfiles.totalRequests).toBe(3);
        });

        it('calculates adjustment rate', () => {
            metrics.recordAgentAdjustment('noir', true);
            metrics.recordAgentAdjustment('noir', true);
            metrics.recordAgentAdjustment('essence', false);
            metrics.recordAgentAdjustment('nexus', false);
            const s = metrics.getSummary(false, 0, [], []);
            expect(s.agentProfiles.adjustmentRate).toBe(0.5);
        });
    });

    // ─── Conversation Floor ───

    describe('conversation floor tracking', () => {
        it('starts with zero counts', () => {
            const s = metrics.getSummary(false, 0, [], []);
            expect(s.conversationFloor.applicationRate).toBe(0);
        });

        it('records applied floor', () => {
            metrics.recordConversationFloor(true);
            const s = metrics.getSummary(false, 0, [], []);
            expect(s.conversationFloor.totalApplied).toBe(1);
            expect(s.conversationFloor.totalRequests).toBe(1);
            expect(s.conversationFloor.applicationRate).toBe(1.0);
        });

        it('records non-applied floor', () => {
            metrics.recordConversationFloor(false);
            const s = metrics.getSummary(false, 0, [], []);
            expect(s.conversationFloor.totalApplied).toBe(0);
            expect(s.conversationFloor.totalRequests).toBe(1);
        });

        it('calculates application rate', () => {
            metrics.recordConversationFloor(true);
            metrics.recordConversationFloor(false);
            metrics.recordConversationFloor(false);
            metrics.recordConversationFloor(true);
            const s = metrics.getSummary(false, 0, [], []);
            expect(s.conversationFloor.applicationRate).toBe(0.5);
        });
    });

    // ─── Performance Learning summary ───

    describe('performance learning in summary', () => {
        it('passes through learning store data', () => {
            const topPerformers = [
                { provider: 'groq', model: 'llama', taskType: 'code', weight: 1.6, successRate: 0.95 },
            ];
            const worstPerformers = [
                { provider: 'openai', model: 'gpt-4o', taskType: 'math', weight: 0.5, successRate: 0.3 },
            ];

            const s = metrics.getSummary(true, 12, topPerformers, worstPerformers);
            expect(s.performanceLearning.enabled).toBe(true);
            expect(s.performanceLearning.modelsTracked).toBe(12);
            expect(s.performanceLearning.topPerformers).toEqual(topPerformers);
            expect(s.performanceLearning.worstPerformers).toEqual(worstPerformers);
        });

        it('reports disabled when store is not present', () => {
            const s = metrics.getSummary(false, 0, [], []);
            expect(s.performanceLearning.enabled).toBe(false);
            expect(s.performanceLearning.modelsTracked).toBe(0);
        });
    });

    // ─── Combined scenarios ───

    describe('combined scenarios', () => {
        it('tracks all features simultaneously', () => {
            metrics.recordPromptEnhancement(true, 'code');
            metrics.recordPromptEnhancement(false, 'reasoning');
            metrics.recordAgentAdjustment('noir', true);
            metrics.recordAgentAdjustment('essence', false);
            metrics.recordConversationFloor(true);
            metrics.recordConversationFloor(false);

            const s = metrics.getSummary(true, 5, [], []);

            expect(s.promptEnhancement.activationRate).toBe(0.5);
            expect(s.agentProfiles.activeAgents).toBe(2);
            expect(s.agentProfiles.adjustmentRate).toBe(0.5);
            expect(s.conversationFloor.applicationRate).toBe(0.5);
            expect(s.performanceLearning.enabled).toBe(true);
            expect(s.performanceLearning.modelsTracked).toBe(5);
        });

        it('handles many records without errors', () => {
            for (let i = 0; i < 1000; i++) {
                metrics.recordPromptEnhancement(i % 3 === 0, 'code');
                metrics.recordAgentAdjustment(`agent-${i % 5}`, i % 2 === 0);
                metrics.recordConversationFloor(i % 4 === 0);
            }
            const s = metrics.getSummary(true, 100, [], []);
            expect(s.promptEnhancement.totalRequests).toBe(1000);
            expect(s.agentProfiles.totalRequests).toBe(1000);
            expect(s.agentProfiles.activeAgents).toBe(5);
            expect(s.conversationFloor.totalRequests).toBe(1000);
        });

        it('independent instances do not share state', () => {
            const m1 = new Phase2Metrics();
            const m2 = new Phase2Metrics();

            m1.recordPromptEnhancement(true, 'code');
            const s2 = m2.getSummary(false, 0, [], []);
            expect(s2.promptEnhancement.totalRequests).toBe(0);
        });
    });
});
