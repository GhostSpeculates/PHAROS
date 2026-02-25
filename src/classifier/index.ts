import OpenAI from 'openai';
import type { PharosConfig } from '../config/schema.js';
import type { ClassificationResult, TaskType } from './types.js';
import { TASK_TYPES } from './types.js';
import { CLASSIFICATION_PROMPT, buildClassificationInput } from './prompt.js';
import type { Logger } from '../utils/logger.js';
import { sendAlert } from '../utils/alerts.js';

interface ClassifierProvider {
    name: string;
    client: OpenAI;
    model: string;
}

/**
 * Query Classifier — The Brain of Pharos
 *
 * Uses a lightweight, cheap model to analyze each incoming query and
 * determine how complex it is. This score drives the routing decision.
 *
 * Supports a failover chain of OpenAI-compatible classifier providers.
 * If the primary fails, tries the next in line. Only falls back to a
 * static tier score if ALL classifier providers are exhausted.
 */
export class QueryClassifier {
    private classifierProviders: ClassifierProvider[] = [];
    private fallbackTier: string;
    private timeoutMs: number;
    private logger: Logger;
    private tierScoreRanges: Record<string, [number, number]>;

    constructor(config: PharosConfig, logger: Logger) {
        this.fallbackTier = config.classifier.fallbackTier;
        this.timeoutMs = config.classifier.timeoutMs;
        this.logger = logger;

        // Store tier score ranges so fallback scores can be derived from config
        this.tierScoreRanges = {};
        for (const [name, tier] of Object.entries(config.tiers)) {
            this.tierScoreRanges[name] = tier.scoreRange as [number, number];
        }

        // Build classifier provider chain
        for (const entry of config.classifier.providers) {
            const providerConfig = config.providers[entry.provider];
            if (!providerConfig) {
                logger.warn(
                    { provider: entry.provider },
                    'Classifier provider not found in providers config, skipping',
                );
                continue;
            }

            const apiKey = process.env[providerConfig.apiKeyEnv];
            if (!apiKey) {
                logger.warn(
                    { provider: entry.provider, envVar: providerConfig.apiKeyEnv },
                    'No API key for classifier provider, skipping',
                );
                continue;
            }

            const baseURL = providerConfig.baseUrl ?? 'https://api.openai.com/v1';
            this.classifierProviders.push({
                name: entry.provider,
                client: new OpenAI({ apiKey, baseURL }),
                model: entry.model,
            });
        }

        if (this.classifierProviders.length > 0) {
            const chain = this.classifierProviders.map((p) => `${p.name}/${p.model}`).join(' → ');
            logger.info(`Query classifier initialized (${chain})`);
        } else {
            logger.warn('No classifier providers available — will use fallback for all queries');
        }
    }

    /**
     * Classify a set of messages and return a complexity score + task type.
     * Tries each classifier provider in order; falls back to static score if all fail.
     */
    async classify(
        messages: Array<{ role: string; content: unknown }>,
    ): Promise<ClassificationResult> {
        const startTime = Date.now();

        // If no classifier providers available, return fallback
        if (this.classifierProviders.length === 0) {
            return this.fallback(startTime, 'no_providers');
        }

        // Build truncated input once (shared across all provider attempts)
        const userInput = buildClassificationInput(messages, this.logger);

        // Try each classifier provider in order
        for (const cp of this.classifierProviders) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

            try {
                const response = await cp.client.chat.completions.create(
                    {
                        model: cp.model,
                        messages: [
                            { role: 'system', content: CLASSIFICATION_PROMPT },
                            { role: 'user', content: userInput },
                        ],
                        temperature: 0,
                        max_tokens: 50,
                    },
                    { signal: controller.signal },
                );

                const text = response.choices?.[0]?.message?.content;
                if (!text) {
                    this.logger.warn(
                        { provider: cp.name },
                        'Classifier returned empty response, trying next',
                    );
                    continue;
                }

                const result = this.parseResponse(text, startTime, cp.name);
                if (result) return result;
                // parseResponse returned null (invalid score), try next provider
            } catch (error) {
                const errMsg = error instanceof Error ? error.message : 'unknown';
                this.logger.warn(
                    { provider: cp.name, model: cp.model, error: errMsg },
                    'Classifier provider failed, trying next',
                );
                // Alert on primary classifier failure (first in chain)
                if (cp === this.classifierProviders[0]) {
                    sendAlert(
                        'Classifier Failover',
                        `Primary classifier **${cp.name}/${cp.model}** failed.\nError: ${errMsg}\nFalling back to next provider.`,
                        'warning',
                        `classifier_failover:${cp.name}`,
                    );
                }
            } finally {
                clearTimeout(timeoutId);
            }
        }

        // All providers failed
        this.logger.warn('All classifier providers failed, using fallback');
        sendAlert(
            'All Classifiers Failed',
            `All ${this.classifierProviders.length} classifier providers failed.\nUsing static fallback score (${this.fallbackTier} tier midpoint).`,
            'critical',
            'classifier_all_failed',
        );
        return this.fallback(startTime, 'all_providers_failed');
    }

    /**
     * Parse the JSON response from the classifier.
     * Returns null if parsing fails (caller should try next provider).
     */
    private parseResponse(
        text: string,
        startTime: number,
        classifierProvider: string,
    ): ClassificationResult | null {
        try {
            // Strip markdown code fences if present
            const cleaned = text
                .replace(/```json\s*/gi, '')
                .replace(/```\s*/g, '')
                .trim();

            const parsed = JSON.parse(cleaned);

            // Validate that parsed.score is actually a number between 1 and 10
            const rawScore = Number(parsed.score);
            if (!Number.isFinite(rawScore) || rawScore < 1 || rawScore > 10) {
                this.logger.warn(
                    { rawScore: parsed.score, provider: classifierProvider },
                    'Classifier returned invalid score, trying next',
                );
                return null;
            }

            const score = Math.max(1, Math.min(10, Math.round(rawScore)));
            const type = TASK_TYPES.includes(parsed.type) ? (parsed.type as TaskType) : 'analysis';

            const result: ClassificationResult = {
                score,
                type,
                latencyMs: Date.now() - startTime,
                isFallback: false,
                classifierProvider,
            };

            this.logger.debug({ classification: result }, 'Query classified');
            return result;
        } catch {
            this.logger.warn(
                { provider: classifierProvider },
                'Failed to parse classifier response, trying next',
            );
            return null;
        }
    }

    /**
     * Return a safe fallback classification when all classifier providers fail.
     * Derives the fallback score from the tier's scoreRange midpoint
     * instead of using hardcoded values.
     */
    private fallback(startTime: number, reason: string): ClassificationResult {
        let score = 5; // ultimate fallback if tier not found

        const range = this.tierScoreRanges[this.fallbackTier];
        if (range) {
            const [min, max] = range;
            score = Math.round((min + max) / 2);
        } else {
            this.logger.warn(
                { fallbackTier: this.fallbackTier },
                'Fallback tier not found in config, using default score of 5',
            );
        }

        const result: ClassificationResult = {
            score,
            type: 'analysis',
            latencyMs: Date.now() - startTime,
            isFallback: true,
            classifierProvider: 'fallback',
        };

        this.logger.debug({ reason, fallbackScore: result.score }, 'Using fallback classification');
        return result;
    }
}
