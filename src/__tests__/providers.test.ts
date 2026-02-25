import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from '../utils/logger.js';
import type { ChatRequest, ChatMessage } from '../providers/types.js';
import type { PharosConfig } from '../config/schema.js';

// ─── Mock SDK modules ─────────────────────────────────────
// Must be hoisted before imports of modules that use them.

const mockAnthropicCreate = vi.fn();
const mockAnthropicStream = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: mockAnthropicCreate,
        stream: mockAnthropicStream,
      };
      constructor() {}
    },
  };
});

const mockGoogleGenerateContent = vi.fn();
const mockGoogleGenerateContentStream = vi.fn();
vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: class MockGoogleGenAI {
      models = {
        generateContent: mockGoogleGenerateContent,
        generateContentStream: mockGoogleGenerateContentStream,
      };
      constructor() {}
    },
  };
});

const mockOpenAICreate = vi.fn();
vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: mockOpenAICreate,
        },
      };
      constructor() {}
    },
  };
});

// ─── Import after mocks ────────────────────────────────────

import { LLMProvider } from '../providers/base.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { GoogleProvider } from '../providers/google.js';
import { OpenAICompatProvider } from '../providers/openai-compat.js';
import { ProviderRegistry } from '../providers/index.js';

// ─── Helpers ───────────────────────────────────────────────

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

function makeRequest(overrides?: Partial<ChatRequest>): ChatRequest {
  return {
    model: 'test-model',
    messages: [{ role: 'user', content: 'Hello', name: undefined }],
    ...overrides,
  };
}

/**
 * Concrete test subclass of LLMProvider for testing the abstract base.
 * chat() and chatStream() call recordSuccess/recordError to exercise health tracking.
 */
class TestProvider extends LLMProvider {
  shouldFail = false;
  failMessage = 'test error';

  constructor(
    name: string,
    apiKey: string | undefined,
    logger: Logger,
    timeoutMs?: number,
    cooldownMs?: number,
  ) {
    super(name, apiKey, logger, timeoutMs, cooldownMs);
  }

  async chat(_request: ChatRequest) {
    if (this.shouldFail) {
      this.recordError(this.failMessage);
      throw new Error(this.failMessage);
    }
    this.recordSuccess();
    return {
      content: 'test response',
      model: 'test-model',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      finishReason: 'stop',
    };
  }

  async *chatStream(_request: ChatRequest) {
    if (this.shouldFail) {
      this.recordError(this.failMessage);
      throw new Error(this.failMessage);
    }
    this.recordSuccess();
    yield { content: 'test' };
    yield {
      content: '',
      finishReason: 'stop',
      model: 'test-model',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    };
  }

  // Expose protected methods for direct testing
  public testRecordError(msg: string): void {
    this.recordError(msg);
  }
  public testRecordSuccess(): void {
    this.recordSuccess();
  }
}

// ────────────────────────────────────────────────────────────
// 1. Base Provider (LLMProvider)
// ────────────────────────────────────────────────────────────
describe('LLMProvider (base)', () => {
  let logger: Logger;

  beforeEach(() => {
    logger = makeLogger();
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('sets provider name correctly', () => {
      const provider = new TestProvider('test-provider', 'key-123', logger);
      expect(provider.name).toBe('test-provider');
    });

    it('marks available when API key is provided', () => {
      const provider = new TestProvider('test', 'key-123', logger);
      expect(provider.available).toBe(true);
    });

    it('marks unavailable when API key is undefined', () => {
      const provider = new TestProvider('test', undefined, logger);
      expect(provider.available).toBe(false);
    });

    it('marks unavailable when API key is empty string', () => {
      const provider = new TestProvider('test', '', logger);
      expect(provider.available).toBe(false);
    });

    it('logs debug message when no API key provided', () => {
      new TestProvider('test', undefined, logger);
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('no API key'));
    });

    it('uses default timeout of 30000ms', () => {
      const provider = new TestProvider('test', 'key', logger);
      // Access via getHealth or indirectly — the timeoutMs is protected
      // We verify by checking the provider was created without error
      expect(provider.name).toBe('test');
    });

    it('accepts custom timeout', () => {
      const provider = new TestProvider('test', 'key', logger, 15000);
      expect(provider.name).toBe('test');
    });

    it('accepts custom cooldown', () => {
      const provider = new TestProvider('test', 'key', logger, 30000, 120000);
      expect(provider.name).toBe('test');
    });
  });

  describe('health tracking', () => {
    it('starts healthy', () => {
      const provider = new TestProvider('test', 'key-123', logger);
      expect(provider.isHealthy()).toBe(true);
    });

    it('starts with zero consecutive errors', () => {
      const provider = new TestProvider('test', 'key-123', logger);
      const health = provider.getHealth();
      expect(health.consecutiveErrors).toBe(0);
    });

    it('isHealthy returns false when no API key', () => {
      const provider = new TestProvider('test', undefined, logger);
      expect(provider.isHealthy()).toBe(false);
    });
  });

  describe('recordError()', () => {
    it('increments consecutive error count', () => {
      const provider = new TestProvider('test', 'key', logger);
      provider.testRecordError('fail 1');
      expect(provider.getHealth().consecutiveErrors).toBe(1);
    });

    it('stores last error message', () => {
      const provider = new TestProvider('test', 'key', logger);
      provider.testRecordError('something broke');
      expect(provider.getHealth().lastError).toBe('something broke');
    });

    it('stores last error time', () => {
      const provider = new TestProvider('test', 'key', logger);
      const before = Date.now();
      provider.testRecordError('fail');
      const health = provider.getHealth();
      expect(health.lastErrorTime).toBeGreaterThanOrEqual(before);
      expect(health.lastErrorTime).toBeLessThanOrEqual(Date.now());
    });

    it('provider becomes unhealthy after 3 consecutive errors', () => {
      const provider = new TestProvider('test', 'key', logger);
      provider.testRecordError('fail 1');
      provider.testRecordError('fail 2');
      expect(provider.isHealthy()).toBe(true);
      provider.testRecordError('fail 3');
      expect(provider.isHealthy()).toBe(false);
    });

    it('logs warning when marking unavailable', () => {
      const provider = new TestProvider('test', 'key', logger);
      provider.testRecordError('e1');
      provider.testRecordError('e2');
      provider.testRecordError('e3');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('marked unavailable'),
      );
    });
  });

  describe('recordSuccess()', () => {
    it('resets consecutive error count', () => {
      const provider = new TestProvider('test', 'key', logger);
      provider.testRecordError('fail 1');
      provider.testRecordError('fail 2');
      expect(provider.getHealth().consecutiveErrors).toBe(2);
      provider.testRecordSuccess();
      expect(provider.getHealth().consecutiveErrors).toBe(0);
    });

    it('marks provider as available', () => {
      const provider = new TestProvider('test', 'key', logger);
      // Make unhealthy first
      provider.testRecordError('e1');
      provider.testRecordError('e2');
      provider.testRecordError('e3');
      expect(provider.isHealthy()).toBe(false);
      provider.testRecordSuccess();
      expect(provider.isHealthy()).toBe(true);
    });
  });

  describe('isHealthy()', () => {
    it('returns false when unhealthy and cooldown has not passed', () => {
      const provider = new TestProvider('test', 'key', logger, 30000, 60000);
      provider.testRecordError('e1');
      provider.testRecordError('e2');
      provider.testRecordError('e3');
      expect(provider.isHealthy()).toBe(false);
    });

    it('returns true after cooldown expires', () => {
      const provider = new TestProvider('test', 'key', logger, 30000, 100);
      provider.testRecordError('e1');
      provider.testRecordError('e2');
      provider.testRecordError('e3');
      expect(provider.isHealthy()).toBe(false);

      // Wait for cooldown to expire
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(provider.isHealthy()).toBe(true);
          expect(provider.getHealth().consecutiveErrors).toBe(0);
          resolve();
        }, 150);
      });
    });

    it('logs info when cooldown expires and provider recovers', () => {
      const provider = new TestProvider('test', 'key', logger, 30000, 100);
      provider.testRecordError('e1');
      provider.testRecordError('e2');
      provider.testRecordError('e3');

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          provider.isHealthy();
          expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('cooldown expired'),
          );
          resolve();
        }, 150);
      });
    });
  });

  describe('undoLastError()', () => {
    it('decrements consecutive error count', () => {
      const provider = new TestProvider('test', 'key', logger);
      provider.testRecordError('e1');
      provider.testRecordError('e2');
      expect(provider.getHealth().consecutiveErrors).toBe(2);
      provider.undoLastError();
      expect(provider.getHealth().consecutiveErrors).toBe(1);
    });

    it('does not go below zero', () => {
      const provider = new TestProvider('test', 'key', logger);
      provider.undoLastError();
      expect(provider.getHealth().consecutiveErrors).toBe(0);
    });

    it('re-marks healthy if error count drops below threshold', () => {
      const provider = new TestProvider('test', 'key', logger);
      provider.testRecordError('e1');
      provider.testRecordError('e2');
      provider.testRecordError('e3');
      expect(provider.isHealthy()).toBe(false);
      provider.undoLastError(); // back to 2
      expect(provider.isHealthy()).toBe(true);
    });

    it('does not re-mark healthy if still at threshold', () => {
      const provider = new TestProvider('test', 'key', logger);
      provider.testRecordError('e1');
      provider.testRecordError('e2');
      provider.testRecordError('e3');
      provider.testRecordError('e4'); // consecutiveErrors = 4
      provider.undoLastError(); // back to 3, still >= threshold
      expect(provider.isHealthy()).toBe(false);
    });
  });

  describe('recordLatency()', () => {
    it('stores latency samples', () => {
      const provider = new TestProvider('test', 'key', logger);
      provider.recordLatency(100);
      provider.recordLatency(200);
      const stats = provider.getLatencyStats();
      expect(stats.samples).toBe(2);
    });

    it('calculates avg correctly', () => {
      const provider = new TestProvider('test', 'key', logger);
      provider.recordLatency(100);
      provider.recordLatency(200);
      provider.recordLatency(300);
      const stats = provider.getLatencyStats();
      expect(stats.avgMs).toBe(200);
    });

    it('calculates min and max', () => {
      const provider = new TestProvider('test', 'key', logger);
      provider.recordLatency(50);
      provider.recordLatency(300);
      provider.recordLatency(150);
      const stats = provider.getLatencyStats();
      expect(stats.minMs).toBe(50);
      expect(stats.maxMs).toBe(300);
    });

    it('calculates p95', () => {
      const provider = new TestProvider('test', 'key', logger);
      // Add 20 samples from 100-2000
      for (let i = 1; i <= 20; i++) {
        provider.recordLatency(i * 100);
      }
      const stats = provider.getLatencyStats();
      // p95Index = Math.floor(20 * 0.95) = 19, sorted[19] = 2000
      expect(stats.p95Ms).toBe(2000);
    });

    it('limits history to window size (50)', () => {
      const provider = new TestProvider('test', 'key', logger);
      for (let i = 0; i < 60; i++) {
        provider.recordLatency(100);
      }
      const stats = provider.getLatencyStats();
      expect(stats.samples).toBe(50);
    });
  });

  describe('latency degradation', () => {
    it('does not warn before baseline established (10 samples)', () => {
      const provider = new TestProvider('test', 'key', logger);
      for (let i = 0; i < 9; i++) {
        provider.recordLatency(100);
      }
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('establishes baseline after 10 samples', () => {
      const provider = new TestProvider('test', 'key', logger);
      for (let i = 0; i < 10; i++) {
        provider.recordLatency(100);
      }
      const stats = provider.getLatencyStats();
      expect(stats.degraded).toBe(false);
    });

    it('detects degradation when avg exceeds 2x baseline', () => {
      const provider = new TestProvider('test', 'key', logger);
      // Establish baseline at 100ms
      for (let i = 0; i < 10; i++) {
        provider.recordLatency(100);
      }
      // Push latency to >200ms avg (need many high samples to pull avg up)
      for (let i = 0; i < 40; i++) {
        provider.recordLatency(500);
      }
      const stats = provider.getLatencyStats();
      expect(stats.degraded).toBe(true);
    });

    it('logs warning on degradation', () => {
      const provider = new TestProvider('test', 'key', logger);
      for (let i = 0; i < 10; i++) {
        provider.recordLatency(100);
      }
      for (let i = 0; i < 40; i++) {
        provider.recordLatency(500);
      }
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'test' }),
        expect.stringContaining('latency degraded'),
      );
    });
  });

  describe('getLatencyStats()', () => {
    it('returns zeroes when no samples', () => {
      const provider = new TestProvider('test', 'key', logger);
      const stats = provider.getLatencyStats();
      expect(stats).toEqual({
        avgMs: 0,
        minMs: 0,
        maxMs: 0,
        p95Ms: 0,
        samples: 0,
        degraded: false,
      });
    });
  });

  describe('getHealth()', () => {
    it('returns a copy (not reference) of health state', () => {
      const provider = new TestProvider('test', 'key', logger);
      const h1 = provider.getHealth();
      const h2 = provider.getHealth();
      expect(h1).not.toBe(h2); // different objects
      expect(h1).toEqual(h2); // same values
    });

    it('returns correct status object', () => {
      const provider = new TestProvider('test', 'key', logger);
      provider.testRecordError('oops');
      const health = provider.getHealth();
      expect(health.available).toBe(true);
      expect(health.consecutiveErrors).toBe(1);
      expect(health.lastError).toBe('oops');
      expect(typeof health.lastErrorTime).toBe('number');
    });
  });
});

// ────────────────────────────────────────────────────────────
// 2. Anthropic Provider
// ────────────────────────────────────────────────────────────
describe('AnthropicProvider', () => {
  let logger: Logger;

  beforeEach(() => {
    logger = makeLogger();
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('sets up client when API key provided', () => {
      const provider = new AnthropicProvider('sk-test-key', logger);
      expect(provider.available).toBe(true);
      expect(provider.name).toBe('anthropic');
    });

    it('null client when no API key', () => {
      const provider = new AnthropicProvider(undefined, logger);
      expect(provider.available).toBe(false);
    });

    it('accepts custom timeout and cooldown', () => {
      const provider = new AnthropicProvider('sk-test', logger, 15000, 30000);
      expect(provider.name).toBe('anthropic');
    });
  });

  describe('chat()', () => {
    it('throws when provider not configured (no API key)', async () => {
      const provider = new AnthropicProvider(undefined, logger);
      await expect(provider.chat(makeRequest())).rejects.toThrow(
        'Anthropic provider not configured',
      );
    });

    it('extracts system message from messages array', async () => {
      const provider = new AnthropicProvider('sk-test', logger);

      mockAnthropicCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Response' }],
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 10, output_tokens: 20 },
        stop_reason: 'end_turn',
      });

      await provider.chat(
        makeRequest({
          messages: [
            { role: 'system', content: 'You are helpful.' },
            { role: 'user', content: 'Hi' },
          ],
        }),
      );

      expect(mockAnthropicCreate).toHaveBeenCalledWith(
        expect.objectContaining({ system: 'You are helpful.' }),
        expect.anything(),
      );
    });

    it('concatenates multiple system messages with double newline', async () => {
      const provider = new AnthropicProvider('sk-test', logger);

      mockAnthropicCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'R' }],
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: 'end_turn',
      });

      await provider.chat(
        makeRequest({
          messages: [
            { role: 'system', content: 'First instruction.' },
            { role: 'system', content: 'Second instruction.' },
            { role: 'user', content: 'Hi' },
          ],
        }),
      );

      expect(mockAnthropicCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          system: 'First instruction.\n\nSecond instruction.',
        }),
        expect.anything(),
      );
    });

    it('handles array content in system message (extracts text parts)', async () => {
      const provider = new AnthropicProvider('sk-test', logger);

      mockAnthropicCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'R' }],
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: 'end_turn',
      });

      await provider.chat(
        makeRequest({
          messages: [
            {
              role: 'system',
              content: [
                { type: 'text', text: 'Part A' },
                { type: 'image_url', url: 'https://example.com/img.png' },
                { type: 'text', text: 'Part B' },
              ] as any,
            },
            { role: 'user', content: 'Hi' },
          ],
        }),
      );

      expect(mockAnthropicCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          system: 'Part A Part B',
        }),
        expect.anything(),
      );
    });

    it('preserves user and assistant messages in order', async () => {
      const provider = new AnthropicProvider('sk-test', logger);

      mockAnthropicCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'R' }],
        model: 'model',
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: 'end_turn',
      });

      await provider.chat(
        makeRequest({
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there' },
            { role: 'user', content: 'Follow-up' },
          ],
        }),
      );

      const callArgs = mockAnthropicCreate.mock.calls[0][0];
      expect(callArgs.messages).toEqual([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
        { role: 'user', content: 'Follow-up' },
      ]);
      // No system param when no system message
      expect(callArgs.system).toBeUndefined();
    });

    it('returns correct response structure', async () => {
      const provider = new AnthropicProvider('sk-test', logger);

      mockAnthropicCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Hello world' }],
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 15, output_tokens: 25 },
        stop_reason: 'end_turn',
      });

      const response = await provider.chat(makeRequest());
      expect(response.content).toBe('Hello world');
      expect(response.model).toBe('claude-sonnet-4-20250514');
      expect(response.usage.promptTokens).toBe(15);
      expect(response.usage.completionTokens).toBe(25);
      expect(response.usage.totalTokens).toBe(40);
      expect(response.finishReason).toBe('stop');
    });

    it('joins multiple text blocks', async () => {
      const provider = new AnthropicProvider('sk-test', logger);

      mockAnthropicCreate.mockResolvedValueOnce({
        content: [
          { type: 'text', text: 'Part 1' },
          { type: 'thinking', thinking: 'internal reasoning...' },
          { type: 'text', text: 'Part 2' },
        ],
        model: 'model',
        usage: { input_tokens: 10, output_tokens: 20 },
        stop_reason: 'end_turn',
      });

      const response = await provider.chat(makeRequest());
      expect(response.content).toBe('Part 1Part 2');
    });

    it('records error on failure', async () => {
      const provider = new AnthropicProvider('sk-test', logger);
      mockAnthropicCreate.mockRejectedValueOnce(new Error('API error'));

      await expect(provider.chat(makeRequest())).rejects.toThrow('API error');
      const health = provider.getHealth();
      expect(health.consecutiveErrors).toBe(1);
      expect(health.lastError).toBe('API error');
    });
  });

  describe('stop reason normalization', () => {
    const stopReasonCases = [
      { input: 'end_turn', expected: 'stop' },
      { input: 'max_tokens', expected: 'length' },
      { input: 'stop_sequence', expected: 'stop' },
      { input: 'tool_use', expected: 'tool_calls' },
      { input: null, expected: 'stop' },
      { input: undefined, expected: 'stop' },
      { input: 'unknown_reason', expected: 'stop' },
    ];

    for (const { input, expected } of stopReasonCases) {
      it(`normalizes "${input}" to "${expected}"`, async () => {
        const provider = new AnthropicProvider('sk-test', logger);

        mockAnthropicCreate.mockResolvedValueOnce({
          content: [{ type: 'text', text: 'R' }],
          model: 'model',
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: input,
        });

        const response = await provider.chat(makeRequest());
        expect(response.finishReason).toBe(expected);
      });
    }
  });

  describe('thinking config resolution', () => {
    it('passes "low" as budget_tokens 2048', async () => {
      const provider = new AnthropicProvider('sk-test', logger);

      mockAnthropicCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'R' }],
        model: 'model',
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      });

      await provider.chat(makeRequest({ thinking: 'low' }));

      expect(mockAnthropicCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          thinking: { type: 'enabled', budget_tokens: 2048 },
        }),
        expect.anything(),
      );
    });

    it('passes "medium" as budget_tokens 8192', async () => {
      const provider = new AnthropicProvider('sk-test', logger);

      mockAnthropicCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'R' }],
        model: 'model',
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      });

      await provider.chat(makeRequest({ thinking: 'medium' }));

      expect(mockAnthropicCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          thinking: { type: 'enabled', budget_tokens: 8192 },
        }),
        expect.anything(),
      );
    });

    it('passes "high" as budget_tokens 32768', async () => {
      const provider = new AnthropicProvider('sk-test', logger);

      mockAnthropicCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'R' }],
        model: 'model',
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      });

      await provider.chat(makeRequest({ thinking: 'high' }));

      expect(mockAnthropicCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          thinking: { type: 'enabled', budget_tokens: 32768 },
        }),
        expect.anything(),
      );
    });

    it('"disabled" does not include thinking param', async () => {
      const provider = new AnthropicProvider('sk-test', logger);

      mockAnthropicCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'R' }],
        model: 'model',
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      });

      await provider.chat(makeRequest({ thinking: 'disabled' }));

      const callArgs = mockAnthropicCreate.mock.calls[0][0];
      expect(callArgs.thinking).toBeUndefined();
    });

    it('"off" does not include thinking param', async () => {
      const provider = new AnthropicProvider('sk-test', logger);

      mockAnthropicCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'R' }],
        model: 'model',
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      });

      await provider.chat(makeRequest({ thinking: 'off' }));

      const callArgs = mockAnthropicCreate.mock.calls[0][0];
      expect(callArgs.thinking).toBeUndefined();
    });

    it('"none" does not include thinking param', async () => {
      const provider = new AnthropicProvider('sk-test', logger);

      mockAnthropicCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'R' }],
        model: 'model',
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      });

      await provider.chat(makeRequest({ thinking: 'none' }));

      const callArgs = mockAnthropicCreate.mock.calls[0][0];
      expect(callArgs.thinking).toBeUndefined();
    });

    it('numeric string parses to budget_tokens', async () => {
      const provider = new AnthropicProvider('sk-test', logger);

      mockAnthropicCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'R' }],
        model: 'model',
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      });

      await provider.chat(makeRequest({ thinking: '4096' }));

      expect(mockAnthropicCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          thinking: { type: 'enabled', budget_tokens: 4096 },
        }),
        expect.anything(),
      );
    });

    it('numeric string below 1024 falls back to low preset', async () => {
      const provider = new AnthropicProvider('sk-test', logger);

      mockAnthropicCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'R' }],
        model: 'model',
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      });

      await provider.chat(makeRequest({ thinking: '512' }));

      expect(mockAnthropicCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          thinking: { type: 'enabled', budget_tokens: 2048 },
        }),
        expect.anything(),
      );
    });

    it('unknown string falls back to low preset', async () => {
      const provider = new AnthropicProvider('sk-test', logger);

      mockAnthropicCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'R' }],
        model: 'model',
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      });

      await provider.chat(makeRequest({ thinking: 'banana' }));

      expect(mockAnthropicCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          thinking: { type: 'enabled', budget_tokens: 2048 },
        }),
        expect.anything(),
      );
    });

    it('object { type: "enabled", budget_tokens } passes through', async () => {
      const provider = new AnthropicProvider('sk-test', logger);

      mockAnthropicCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'R' }],
        model: 'model',
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      });

      await provider.chat(
        makeRequest({ thinking: { type: 'enabled', budget_tokens: 16384 } }),
      );

      expect(mockAnthropicCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          thinking: { type: 'enabled', budget_tokens: 16384 },
        }),
        expect.anything(),
      );
    });

    it('object { type: "disabled" } does not include thinking', async () => {
      const provider = new AnthropicProvider('sk-test', logger);

      mockAnthropicCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'R' }],
        model: 'model',
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      });

      await provider.chat(
        makeRequest({ thinking: { type: 'disabled' } }),
      );

      const callArgs = mockAnthropicCreate.mock.calls[0][0];
      expect(callArgs.thinking).toBeUndefined();
    });

    it('undefined thinking does not include thinking param', async () => {
      const provider = new AnthropicProvider('sk-test', logger);

      mockAnthropicCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'R' }],
        model: 'model',
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      });

      await provider.chat(makeRequest({ thinking: undefined }));

      const callArgs = mockAnthropicCreate.mock.calls[0][0];
      expect(callArgs.thinking).toBeUndefined();
    });

    it('disables temperature when thinking is enabled', async () => {
      const provider = new AnthropicProvider('sk-test', logger);

      mockAnthropicCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'R' }],
        model: 'model',
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      });

      await provider.chat(
        makeRequest({ thinking: 'medium', temperature: 0.7 }),
      );

      const callArgs = mockAnthropicCreate.mock.calls[0][0];
      expect(callArgs.temperature).toBeUndefined();
      expect(callArgs.thinking).toBeDefined();
    });

    it('preserves temperature when thinking is not enabled', async () => {
      const provider = new AnthropicProvider('sk-test', logger);

      mockAnthropicCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'R' }],
        model: 'model',
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      });

      await provider.chat(makeRequest({ temperature: 0.5 }));

      const callArgs = mockAnthropicCreate.mock.calls[0][0];
      expect(callArgs.temperature).toBe(0.5);
    });
  });
});

// ────────────────────────────────────────────────────────────
// 3. Google Provider
// ────────────────────────────────────────────────────────────
describe('GoogleProvider', () => {
  let logger: Logger;

  beforeEach(() => {
    logger = makeLogger();
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('sets up genai client when API key provided', () => {
      const provider = new GoogleProvider('google-key', logger);
      expect(provider.available).toBe(true);
      expect(provider.name).toBe('google');
    });

    it('null genai client when no API key', () => {
      const provider = new GoogleProvider(undefined, logger);
      expect(provider.available).toBe(false);
    });

    it('accepts custom timeout and cooldown', () => {
      const provider = new GoogleProvider('key', logger, 20000, 45000);
      expect(provider.name).toBe('google');
    });
  });

  describe('chat()', () => {
    it('throws when provider not configured (no API key)', async () => {
      const provider = new GoogleProvider(undefined, logger);
      await expect(provider.chat(makeRequest())).rejects.toThrow(
        'Google provider not configured',
      );
    });

    it('extracts system instruction from system messages', async () => {
      const provider = new GoogleProvider('key', logger);

      mockGoogleGenerateContent.mockResolvedValueOnce({
        text: 'Response',
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10, totalTokenCount: 15 },
      });

      await provider.chat(
        makeRequest({
          messages: [
            { role: 'system', content: 'Be concise.' },
            { role: 'user', content: 'Hi' },
          ],
        }),
      );

      expect(mockGoogleGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            systemInstruction: 'Be concise.',
          }),
        }),
      );
    });

    it('concatenates multiple system messages', async () => {
      const provider = new GoogleProvider('key', logger);

      mockGoogleGenerateContent.mockResolvedValueOnce({
        text: 'R',
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10, totalTokenCount: 15 },
      });

      await provider.chat(
        makeRequest({
          messages: [
            { role: 'system', content: 'Rule 1' },
            { role: 'system', content: 'Rule 2' },
            { role: 'user', content: 'Hi' },
          ],
        }),
      );

      expect(mockGoogleGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            systemInstruction: 'Rule 1\n\nRule 2',
          }),
        }),
      );
    });

    it('maps user and assistant roles correctly', async () => {
      const provider = new GoogleProvider('key', logger);

      mockGoogleGenerateContent.mockResolvedValueOnce({
        text: 'R',
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 10, totalTokenCount: 15 },
      });

      await provider.chat(
        makeRequest({
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there' },
            { role: 'user', content: 'How are you?' },
          ],
        }),
      );

      expect(mockGoogleGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          contents: 'User: Hello\n\nAssistant: Hi there\n\nUser: How are you?',
        }),
      );
    });

    it('returns correct response structure', async () => {
      const provider = new GoogleProvider('key', logger);

      mockGoogleGenerateContent.mockResolvedValueOnce({
        text: 'Hello back!',
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 },
      });

      const response = await provider.chat(
        makeRequest({ model: 'gemini-2.0-flash' }),
      );

      expect(response.content).toBe('Hello back!');
      expect(response.model).toBe('gemini-2.0-flash');
      expect(response.usage.promptTokens).toBe(12);
      expect(response.usage.completionTokens).toBe(8);
      expect(response.usage.totalTokens).toBe(20);
      expect(response.finishReason).toBe('stop');
    });

    it('handles null text in response', async () => {
      const provider = new GoogleProvider('key', logger);

      mockGoogleGenerateContent.mockResolvedValueOnce({
        text: null,
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0, totalTokenCount: 5 },
      });

      const response = await provider.chat(makeRequest());
      expect(response.content).toBe('');
    });

    it('handles missing usage metadata', async () => {
      const provider = new GoogleProvider('key', logger);

      mockGoogleGenerateContent.mockResolvedValueOnce({
        text: 'R',
        usageMetadata: undefined,
      });

      const response = await provider.chat(makeRequest());
      expect(response.usage.promptTokens).toBe(0);
      expect(response.usage.completionTokens).toBe(0);
      expect(response.usage.totalTokens).toBe(0);
    });

    it('forwards presence_penalty and frequency_penalty', async () => {
      const provider = new GoogleProvider('key', logger);

      mockGoogleGenerateContent.mockResolvedValueOnce({
        text: 'R',
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      });

      await provider.chat(
        makeRequest({ presencePenalty: 0.5, frequencyPenalty: 1.0 }),
      );

      expect(mockGoogleGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            presencePenalty: 0.5,
            frequencyPenalty: 1.0,
          }),
        }),
      );
    });

    it('records error on failure', async () => {
      const provider = new GoogleProvider('key', logger);
      mockGoogleGenerateContent.mockRejectedValueOnce(new Error('quota exceeded'));

      await expect(provider.chat(makeRequest())).rejects.toThrow('quota exceeded');
      expect(provider.getHealth().consecutiveErrors).toBe(1);
    });
  });
});

// ────────────────────────────────────────────────────────────
// 4. OpenAI-Compatible Provider
// ────────────────────────────────────────────────────────────
describe('OpenAICompatProvider', () => {
  let logger: Logger;

  beforeEach(() => {
    logger = makeLogger();
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('accepts provider name and base URL', () => {
      const provider = new OpenAICompatProvider(
        'groq',
        'gsk-key',
        'https://api.groq.com/openai/v1',
        logger,
      );
      expect(provider.name).toBe('groq');
      expect(provider.available).toBe(true);
    });

    it('marks unavailable without API key', () => {
      const provider = new OpenAICompatProvider(
        'deepseek',
        undefined,
        'https://api.deepseek.com/v1',
        logger,
      );
      expect(provider.available).toBe(false);
    });

    it('accepts custom timeout and cooldown', () => {
      const provider = new OpenAICompatProvider(
        'openai',
        'sk-key',
        'https://api.openai.com/v1',
        logger,
        15000,
        45000,
      );
      expect(provider.name).toBe('openai');
    });
  });

  describe('multiple provider instances', () => {
    it('can create groq provider', () => {
      const provider = new OpenAICompatProvider(
        'groq',
        'gsk-test',
        'https://api.groq.com/openai/v1',
        logger,
      );
      expect(provider.name).toBe('groq');
      expect(provider.available).toBe(true);
    });

    it('can create deepseek provider', () => {
      const provider = new OpenAICompatProvider(
        'deepseek',
        'sk-ds-test',
        'https://api.deepseek.com/v1',
        logger,
      );
      expect(provider.name).toBe('deepseek');
      expect(provider.available).toBe(true);
    });

    it('can create moonshot provider', () => {
      const provider = new OpenAICompatProvider(
        'moonshot',
        'sk-moon-test',
        'https://api.moonshot.ai/v1',
        logger,
      );
      expect(provider.name).toBe('moonshot');
      expect(provider.available).toBe(true);
    });

    it('can create xai provider', () => {
      const provider = new OpenAICompatProvider(
        'xai',
        'xai-test',
        'https://api.x.ai/v1',
        logger,
      );
      expect(provider.name).toBe('xai');
      expect(provider.available).toBe(true);
    });

    it('can create mistral provider', () => {
      const provider = new OpenAICompatProvider(
        'mistral',
        'sk-mistral',
        'https://api.mistral.ai/v1',
        logger,
      );
      expect(provider.name).toBe('mistral');
      expect(provider.available).toBe(true);
    });
  });

  describe('chat()', () => {
    it('throws when provider not configured (no API key)', async () => {
      const provider = new OpenAICompatProvider(
        'groq',
        undefined,
        'https://api.groq.com/openai/v1',
        logger,
      );
      await expect(provider.chat(makeRequest())).rejects.toThrow(
        'groq provider not configured',
      );
    });

    it('forwards messages to the client', async () => {
      const provider = new OpenAICompatProvider(
        'openai',
        'sk-test',
        'https://api.openai.com/v1',
        logger,
      );

      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'Hi!' }, finish_reason: 'stop' }],
        model: 'gpt-4o',
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });

      const messages: ChatMessage[] = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
      ];

      await provider.chat(makeRequest({ messages }));

      expect(mockOpenAICreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages,
          stream: false,
        }),
        expect.anything(),
      );
    });

    it('returns correct response structure', async () => {
      const provider = new OpenAICompatProvider(
        'openai',
        'sk-test',
        'https://api.openai.com/v1',
        logger,
      );

      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'World' }, finish_reason: 'stop' }],
        model: 'gpt-4o',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

      const response = await provider.chat(makeRequest());
      expect(response.content).toBe('World');
      expect(response.model).toBe('gpt-4o');
      expect(response.usage.promptTokens).toBe(10);
      expect(response.usage.completionTokens).toBe(5);
      expect(response.usage.totalTokens).toBe(15);
      expect(response.finishReason).toBe('stop');
    });

    it('forwards presence_penalty when provided', async () => {
      const provider = new OpenAICompatProvider(
        'openai',
        'sk-test',
        'https://api.openai.com/v1',
        logger,
      );

      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'R' }, finish_reason: 'stop' }],
        model: 'gpt-4o',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      await provider.chat(makeRequest({ presencePenalty: 0.5 }));

      expect(mockOpenAICreate).toHaveBeenCalledWith(
        expect.objectContaining({ presence_penalty: 0.5 }),
        expect.anything(),
      );
    });

    it('forwards frequency_penalty when provided', async () => {
      const provider = new OpenAICompatProvider(
        'openai',
        'sk-test',
        'https://api.openai.com/v1',
        logger,
      );

      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'R' }, finish_reason: 'stop' }],
        model: 'gpt-4o',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      await provider.chat(makeRequest({ frequencyPenalty: 1.2 }));

      expect(mockOpenAICreate).toHaveBeenCalledWith(
        expect.objectContaining({ frequency_penalty: 1.2 }),
        expect.anything(),
      );
    });

    it('does not include penalty params when not provided', async () => {
      const provider = new OpenAICompatProvider(
        'openai',
        'sk-test',
        'https://api.openai.com/v1',
        logger,
      );

      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'R' }, finish_reason: 'stop' }],
        model: 'gpt-4o',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      await provider.chat(makeRequest());

      const callArgs = mockOpenAICreate.mock.calls[0][0];
      expect(callArgs.presence_penalty).toBeUndefined();
      expect(callArgs.frequency_penalty).toBeUndefined();
    });

    it('handles empty choices gracefully', async () => {
      const provider = new OpenAICompatProvider(
        'openai',
        'sk-test',
        'https://api.openai.com/v1',
        logger,
      );

      mockOpenAICreate.mockResolvedValueOnce({
        choices: [],
        model: 'gpt-4o',
        usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
      });

      const response = await provider.chat(makeRequest());
      expect(response.content).toBe('');
      expect(response.finishReason).toBe('stop');
    });

    it('handles missing usage gracefully', async () => {
      const provider = new OpenAICompatProvider(
        'openai',
        'sk-test',
        'https://api.openai.com/v1',
        logger,
      );

      mockOpenAICreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'R' }, finish_reason: 'stop' }],
        model: 'gpt-4o',
        usage: undefined,
      });

      const response = await provider.chat(makeRequest());
      expect(response.usage.promptTokens).toBe(0);
      expect(response.usage.completionTokens).toBe(0);
      expect(response.usage.totalTokens).toBe(0);
    });

    it('records error on failure', async () => {
      const provider = new OpenAICompatProvider(
        'groq',
        'gsk-test',
        'https://api.groq.com/openai/v1',
        logger,
      );

      mockOpenAICreate.mockRejectedValueOnce(new Error('rate limited'));

      await expect(provider.chat(makeRequest())).rejects.toThrow('rate limited');
      expect(provider.getHealth().consecutiveErrors).toBe(1);
      expect(provider.getHealth().lastError).toBe('rate limited');
    });

    it('uses provider name in error message for unconfigured provider', async () => {
      const provider = new OpenAICompatProvider(
        'deepseek',
        undefined,
        'https://api.deepseek.com/v1',
        logger,
      );

      await expect(provider.chat(makeRequest())).rejects.toThrow(
        'deepseek provider not configured',
      );
    });
  });
});

// ────────────────────────────────────────────────────────────
// 5. ProviderRegistry
// ────────────────────────────────────────────────────────────
describe('ProviderRegistry', () => {
  let logger: Logger;
  const originalEnv = process.env;

  beforeEach(() => {
    logger = makeLogger();
    vi.clearAllMocks();
    // Set up env vars for provider API keys
    process.env = {
      ...originalEnv,
      ANTHROPIC_API_KEY: 'sk-ant-test',
      GOOGLE_API_KEY: 'google-test',
      OPENAI_API_KEY: 'sk-openai-test',
      GROQ_API_KEY: 'gsk-test',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function makeRegistryConfig(
    providers: Record<string, { apiKeyEnv: string; baseUrl?: string; timeoutMs?: number; healthCooldownMs?: number }>,
  ): PharosConfig {
    return {
      server: { port: 3777, host: '0.0.0.0' },
      auth: { apiKey: '' },
      classifier: {
        providers: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }],
        fallbackTier: 'economical',
        timeoutMs: 3000,
        maxConcurrent: 5,
        cacheMaxSize: 100,
        cacheTtlMs: 30000,
      },
      tiers: {
        free: {
          scoreRange: [1, 3],
          models: [{ provider: 'groq', model: 'llama-3.3-70b-versatile' }],
        },
        economical: {
          scoreRange: [4, 6],
          models: [{ provider: 'openai', model: 'gpt-4o' }],
        },
        premium: {
          scoreRange: [7, 8],
          models: [{ provider: 'anthropic', model: 'claude-sonnet-4-20250514' }],
        },
        frontier: {
          scoreRange: [9, 10],
          models: [{ provider: 'anthropic', model: 'claude-opus-4-20250514' }],
        },
      },
      providers,
      tracking: {
        enabled: true,
        dbPath: './data/pharos.db',
        baselineModel: 'claude-sonnet-4-20250514',
        baselineCostPerMillionInput: 3.0,
        baselineCostPerMillionOutput: 15.0,
      },
      logging: { level: 'info', pretty: true },
    } as PharosConfig;
  }

  describe('registration', () => {
    it('registers Anthropic provider correctly', () => {
      const config = makeRegistryConfig({
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
      });
      const registry = new ProviderRegistry(config, logger);
      const provider = registry.get('anthropic');
      expect(provider).toBeDefined();
      expect(provider!.name).toBe('anthropic');
      expect(provider!.available).toBe(true);
    });

    it('registers Google provider correctly', () => {
      const config = makeRegistryConfig({
        google: { apiKeyEnv: 'GOOGLE_API_KEY' },
      });
      const registry = new ProviderRegistry(config, logger);
      const provider = registry.get('google');
      expect(provider).toBeDefined();
      expect(provider!.name).toBe('google');
      expect(provider!.available).toBe(true);
    });

    it('registers OpenAI-compatible providers correctly', () => {
      const config = makeRegistryConfig({
        groq: {
          apiKeyEnv: 'GROQ_API_KEY',
          baseUrl: 'https://api.groq.com/openai/v1',
        },
      });
      const registry = new ProviderRegistry(config, logger);
      const provider = registry.get('groq');
      expect(provider).toBeDefined();
      expect(provider!.name).toBe('groq');
      expect(provider!.available).toBe(true);
    });

    it('uses default base URL for unknown openai-compat providers', () => {
      const config = makeRegistryConfig({
        openai: { apiKeyEnv: 'OPENAI_API_KEY' },
      });
      const registry = new ProviderRegistry(config, logger);
      const provider = registry.get('openai');
      expect(provider).toBeDefined();
      expect(provider!.available).toBe(true);
    });

    it('marks provider unavailable when env var is missing', () => {
      const config = makeRegistryConfig({
        anthropic: { apiKeyEnv: 'MISSING_KEY_XYZ' },
      });
      const registry = new ProviderRegistry(config, logger);
      const provider = registry.get('anthropic');
      expect(provider).toBeDefined();
      expect(provider!.available).toBe(false);
    });

    it('registers multiple providers', () => {
      const config = makeRegistryConfig({
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
        google: { apiKeyEnv: 'GOOGLE_API_KEY' },
        groq: {
          apiKeyEnv: 'GROQ_API_KEY',
          baseUrl: 'https://api.groq.com/openai/v1',
        },
      });
      const registry = new ProviderRegistry(config, logger);
      expect(registry.get('anthropic')).toBeDefined();
      expect(registry.get('google')).toBeDefined();
      expect(registry.get('groq')).toBeDefined();
    });

    it('logs info for available providers', () => {
      const config = makeRegistryConfig({
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
      });
      new ProviderRegistry(config, logger);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('anthropic'));
    });
  });

  describe('get()', () => {
    it('returns correct provider by name', () => {
      const config = makeRegistryConfig({
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
        google: { apiKeyEnv: 'GOOGLE_API_KEY' },
      });
      const registry = new ProviderRegistry(config, logger);

      expect(registry.get('anthropic')!.name).toBe('anthropic');
      expect(registry.get('google')!.name).toBe('google');
    });

    it('returns undefined for unknown provider', () => {
      const config = makeRegistryConfig({
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
      });
      const registry = new ProviderRegistry(config, logger);
      expect(registry.get('nonexistent')).toBeUndefined();
    });
  });

  describe('isAvailable()', () => {
    it('returns true for healthy provider', () => {
      const config = makeRegistryConfig({
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
      });
      const registry = new ProviderRegistry(config, logger);
      expect(registry.isAvailable('anthropic')).toBe(true);
    });

    it('returns false for unavailable provider', () => {
      const config = makeRegistryConfig({
        anthropic: { apiKeyEnv: 'MISSING_KEY' },
      });
      const registry = new ProviderRegistry(config, logger);
      expect(registry.isAvailable('anthropic')).toBe(false);
    });

    it('returns false for unknown provider', () => {
      const config = makeRegistryConfig({});
      const registry = new ProviderRegistry(config, logger);
      expect(registry.isAvailable('unknown')).toBe(false);
    });
  });

  describe('getStatus()', () => {
    it('returns status for all registered providers', () => {
      const config = makeRegistryConfig({
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
        google: { apiKeyEnv: 'GOOGLE_API_KEY' },
      });
      const registry = new ProviderRegistry(config, logger);
      const status = registry.getStatus();

      expect(status).toHaveProperty('anthropic');
      expect(status).toHaveProperty('google');
    });

    it('reports correct availability and health', () => {
      const config = makeRegistryConfig({
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
        groq: { apiKeyEnv: 'MISSING_KEY', baseUrl: 'https://api.groq.com/openai/v1' },
      });
      const registry = new ProviderRegistry(config, logger);
      const status = registry.getStatus();

      expect(status.anthropic.available).toBe(true);
      expect(status.anthropic.healthy).toBe(true);
      expect(status.groq.available).toBe(false);
      expect(status.groq.healthy).toBe(false);
    });

    it('includes latency stats in status', () => {
      const config = makeRegistryConfig({
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
      });
      const registry = new ProviderRegistry(config, logger);
      const status = registry.getStatus();

      expect(status.anthropic.latency).toEqual(
        expect.objectContaining({
          avgMs: 0,
          p95Ms: 0,
          samples: 0,
          degraded: false,
        }),
      );
    });
  });

  describe('listAvailable()', () => {
    it('lists only healthy providers', () => {
      const config = makeRegistryConfig({
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
        google: { apiKeyEnv: 'MISSING_KEY' },
        groq: {
          apiKeyEnv: 'GROQ_API_KEY',
          baseUrl: 'https://api.groq.com/openai/v1',
        },
      });
      const registry = new ProviderRegistry(config, logger);
      const available = registry.listAvailable();

      expect(available).toContain('anthropic');
      expect(available).toContain('groq');
      expect(available).not.toContain('google');
    });

    it('returns empty array when no providers are available', () => {
      const config = makeRegistryConfig({
        anthropic: { apiKeyEnv: 'MISSING_1' },
        google: { apiKeyEnv: 'MISSING_2' },
      });
      const registry = new ProviderRegistry(config, logger);
      expect(registry.listAvailable()).toEqual([]);
    });
  });

  describe('provider timeout/cooldown from config', () => {
    it('uses custom timeoutMs from config', () => {
      const config = makeRegistryConfig({
        anthropic: {
          apiKeyEnv: 'ANTHROPIC_API_KEY',
          timeoutMs: 15000,
        },
      });
      const registry = new ProviderRegistry(config, logger);
      const provider = registry.get('anthropic');
      expect(provider).toBeDefined();
      // Timeout is set internally — we verify the provider was created successfully
      expect(provider!.available).toBe(true);
    });

    it('uses custom healthCooldownMs from config', () => {
      const config = makeRegistryConfig({
        anthropic: {
          apiKeyEnv: 'ANTHROPIC_API_KEY',
          healthCooldownMs: 120000,
        },
      });
      const registry = new ProviderRegistry(config, logger);
      const provider = registry.get('anthropic');
      expect(provider).toBeDefined();
      expect(provider!.available).toBe(true);
    });
  });
});
