import type { PharosConfig } from '../config/schema.js';
import type { ProviderRegistry } from '../providers/index.js';
import type { Logger } from './logger.js';

export interface SelfTestResults {
    passed: string[];
    failed: string[];
}

const SELF_TEST_TIMEOUT_MS = 10_000;

/**
 * Send a tiny test request to each available provider to verify
 * they actually respond (not just that API keys exist).
 *
 * Runs all tests in parallel. Does NOT mark failed providers as
 * unhealthy — this is purely informational.
 */
export async function providerSelfTest(
    config: PharosConfig,
    registry: ProviderRegistry,
    logger: Logger,
): Promise<SelfTestResults> {
    const available = registry.listAvailable();
    const passed: string[] = [];
    const failed: string[] = [];

    if (available.length === 0) {
        logger.warn('Self-test: no providers available, skipping');
        return { passed, failed };
    }

    // Build provider → model map from tier config (first occurrence = cheapest)
    const providerModelMap = new Map<string, string>();
    for (const tier of Object.values(config.tiers)) {
        for (const entry of tier.models) {
            if (!providerModelMap.has(entry.provider)) {
                providerModelMap.set(entry.provider, entry.model);
            }
        }
    }

    // Only test providers that have a model in the tier config
    const testable = available.filter((name) => providerModelMap.has(name));
    if (testable.length === 0) {
        logger.warn('Self-test: no providers with tier-configured models, skipping');
        return { passed, failed };
    }

    logger.info(`Self-test: testing ${testable.length} providers...`);

    const results = await Promise.allSettled(
        testable.map(async (name) => {
            const provider = registry.get(name)!;
            const model = providerModelMap.get(name)!;

            const start = Date.now();
            await Promise.race([
                provider.chat({
                    model,
                    messages: [{ role: 'user', content: 'hi' }],
                    maxTokens: 5,
                }),
                new Promise<never>((_, reject) =>
                    setTimeout(
                        () => reject(new Error('self-test timeout (10s)')),
                        SELF_TEST_TIMEOUT_MS,
                    ),
                ),
            ]);
            return Date.now() - start;
        }),
    );

    results.forEach((result, i) => {
        const name = testable[i];
        const provider = registry.get(name);
        if (result.status === 'fulfilled') {
            logger.info(`  ✓ ${name}: responded in ${result.value}ms`);
            passed.push(`${name} (${result.value}ms)`);
        } else {
            const errMsg =
                result.reason instanceof Error ? result.reason.message : String(result.reason);
            logger.warn(`  ✗ ${name}: ${errMsg}`);
            failed.push(`${name}: ${errMsg}`);
            // Undo error recording — self-test failures are informational only
            provider?.undoLastError();
        }
    });

    return { passed, failed };
}
