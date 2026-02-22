import type { PharosConfig } from '../config/schema.js';
import type { Logger } from '../utils/logger.js';
import type { LLMProvider } from './base.js';
import { AnthropicProvider } from './anthropic.js';
import { GoogleProvider } from './google.js';
import { OpenAICompatProvider } from './openai-compat.js';

/** Default request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Default health-check cooldown in milliseconds. */
const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * Provider Registry — manages all LLM provider instances.
 *
 * Initializes providers based on config and available API keys.
 * Provides lookup by provider name for the router.
 */
export class ProviderRegistry {
    private providers = new Map<string, LLMProvider>();
    private logger: Logger;

    constructor(config: PharosConfig, logger: Logger) {
        this.logger = logger;
        this.initializeProviders(config);
    }

    /**
     * Create provider instances for all configured providers that have API keys.
     */
    private initializeProviders(config: PharosConfig): void {
        const timeoutMs = DEFAULT_TIMEOUT_MS;
        const cooldownMs = DEFAULT_COOLDOWN_MS;

        for (const [name, providerConfig] of Object.entries(config.providers)) {
            const apiKey = process.env[providerConfig.apiKeyEnv];

            let provider: LLMProvider;

            switch (name) {
                case 'anthropic':
                    provider = new AnthropicProvider(apiKey, this.logger, timeoutMs, cooldownMs);
                    break;
                case 'google':
                    provider = new GoogleProvider(apiKey, this.logger, timeoutMs, cooldownMs);
                    break;
                default:
                    // Everything else uses the OpenAI-compatible adapter
                    provider = new OpenAICompatProvider(
                        name,
                        apiKey,
                        providerConfig.baseUrl ?? 'https://api.openai.com/v1',
                        this.logger,
                        timeoutMs,
                        cooldownMs,
                    );
                    break;
            }

            this.providers.set(name, provider);

            if (provider.available) {
                this.logger.info(`✓ Provider ${name}: ready`);
            }
        }
    }

    /**
     * Get a provider by name.
     */
    get(name: string): LLMProvider | undefined {
        return this.providers.get(name);
    }

    /**
     * Check if a specific provider is available and healthy.
     */
    isAvailable(name: string): boolean {
        const provider = this.providers.get(name);
        return provider?.isHealthy() ?? false;
    }

    /**
     * Get a summary of all provider statuses.
     */
    getStatus(): Record<string, { available: boolean; healthy: boolean }> {
        const status: Record<string, { available: boolean; healthy: boolean }> = {};
        for (const [name, provider] of this.providers) {
            status[name] = {
                available: provider.available,
                healthy: provider.isHealthy(),
            };
        }
        return status;
    }

    /**
     * List all available provider names.
     */
    listAvailable(): string[] {
        return Array.from(this.providers.entries())
            .filter(([, provider]) => provider.isHealthy())
            .map(([name]) => name);
    }
}
