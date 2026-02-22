import { GoogleGenAI } from '@google/genai';
import type { PharosConfig } from '../config/schema.js';
import type { ClassificationResult, TaskType } from './types.js';
import { TASK_TYPES } from './types.js';
import { CLASSIFICATION_PROMPT, buildClassificationInput } from './prompt.js';
import type { Logger } from '../utils/logger.js';

/**
 * Query Classifier — The Brain of Pharos
 *
 * Uses Gemini Flash (free tier) to analyze each incoming query and
 * determine how complex it is. This score drives the routing decision.
 */
export class QueryClassifier {
    private genai: GoogleGenAI | null = null;
    private model: string;
    private fallbackTier: string;
    private timeoutMs: number;
    private logger: Logger;
    private tierScoreRanges: Record<string, [number, number]>;

    constructor(config: PharosConfig, logger: Logger) {
        this.model = config.classifier.model;
        this.fallbackTier = config.classifier.fallbackTier;
        this.timeoutMs = config.classifier.timeoutMs;
        this.logger = logger;

        // Store tier score ranges so fallback scores can be derived from config
        this.tierScoreRanges = {};
        for (const [name, tier] of Object.entries(config.tiers)) {
            this.tierScoreRanges[name] = tier.scoreRange as [number, number];
        }

        // Initialize the Google AI client
        const apiKey = process.env[config.providers.google?.apiKeyEnv ?? 'GOOGLE_AI_API_KEY'];
        if (apiKey) {
            this.genai = new GoogleGenAI({ apiKey });
            this.logger.info('Query classifier initialized (Gemini Flash)');
        } else {
            this.logger.warn(
                'No Google AI API key found — classifier will use fallback tier for all queries',
            );
        }
    }

    /**
     * Classify a set of messages and return a complexity score + task type.
     */
    async classify(
        messages: Array<{ role: string; content: string }>,
    ): Promise<ClassificationResult> {
        const startTime = Date.now();

        // If no classifier available, return fallback
        if (!this.genai) {
            return this.fallback(startTime, 'no_api_key');
        }

        // Use AbortController to cancel the request on timeout.
        // The Google GenAI SDK supports abortSignal in the config, which
        // allows us to properly abort the HTTP request rather than just
        // racing a timeout promise (which would leave the request dangling).
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            const userInput = buildClassificationInput(messages);

            const response = await this.genai.models.generateContent({
                model: this.model,
                contents: `${CLASSIFICATION_PROMPT}\n\n---\n\nUser messages to classify:\n${userInput}`,
                config: {
                    abortSignal: controller.signal,
                },
            });

            if (!response || !response.text) {
                return this.fallback(startTime, 'empty_response');
            }

            return this.parseResponse(response.text, startTime);
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
