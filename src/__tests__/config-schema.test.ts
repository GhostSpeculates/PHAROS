import { describe, it, expect } from 'vitest';
import {
    PharosConfigSchema,
    TierSchema,
    ModelEntrySchema,
    ProviderConfigSchema,
    ClassifierConfigSchema,
    ClassifierProviderEntrySchema,
    TrackingConfigSchema,
    ServerConfigSchema,
    AuthConfigSchema,
    LoggingConfigSchema,
    SpendingConfigSchema,
} from '../config/schema.js';

// ────────────────────────────────────────────────────────────────
// PharosConfigSchema — valid configs
// ────────────────────────────────────────────────────────────────
describe('PharosConfigSchema', () => {
    describe('valid configurations', () => {
        it('accepts a minimal empty object (all defaults)', () => {
            const result = PharosConfigSchema.safeParse({});
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.server.port).toBe(3777);
                expect(result.data.server.host).toBe('0.0.0.0');
                expect(result.data.auth.apiKey).toBe('');
                expect(result.data.classifier.providers).toEqual([
                    { provider: 'google', model: 'gemini-2.5-flash' },
                ]);
                expect(result.data.tracking.enabled).toBe(true);
                expect(result.data.logging.level).toBe('info');
            }
        });

        it('accepts a fully specified config', () => {
            const fullConfig = {
                server: { port: 8080, host: 'localhost' },
                auth: { apiKey: 'my-secret-key' },
                classifier: {
                    provider: 'openai',
                    model: 'gpt-4o-mini',
                    fallbackTier: 'premium',
                    timeoutMs: 3000,
                },
                tiers: {
                    free: { scoreRange: [1, 3], models: [{ provider: 'google', model: 'gemini-2.5-flash' }] },
                    economical: { scoreRange: [4, 6], models: [{ provider: 'deepseek', model: 'deepseek-chat' }] },
                    premium: { scoreRange: [7, 8], models: [{ provider: 'anthropic', model: 'claude-sonnet-4-20250514' }] },
                    frontier: { scoreRange: [9, 10], models: [{ provider: 'anthropic', model: 'claude-opus-4-20250514' }] },
                },
                providers: {
                    google: { apiKeyEnv: 'GOOGLE_API_KEY' },
                    anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY', baseUrl: 'https://api.anthropic.com' },
                },
                tracking: {
                    enabled: false,
                    dbPath: '/tmp/pharos.db',
                    baselineModel: 'gpt-4o',
                    baselineCostPerMillionInput: 2.5,
                    baselineCostPerMillionOutput: 10.0,
                },
                logging: { level: 'debug', pretty: false },
            };

            const result = PharosConfigSchema.safeParse(fullConfig);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.server.port).toBe(8080);
                expect(result.data.auth.apiKey).toBe('my-secret-key');
                expect(result.data.classifier.fallbackTier).toBe('premium');
                expect(result.data.tracking.enabled).toBe(false);
            }
        });

        it('applies defaults for partially specified config', () => {
            const partial = {
                server: { port: 4000 },
            };
            const result = PharosConfigSchema.safeParse(partial);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.server.port).toBe(4000);
                expect(result.data.server.host).toBe('0.0.0.0'); // default
                expect(result.data.auth.apiKey).toBe(''); // default
            }
        });
    });

    describe('invalid configurations', () => {
        it('rejects non-object input', () => {
            expect(PharosConfigSchema.safeParse('not an object').success).toBe(false);
            expect(PharosConfigSchema.safeParse(42).success).toBe(false);
            expect(PharosConfigSchema.safeParse(null).success).toBe(false);
        });

        it('rejects invalid server port (negative)', () => {
            const result = PharosConfigSchema.safeParse({
                server: { port: -1 },
            });
            expect(result.success).toBe(false);
        });

        it('rejects invalid server port (zero)', () => {
            const result = PharosConfigSchema.safeParse({
                server: { port: 0 },
            });
            expect(result.success).toBe(false);
        });

        it('rejects invalid server port (float)', () => {
            const result = PharosConfigSchema.safeParse({
                server: { port: 3.14 },
            });
            expect(result.success).toBe(false);
        });

        it('rejects invalid classifier fallbackTier', () => {
            const result = PharosConfigSchema.safeParse({
                classifier: { fallbackTier: 'mega-tier' },
            });
            expect(result.success).toBe(false);
        });

        it('rejects negative classifier timeout', () => {
            const result = PharosConfigSchema.safeParse({
                classifier: { timeoutMs: -100 },
            });
            expect(result.success).toBe(false);
        });
    });
});

// ────────────────────────────────────────────────────────────────
// TierSchema
// ────────────────────────────────────────────────────────────────
describe('TierSchema', () => {
    it('accepts valid tier config', () => {
        const result = TierSchema.safeParse({
            scoreRange: [1, 3],
            models: [{ provider: 'google', model: 'gemini-2.5-flash' }],
        });
        expect(result.success).toBe(true);
    });

    it('accepts tier with multiple models', () => {
        const result = TierSchema.safeParse({
            scoreRange: [4, 6],
            models: [
                { provider: 'deepseek', model: 'deepseek-chat' },
                { provider: 'mistral', model: 'mistral-large-latest' },
            ],
        });
        expect(result.success).toBe(true);
    });

    it('rejects tier with empty models array', () => {
        const result = TierSchema.safeParse({
            scoreRange: [1, 3],
            models: [],
        });
        expect(result.success).toBe(false);
    });

    it('rejects tier with missing scoreRange', () => {
        const result = TierSchema.safeParse({
            models: [{ provider: 'google', model: 'gemini-2.5-flash' }],
        });
        expect(result.success).toBe(false);
    });

    it('rejects tier with missing models', () => {
        const result = TierSchema.safeParse({
            scoreRange: [1, 3],
        });
        expect(result.success).toBe(false);
    });

    describe('scoreRange validation', () => {
        it('accepts scoreRange [1, 10] (full range)', () => {
            const result = TierSchema.safeParse({
                scoreRange: [1, 10],
                models: [{ provider: 'google', model: 'gemini-2.5-flash' }],
            });
            expect(result.success).toBe(true);
        });

        it('accepts scoreRange [5, 5] (single score)', () => {
            const result = TierSchema.safeParse({
                scoreRange: [5, 5],
                models: [{ provider: 'google', model: 'gemini-2.5-flash' }],
            });
            expect(result.success).toBe(true);
        });

        it('rejects scoreRange with min < 1', () => {
            const result = TierSchema.safeParse({
                scoreRange: [0, 3],
                models: [{ provider: 'google', model: 'gemini-2.5-flash' }],
            });
            expect(result.success).toBe(false);
        });

        it('rejects scoreRange with max > 10', () => {
            const result = TierSchema.safeParse({
                scoreRange: [1, 11],
                models: [{ provider: 'google', model: 'gemini-2.5-flash' }],
            });
            expect(result.success).toBe(false);
        });

        it('rejects scoreRange with non-tuple (single element)', () => {
            const result = TierSchema.safeParse({
                scoreRange: [5],
                models: [{ provider: 'google', model: 'gemini-2.5-flash' }],
            });
            expect(result.success).toBe(false);
        });

        it('rejects scoreRange with non-tuple (three elements)', () => {
            const result = TierSchema.safeParse({
                scoreRange: [1, 5, 10],
                models: [{ provider: 'google', model: 'gemini-2.5-flash' }],
            });
            expect(result.success).toBe(false);
        });
    });
});

// ────────────────────────────────────────────────────────────────
// ModelEntrySchema
// ────────────────────────────────────────────────────────────────
describe('ModelEntrySchema', () => {
    it('accepts valid model entry', () => {
        const result = ModelEntrySchema.safeParse({ provider: 'google', model: 'gemini-2.5-flash' });
        expect(result.success).toBe(true);
    });

    it('rejects missing provider', () => {
        const result = ModelEntrySchema.safeParse({ model: 'gemini-2.5-flash' });
        expect(result.success).toBe(false);
    });

    it('rejects missing model', () => {
        const result = ModelEntrySchema.safeParse({ provider: 'google' });
        expect(result.success).toBe(false);
    });

    it('rejects non-string provider', () => {
        const result = ModelEntrySchema.safeParse({ provider: 123, model: 'gemini-2.5-flash' });
        expect(result.success).toBe(false);
    });

    it('rejects non-string model', () => {
        const result = ModelEntrySchema.safeParse({ provider: 'google', model: true });
        expect(result.success).toBe(false);
    });
});

// ────────────────────────────────────────────────────────────────
// ProviderConfigSchema
// ────────────────────────────────────────────────────────────────
describe('ProviderConfigSchema', () => {
    it('accepts config with just apiKeyEnv', () => {
        const result = ProviderConfigSchema.safeParse({ apiKeyEnv: 'GOOGLE_API_KEY' });
        expect(result.success).toBe(true);
    });

    it('accepts config with apiKeyEnv and valid baseUrl', () => {
        const result = ProviderConfigSchema.safeParse({
            apiKeyEnv: 'OPENAI_API_KEY',
            baseUrl: 'https://api.openai.com/v1',
        });
        expect(result.success).toBe(true);
    });

    it('rejects config with invalid baseUrl', () => {
        const result = ProviderConfigSchema.safeParse({
            apiKeyEnv: 'MY_KEY',
            baseUrl: 'not-a-url',
        });
        expect(result.success).toBe(false);
    });

    it('rejects config without apiKeyEnv', () => {
        const result = ProviderConfigSchema.safeParse({});
        expect(result.success).toBe(false);
    });
});

// ────────────────────────────────────────────────────────────────
// ClassifierConfigSchema
// ────────────────────────────────────────────────────────────────
describe('ClassifierConfigSchema', () => {
    it('applies defaults when given empty object (creates default providers array)', () => {
        const result = ClassifierConfigSchema.safeParse({});
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.providers).toEqual([
                { provider: 'google', model: 'gemini-2.5-flash' },
            ]);
            expect(result.data.fallbackTier).toBe('economical');
            expect(result.data.timeoutMs).toBe(3000);
            expect(result.data.maxConcurrent).toBe(5);
            expect(result.data.cacheMaxSize).toBe(100);
            expect(result.data.cacheTtlMs).toBe(30000);
        }
    });

    it('accepts new providers array format', () => {
        const result = ClassifierConfigSchema.safeParse({
            providers: [
                { provider: 'groq', model: 'llama-3.3-70b-versatile' },
                { provider: 'xai', model: 'grok-3-mini-fast' },
            ],
            fallbackTier: 'premium',
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.providers).toHaveLength(2);
            expect(result.data.providers[0].provider).toBe('groq');
            expect(result.data.providers[1].provider).toBe('xai');
        }
    });

    it('backward compat: wraps legacy single provider/model into providers array', () => {
        const result = ClassifierConfigSchema.safeParse({
            provider: 'groq',
            model: 'llama-3.3-70b-versatile',
            fallbackTier: 'premium',
            timeoutMs: 3000,
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.providers).toEqual([
                { provider: 'groq', model: 'llama-3.3-70b-versatile' },
            ]);
            expect(result.data.fallbackTier).toBe('premium');
            expect(result.data.timeoutMs).toBe(3000);
        }
    });

    it('rejects invalid fallbackTier enum value', () => {
        const result = ClassifierConfigSchema.safeParse({ fallbackTier: 'ultra' });
        expect(result.success).toBe(false);
    });

    it('accepts all valid fallbackTier values', () => {
        for (const tier of ['free', 'economical', 'premium', 'frontier']) {
            const result = ClassifierConfigSchema.safeParse({ fallbackTier: tier });
            expect(result.success).toBe(true);
        }
    });
});

// ────────────────────────────────────────────────────────────────
// ClassifierProviderEntrySchema
// ────────────────────────────────────────────────────────────────
describe('ClassifierProviderEntrySchema', () => {
    it('accepts valid entry', () => {
        const result = ClassifierProviderEntrySchema.safeParse({ provider: 'groq', model: 'llama' });
        expect(result.success).toBe(true);
    });

    it('rejects missing provider', () => {
        const result = ClassifierProviderEntrySchema.safeParse({ model: 'llama' });
        expect(result.success).toBe(false);
    });

    it('rejects missing model', () => {
        const result = ClassifierProviderEntrySchema.safeParse({ provider: 'groq' });
        expect(result.success).toBe(false);
    });
});

// ────────────────────────────────────────────────────────────────
// TrackingConfigSchema
// ────────────────────────────────────────────────────────────────
describe('TrackingConfigSchema', () => {
    it('applies all defaults when given empty object', () => {
        const result = TrackingConfigSchema.safeParse({});
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.enabled).toBe(true);
            expect(result.data.dbPath).toBe('./data/pharos.db');
            expect(result.data.baselineModel).toBe('claude-sonnet-4-20250514');
            expect(result.data.baselineCostPerMillionInput).toBe(3.0);
            expect(result.data.baselineCostPerMillionOutput).toBe(15.0);
        }
    });
});

// ────────────────────────────────────────────────────────────────
// ServerConfigSchema — new fields
// ────────────────────────────────────────────────────────────────
describe('ServerConfigSchema — new fields', () => {
    it('defaults agentRateLimitPerMinute to 30', () => {
        const result = ServerConfigSchema.safeParse({});
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.agentRateLimitPerMinute).toBe(30);
        }
    });

    it('accepts custom agentRateLimitPerMinute', () => {
        const result = ServerConfigSchema.safeParse({ agentRateLimitPerMinute: 60 });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.agentRateLimitPerMinute).toBe(60);
        }
    });

    it('rejects non-positive agentRateLimitPerMinute', () => {
        expect(ServerConfigSchema.safeParse({ agentRateLimitPerMinute: 0 }).success).toBe(false);
        expect(ServerConfigSchema.safeParse({ agentRateLimitPerMinute: -1 }).success).toBe(false);
    });

    it('defaults debugLogging to false', () => {
        const result = ServerConfigSchema.safeParse({});
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.debugLogging).toBe(false);
        }
    });

    it('accepts debugLogging true', () => {
        const result = ServerConfigSchema.safeParse({ debugLogging: true });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.debugLogging).toBe(true);
        }
    });
});

// ────────────────────────────────────────────────────────────────
// SpendingConfigSchema
// ────────────────────────────────────────────────────────────────
describe('SpendingConfigSchema', () => {
    it('defaults both limits to null', () => {
        const result = SpendingConfigSchema.safeParse({});
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.dailyLimit).toBeNull();
            expect(result.data.monthlyLimit).toBeNull();
        }
    });

    it('accepts positive daily limit', () => {
        const result = SpendingConfigSchema.safeParse({ dailyLimit: 5.0 });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.dailyLimit).toBe(5.0);
        }
    });

    it('accepts positive monthly limit', () => {
        const result = SpendingConfigSchema.safeParse({ monthlyLimit: 100.0 });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.monthlyLimit).toBe(100.0);
        }
    });

    it('accepts both limits set', () => {
        const result = SpendingConfigSchema.safeParse({ dailyLimit: 5.0, monthlyLimit: 100.0 });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.dailyLimit).toBe(5.0);
            expect(result.data.monthlyLimit).toBe(100.0);
        }
    });

    it('accepts null limits explicitly', () => {
        const result = SpendingConfigSchema.safeParse({ dailyLimit: null, monthlyLimit: null });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.dailyLimit).toBeNull();
            expect(result.data.monthlyLimit).toBeNull();
        }
    });

    it('rejects zero daily limit', () => {
        const result = SpendingConfigSchema.safeParse({ dailyLimit: 0 });
        expect(result.success).toBe(false);
    });

    it('rejects negative monthly limit', () => {
        const result = SpendingConfigSchema.safeParse({ monthlyLimit: -10 });
        expect(result.success).toBe(false);
    });
});

// ────────────────────────────────────────────────────────────────
// PharosConfigSchema — spending integration
// ────────────────────────────────────────────────────────────────
describe('PharosConfigSchema — spending', () => {
    it('includes spending with defaults in full config', () => {
        const result = PharosConfigSchema.safeParse({});
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.spending.dailyLimit).toBeNull();
            expect(result.data.spending.monthlyLimit).toBeNull();
        }
    });

    it('accepts spending limits in full config', () => {
        const result = PharosConfigSchema.safeParse({
            spending: { dailyLimit: 10.0, monthlyLimit: 200.0 },
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.spending.dailyLimit).toBe(10.0);
            expect(result.data.spending.monthlyLimit).toBe(200.0);
        }
    });
});
