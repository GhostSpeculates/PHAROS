import { describe, it, expect } from 'vitest';
import { calculateCost, calculateBaselineCost } from '../tracking/cost-calculator.js';

// ────────────────────────────────────────────────────────────────
// calculateCost
// ────────────────────────────────────────────────────────────────
describe('calculateCost', () => {
    describe('known models', () => {
        it('gemini-2.5-flash is free (both input and output cost $0)', () => {
            const cost = calculateCost('google', 'gemini-2.5-flash', 1000, 1000);
            expect(cost).toBe(0);
        });

        it('gemini-2.5-flash is free even with large token counts', () => {
            const cost = calculateCost('google', 'gemini-2.5-flash', 1_000_000, 1_000_000);
            expect(cost).toBe(0);
        });

        it('claude-opus-4-20250514 is expensive ($15/$75 per million)', () => {
            // 1 million input + 1 million output
            const cost = calculateCost('anthropic', 'claude-opus-4-20250514', 1_000_000, 1_000_000);
            expect(cost).toBe(15.0 + 75.0); // $90 total
        });

        it('calculates deepseek-chat cost correctly', () => {
            // 1 million input ($0.14) + 1 million output ($0.28)
            const cost = calculateCost('deepseek', 'deepseek-chat', 1_000_000, 1_000_000);
            expect(cost).toBeCloseTo(0.14 + 0.28, 6);
        });

        it('calculates gpt-4o cost correctly', () => {
            // 500K input ($1.25) + 200K output ($2.00)
            const cost = calculateCost('openai', 'gpt-4o', 500_000, 200_000);
            expect(cost).toBeCloseTo(1.25 + 2.0, 6);
        });

        it('calculates claude-sonnet cost correctly', () => {
            // 100K input ($0.30) + 50K output ($0.75)
            const cost = calculateCost('anthropic', 'claude-sonnet-4-20250514', 100_000, 50_000);
            expect(cost).toBeCloseTo(0.30 + 0.75, 6);
        });

        it('calculates o3 cost correctly', () => {
            // 1M input ($10) + 1M output ($40)
            const cost = calculateCost('openai', 'o3', 1_000_000, 1_000_000);
            expect(cost).toBeCloseTo(10.0 + 40.0, 6);
        });

        // Together AI
        it('calculates Together Llama 3.3 70B cost correctly', () => {
            // 1M input ($0.88) + 1M output ($0.88)
            const cost = calculateCost('together', 'meta-llama/Llama-3.3-70B-Instruct-Turbo', 1_000_000, 1_000_000);
            expect(cost).toBeCloseTo(0.88 + 0.88, 6);
        });

        it('calculates Together DeepSeek V3 cost correctly', () => {
            // 1M input ($0.50) + 1M output ($0.90)
            const cost = calculateCost('together', 'deepseek-ai/DeepSeek-V3', 1_000_000, 1_000_000);
            expect(cost).toBeCloseTo(0.50 + 0.90, 6);
        });

        it('calculates Together Qwen 2.5 72B cost correctly', () => {
            // 1M input ($0.60) + 1M output ($0.60)
            const cost = calculateCost('together', 'Qwen/Qwen2.5-72B-Instruct-Turbo', 1_000_000, 1_000_000);
            expect(cost).toBeCloseTo(0.60 + 0.60, 6);
        });

        // Fireworks AI
        it('calculates Fireworks Llama 3.3 70B cost correctly', () => {
            // 1M input ($0.90) + 1M output ($0.90)
            const cost = calculateCost('fireworks', 'accounts/fireworks/models/llama-v3p3-70b-instruct', 1_000_000, 1_000_000);
            expect(cost).toBeCloseTo(0.90 + 0.90, 6);
        });

        it('calculates Fireworks DeepSeek V3 cost correctly', () => {
            // 1M input ($0.50) + 1M output ($1.40)
            const cost = calculateCost('fireworks', 'accounts/fireworks/models/deepseek-v3', 1_000_000, 1_000_000);
            expect(cost).toBeCloseTo(0.50 + 1.40, 6);
        });
    });

    describe('zero tokens', () => {
        it('returns 0 for zero input and output tokens', () => {
            const cost = calculateCost('anthropic', 'claude-opus-4-20250514', 0, 0);
            expect(cost).toBe(0);
        });

        it('returns correct cost with zero input tokens', () => {
            const cost = calculateCost('anthropic', 'claude-opus-4-20250514', 0, 1_000_000);
            expect(cost).toBe(75.0);
        });

        it('returns correct cost with zero output tokens', () => {
            const cost = calculateCost('anthropic', 'claude-opus-4-20250514', 1_000_000, 0);
            expect(cost).toBe(15.0);
        });
    });

    describe('unknown model fallback', () => {
        it('uses fallback pricing ($1/$3 per million) for unknown models', () => {
            // Unknown model: 1M input ($1) + 1M output ($3) = $4
            const cost = calculateCost('unknown-provider', 'unknown-model', 1_000_000, 1_000_000);
            expect(cost).toBeCloseTo(1.0 + 3.0, 6);
        });

        it('unknown model with small token count returns proportional cost', () => {
            // 1000 input tokens at $1/M = $0.001, 1000 output at $3/M = $0.003
            const cost = calculateCost('foo', 'bar', 1000, 1000);
            expect(cost).toBeCloseTo(0.001 + 0.003, 6);
        });

        it('unknown model with zero tokens returns 0', () => {
            const cost = calculateCost('nonexistent', 'model-x', 0, 0);
            expect(cost).toBe(0);
        });
    });

    describe('proportional scaling', () => {
        it('cost scales linearly with token count', () => {
            const cost1 = calculateCost('openai', 'gpt-4o', 100_000, 100_000);
            const cost2 = calculateCost('openai', 'gpt-4o', 200_000, 200_000);
            expect(cost2).toBeCloseTo(cost1 * 2, 6);
        });
    });
});

// ────────────────────────────────────────────────────────────────
// calculateBaselineCost
// ────────────────────────────────────────────────────────────────
describe('calculateBaselineCost', () => {
    it('calculates baseline cost with Claude Sonnet pricing', () => {
        // Default baseline: $3/M input, $15/M output
        const baseline = calculateBaselineCost(1_000_000, 1_000_000, 3.0, 15.0);
        expect(baseline).toBe(3.0 + 15.0);
    });

    it('returns 0 with zero tokens', () => {
        const baseline = calculateBaselineCost(0, 0, 3.0, 15.0);
        expect(baseline).toBe(0);
    });

    it('works with custom baseline pricing', () => {
        // Using GPT-4o pricing as baseline: $2.5/M input, $10/M output
        const baseline = calculateBaselineCost(500_000, 200_000, 2.5, 10.0);
        expect(baseline).toBeCloseTo(1.25 + 2.0, 6);
    });

    describe('savings calculation', () => {
        it('free tier shows significant savings vs baseline', () => {
            const tokensIn = 100_000;
            const tokensOut = 50_000;

            const actual = calculateCost('google', 'gemini-2.5-flash', tokensIn, tokensOut);
            const baseline = calculateBaselineCost(tokensIn, tokensOut, 3.0, 15.0);

            expect(actual).toBe(0);
            expect(baseline).toBeGreaterThan(0);
            const savingsPercent = ((baseline - actual) / baseline) * 100;
            expect(savingsPercent).toBe(100); // 100% savings with free model
        });

        it('economical tier shows savings vs premium baseline', () => {
            const tokensIn = 100_000;
            const tokensOut = 50_000;

            const actual = calculateCost('deepseek', 'deepseek-chat', tokensIn, tokensOut);
            const baseline = calculateBaselineCost(tokensIn, tokensOut, 3.0, 15.0);

            expect(actual).toBeLessThan(baseline);
            const savingsPercent = ((baseline - actual) / baseline) * 100;
            expect(savingsPercent).toBeGreaterThan(90); // DeepSeek should save >90%
        });

        it('frontier tier costs more than sonnet baseline', () => {
            const tokensIn = 100_000;
            const tokensOut = 50_000;

            const actual = calculateCost('anthropic', 'claude-opus-4-20250514', tokensIn, tokensOut);
            const baseline = calculateBaselineCost(tokensIn, tokensOut, 3.0, 15.0);

            expect(actual).toBeGreaterThan(baseline);
        });
    });
});
