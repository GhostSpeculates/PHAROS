import { describe, it, expect, vi } from 'vitest';
import { loadConfig } from '../../config/index.js';
import type { ProviderRegistry } from '../../providers/index.js';
import type { Logger } from '../../utils/logger.js';
import { ModelRouter } from '../../router/index.js';
import type { ClassificationResult } from '../../classifier/types.js';

describe('router snapshot (pre-sync, default config)', () => {
    const config = loadConfig();

    // Mock registry: report every provider in the config as available
    const allProviders = Object.keys(config.providers);
    const registry: ProviderRegistry = {
        isAvailable: (name: string) => allProviders.includes(name),
        get: vi.fn(),
        getStatus: vi.fn(),
        listAvailable: vi.fn(),
    } as unknown as ProviderRegistry;

    const logger: Logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        fatal: vi.fn(),
        trace: vi.fn(),
        child: vi.fn().mockReturnThis(),
    } as unknown as Logger;

    const router = new ModelRouter(config, registry, logger);

    it('tier 2 routes to a free-tier model', () => {
        const c: ClassificationResult = {
            score: 2,
            type: 'conversation',
            latencyMs: 1,
            isFallback: false,
            classifierProvider: 'static',
        };
        const decision = router.route(c);
        const tierModels = config.tiers.free.models.map(m => `${m.provider}:${m.model}`);
        expect(tierModels).toContain(`${decision.provider}:${decision.model}`);
    });

    it('tier 5 routes to an economical-tier model', () => {
        const c: ClassificationResult = {
            score: 5,
            type: 'conversation',
            latencyMs: 1,
            isFallback: false,
            classifierProvider: 'static',
        };
        const decision = router.route(c);
        const tierModels = config.tiers.economical.models.map(m => `${m.provider}:${m.model}`);
        expect(tierModels).toContain(`${decision.provider}:${decision.model}`);
    });

    it('tier 10 routes to frontier-tier model', () => {
        const c: ClassificationResult = {
            score: 10,
            type: 'reasoning',
            latencyMs: 1,
            isFallback: false,
            classifierProvider: 'static',
        };
        const decision = router.route(c);
        const tierModels = config.tiers.frontier.models.map(m => `${m.provider}:${m.model}`);
        expect(tierModels).toContain(`${decision.provider}:${decision.model}`);
    });
});
