import OpenAI from 'openai';
import type { PharosConfig } from '../config/schema.js';
import type { ClassificationResult, TaskType } from './types.js';
import { TASK_TYPES } from './types.js';
import { CLASSIFICATION_PROMPT, buildClassificationInput } from './prompt.js';
import type { Logger } from '../utils/logger.js';

/**
 * Query Classifier — The Brain of Pharos
 *
 * Uses a lightweight, cheap model to analyze each incoming query and
 * determine how complex it is. This score drives the routing decision.
 *
 * Supports any OpenAI-compatible provider (Groq, xAI, DeepSeek, OpenAI, etc.)
 * or Google Gemini via the Google GenAI SDK.
 */
export class QueryClassifier {
    private client: OpenAI | null = null;
    private model: string;
    private fallbackTier: string;
    private timeoutMs: number;
    private logger: Logger;
    private tierScoreRanges: Record<string, [number, number]>;
    private providerName: string;

    constructor(config: PharosConfig, logger: Logger) {
        this.model = config.classifier.model;
        this.fallbackTier = config.classifier.fallbackTier;
        this.timeoutMs = config.classifier.timeoutMs;
        this.logger = logger;
        this.providerName = config.classifier.provider;

        // Store tier score ranges so fallback scores can be derived from config
        this.tierScoreRanges = {};
        for (const [name, tier] of Object.entries(config.tiers)) {
            this.tierScoreRanges[name] = tier.scoreRange as [number, number];
        }

        // Resolve API key and base URL from the provider config
        const providerConfig = config.providers[this.providerName];
        if (!providerConfig) {
            this.logger.warn(
                { provider: this.providerName },
                'Classifier provider not found in config — will use fallback for all queries',
            );
            return;
        }

        const apiKey = process.env[providerConfig.apiKeyEnv];
        if (!apiKey) {
            this.logger.warn(
                { provider: this.providerName, envVar: providerConfig.apiKeyEnv },
                'No API key found for classifier provider — will use fallback for all queries',
            );
            return;
        }

        // Build an OpenAI-compatible client pointed at the provider's base URL
        const baseURL = providerConfig.baseUrl ?? 'https://api.openai.com/v1';
        this.client = new OpenAI({ apiKey, baseURL });
        this.logger.info(
            `Query classifier initialized (${this.providerName}/${this.model})`,
        );
    }

    /**
     * Classify a set of messages and return a complexity score + task type.
     */
    async classify(
        messages: Array<{ role: string; content: unknown }>,
    ): Promise<ClassificationResult> {
        const startTime = Date.now();

        // If no classifier available, return fallback
        if (!this.client) {
            return this.fallback(startTime, 'no_api_key');
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            const userInput = buildClassificationInput(messages);

            const response = await this.client.chat.completions.create(
                {
                    model: this.model,
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
                return this.fallback(startTime, 'empty_response');
            }

            return this.parseResponse(text, startTime);
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : 'unknown';
            this.logger.warn({ error: errMsg }, 'Classifier failed, using fallback');
            return this.fallback(startTime, errMsg);
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * Parse the JSON response from the classifier.
     */
    private parseResponse(text: string, startTime: number): ClassificationResult {
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
                    { rawScore: parsed.score },
                    'Classifier returned invalid score (not a number between 1-10), using fallback',
                );
                return this.fallback(startTime, 'invalid_score');
            }

            const score = Math.max(1, Math.min(10, Math.round(rawScore)));
            const type = TASK_TYPES.includes(parsed.type) ? (parsed.type as TaskType) : 'analysis';

            const result: ClassificationResult = {
                score,
                type,
                latencyMs: Date.now() - startTime,
                isFallback: false,
            };

            this.logger.debug({ classification: result }, 'Query classified');
            return result;
        } catch {
            return this.fallback(startTime, 'parse_error');
        }
    }

    /**
     * Return a safe fallback classification when the classifier fails.
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
        };

        this.logger.debug({ reason, fallbackScore: result.score }, 'Using fallback classification');
        return result;
    }
}
