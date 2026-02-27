import { describe, it, expect } from 'vitest';
import { applyAgentProfile } from '../router/agent-profile.js';
import type { PharosConfig } from '../config/schema.js';

// ─── Helpers ─────────────────────────────────────────────

function makeConfig(agents: Record<string, any> = {}): PharosConfig {
    return {
        server: { port: 3777, host: '127.0.0.1' },
        auth: { apiKey: '' },
        classifier: {
            providers: [],
            fallbackTier: 'economical',
            timeoutMs: 5000,
        },
        tiers: {
            free: { scoreRange: [1, 3], models: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }] },
            economical: { scoreRange: [4, 6], models: [{ provider: 'deepseek', model: 'deepseek-chat' }] },
            premium: { scoreRange: [7, 8], models: [{ provider: 'anthropic', model: 'claude-sonnet-4-20250514' }] },
            frontier: { scoreRange: [9, 10], models: [{ provider: 'anthropic', model: 'claude-opus-4-20250514' }] },
        },
        providers: {},
        agents,
        tracking: {
            enabled: true,
            dbPath: ':memory:',
            baselineModel: 'claude-sonnet-4-20250514',
            baselineCostPerMillionInput: 3.0,
            baselineCostPerMillionOutput: 15.0,
        },
        logging: { level: 'info', pretty: true },
    } as PharosConfig;
}

// ─── Tests ───────────────────────────────────────────────

describe('applyAgentProfile', () => {
    describe('no profile (passthrough)', () => {
        it('returns raw score when no agentId provided', () => {
            const config = makeConfig({ worker: { scoreCeiling: 5 } });
            const result = applyAgentProfile(8, undefined, config);
            expect(result.adjustedScore).toBe(8);
            expect(result.rawScore).toBe(8);
            expect(result.agentId).toBeUndefined();
        });

        it('returns raw score when agentId not in config', () => {
            const config = makeConfig({});
            const result = applyAgentProfile(8, 'unknown-agent', config);
            expect(result.adjustedScore).toBe(8);
        });

        it('returns raw score when agents config is empty', () => {
            const config = makeConfig({});
            const result = applyAgentProfile(5, 'worker', config);
            expect(result.adjustedScore).toBe(5);
        });

        it('uses _default profile for unknown agents when _default exists', () => {
            const config = makeConfig({ _default: { scoreCeiling: 7 } });
            const result = applyAgentProfile(9, 'unknown-agent', config);
            expect(result.adjustedScore).toBe(7);
        });
    });

    describe('scoreFloor', () => {
        it('bumps score to floor when below', () => {
            const config = makeConfig({ 'noir-prime': { scoreFloor: 7 } });
            const result = applyAgentProfile(2, 'noir-prime', config);
            expect(result.adjustedScore).toBe(7);
            expect(result.rawScore).toBe(2);
        });

        it('does not change score when already above floor', () => {
            const config = makeConfig({ 'noir-prime': { scoreFloor: 7 } });
            const result = applyAgentProfile(9, 'noir-prime', config);
            expect(result.adjustedScore).toBe(9);
        });

        it('does not change score when exactly at floor', () => {
            const config = makeConfig({ trading: { scoreFloor: 5 } });
            const result = applyAgentProfile(5, 'trading', config);
            expect(result.adjustedScore).toBe(5);
        });
    });

    describe('scoreCeiling', () => {
        it('caps score to ceiling when above', () => {
            const config = makeConfig({ worker: { scoreCeiling: 5 } });
            const result = applyAgentProfile(8, 'worker', config);
            expect(result.adjustedScore).toBe(5);
            expect(result.rawScore).toBe(8);
        });

        it('does not change score when below ceiling', () => {
            const config = makeConfig({ worker: { scoreCeiling: 5 } });
            const result = applyAgentProfile(3, 'worker', config);
            expect(result.adjustedScore).toBe(3);
        });

        it('does not change score when exactly at ceiling', () => {
            const config = makeConfig({ main: { scoreCeiling: 6 } });
            const result = applyAgentProfile(6, 'main', config);
            expect(result.adjustedScore).toBe(6);
        });
    });

    describe('combined floor + ceiling', () => {
        it('clamps score within range', () => {
            const config = makeConfig({ research: { scoreFloor: 4, scoreCeiling: 8 } });

            const low = applyAgentProfile(2, 'research', config);
            expect(low.adjustedScore).toBe(4);

            const mid = applyAgentProfile(6, 'research', config);
            expect(mid.adjustedScore).toBe(6);

            const high = applyAgentProfile(10, 'research', config);
            expect(high.adjustedScore).toBe(8);
        });
    });

    describe('minTier enforcement', () => {
        it('bumps score to reach minimum tier', () => {
            const config = makeConfig({ 'noir-prime': { minTier: 'premium' } });
            const result = applyAgentProfile(2, 'noir-prime', config);
            // Premium tier starts at 7
            expect(result.adjustedScore).toBe(7);
        });

        it('does not change score when already in higher tier', () => {
            const config = makeConfig({ trading: { minTier: 'economical' } });
            const result = applyAgentProfile(8, 'trading', config);
            expect(result.adjustedScore).toBe(8);
        });

        it('does not change score when already in required tier', () => {
            const config = makeConfig({ trading: { minTier: 'economical' } });
            const result = applyAgentProfile(5, 'trading', config);
            expect(result.adjustedScore).toBe(5);
        });
    });

    describe('maxTier enforcement', () => {
        it('caps score to stay within max tier', () => {
            const config = makeConfig({ worker: { maxTier: 'economical' } });
            const result = applyAgentProfile(8, 'worker', config);
            // Economical tier ends at 6
            expect(result.adjustedScore).toBe(6);
            expect(result.maxTier).toBe('economical');
        });

        it('does not change score when already in lower tier', () => {
            const config = makeConfig({ worker: { maxTier: 'economical' } });
            const result = applyAgentProfile(2, 'worker', config);
            expect(result.adjustedScore).toBe(2);
        });

        it('caps to free tier correctly', () => {
            const config = makeConfig({ 'worker-sub': { maxTier: 'free' } });
            const result = applyAgentProfile(8, 'worker-sub', config);
            // Free tier ends at 3
            expect(result.adjustedScore).toBe(3);
        });
    });

    describe('combined constraints', () => {
        it('applies floor then ceiling correctly', () => {
            const config = makeConfig({
                research: { scoreFloor: 4, scoreCeiling: 8 },
            });
            const result = applyAgentProfile(1, 'research', config);
            expect(result.adjustedScore).toBe(4);
        });

        it('applies scoreCeiling with maxTier', () => {
            const config = makeConfig({
                worker: { scoreCeiling: 5, maxTier: 'economical' },
            });

            // Score ceiling is 5, maxTier economical ends at 6
            // scoreCeiling of 5 is already within economical, so ceiling takes effect
            const result = applyAgentProfile(9, 'worker', config);
            expect(result.adjustedScore).toBe(5);
        });

        it('applies scoreFloor with minTier where floor is higher', () => {
            const config = makeConfig({
                'noir-prime': { scoreFloor: 7, minTier: 'premium' },
            });
            // scoreFloor 7, minTier premium starts at 7 — floor already handles it
            const result = applyAgentProfile(2, 'noir-prime', config);
            expect(result.adjustedScore).toBe(7);
        });

        it('minTier bumps score higher than scoreFloor when needed', () => {
            const config = makeConfig({
                agent: { scoreFloor: 3, minTier: 'premium' },
            });
            // scoreFloor=3, but minTier=premium needs at least 7
            const result = applyAgentProfile(1, 'agent', config);
            expect(result.adjustedScore).toBe(7);
        });
    });

    describe('real-world scenarios — classifier-first philosophy', () => {
        // Only worker has cost guards. All other agents trust the classifier.
        const config = makeConfig({
            'noir-prime': { description: 'Executive orchestrator' },
            trading: { description: 'CME futures analyst' },
            worker: { maxTier: 'economical', scoreCeiling: 6 },
        });

        it('noir-prime trivial message → classifier decides (passthrough)', () => {
            const r = applyAgentProfile(2, 'noir-prime', config);
            expect(r.adjustedScore).toBe(2); // classifier decision respected
        });

        it('noir-prime complex message → classifier decides (passthrough)', () => {
            const r = applyAgentProfile(8, 'noir-prime', config);
            expect(r.adjustedScore).toBe(8); // classifier decision respected
        });

        it('trading message → classifier decides (passthrough)', () => {
            const r = applyAgentProfile(5, 'trading', config);
            expect(r.adjustedScore).toBe(5); // classifier decision respected
        });

        it('worker trivial message → free (passthrough)', () => {
            const r = applyAgentProfile(2, 'worker', config);
            expect(r.adjustedScore).toBe(2); // cheap, no cap needed
        });

        it('worker complex message → economical (cost guard)', () => {
            const r = applyAgentProfile(8, 'worker', config);
            expect(r.adjustedScore).toBe(6); // ceiling 6, saves money
        });

        it('worker frontier message → economical (cost guard)', () => {
            const r = applyAgentProfile(10, 'worker', config);
            expect(r.adjustedScore).toBe(6); // ceiling 6, saves money
        });

        it('unknown agent → full passthrough', () => {
            const r = applyAgentProfile(9, 'unknown', config);
            expect(r.adjustedScore).toBe(9); // no profile, no adjustment
        });
    });

    describe('metadata', () => {
        it('preserves agentId in result', () => {
            const config = makeConfig({ worker: { scoreCeiling: 5 } });
            const result = applyAgentProfile(8, 'worker', config);
            expect(result.agentId).toBe('worker');
        });

        it('returns maxTier when set', () => {
            const config = makeConfig({ worker: { maxTier: 'economical' } });
            const result = applyAgentProfile(8, 'worker', config);
            expect(result.maxTier).toBe('economical');
        });

        it('returns undefined maxTier when not set', () => {
            const config = makeConfig({ trading: { scoreFloor: 5 } });
            const result = applyAgentProfile(3, 'trading', config);
            expect(result.maxTier).toBeUndefined();
        });
    });
});
