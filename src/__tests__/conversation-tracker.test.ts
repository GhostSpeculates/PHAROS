import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    ConversationTracker,
    applyTierFloor,
    TIER_RANK,
    RANK_TO_TIER,
} from '../router/conversation-tracker.js';

// ─── Constants ──────────────────────────────────────────

describe('TIER_RANK', () => {
    it('assigns increasing ranks to tiers', () => {
        expect(TIER_RANK.free).toBe(0);
        expect(TIER_RANK.economical).toBe(1);
        expect(TIER_RANK.premium).toBe(2);
        expect(TIER_RANK.frontier).toBe(3);
    });
});

describe('RANK_TO_TIER', () => {
    it('maps rank numbers back to tier names', () => {
        expect(RANK_TO_TIER[0]).toBe('free');
        expect(RANK_TO_TIER[1]).toBe('economical');
        expect(RANK_TO_TIER[2]).toBe('premium');
        expect(RANK_TO_TIER[3]).toBe('frontier');
    });
});

// ─── applyTierFloor ─────────────────────────────────────

describe('applyTierFloor', () => {
    it('returns classifier tier when it is above the floor', () => {
        expect(applyTierFloor('premium', 'economical')).toBe('premium');
    });

    it('returns classifier tier when equal to the floor', () => {
        expect(applyTierFloor('economical', 'economical')).toBe('economical');
    });

    it('returns floor tier when classifier tier is below', () => {
        expect(applyTierFloor('free', 'economical')).toBe('economical');
    });

    it('elevates free to premium when floor is premium', () => {
        expect(applyTierFloor('free', 'premium')).toBe('premium');
    });

    it('does not elevate frontier', () => {
        expect(applyTierFloor('frontier', 'free')).toBe('frontier');
    });

    it('handles floor at frontier', () => {
        expect(applyTierFloor('economical', 'frontier')).toBe('frontier');
    });
});

// ─── ConversationTracker ────────────────────────────────

describe('ConversationTracker', () => {
    let tracker: ConversationTracker;

    beforeEach(() => {
        tracker = new ConversationTracker({ maxSize: 10, ttlMs: 60_000 });
    });

    // ─── recordTier / getInfo ───

    it('records a new conversation', () => {
        tracker.recordTier('conv-1', 'premium');
        const info = tracker.getInfo('conv-1');
        expect(info).toEqual({
            highestTier: 'premium',
            tierFloor: 'economical',
            requestCount: 1,
        });
    });

    it('increments request count on repeated calls', () => {
        tracker.recordTier('conv-1', 'free');
        tracker.recordTier('conv-1', 'free');
        tracker.recordTier('conv-1', 'free');
        const info = tracker.getInfo('conv-1');
        expect(info?.requestCount).toBe(3);
    });

    it('updates highest tier when a higher tier is used', () => {
        tracker.recordTier('conv-1', 'economical');
        tracker.recordTier('conv-1', 'premium');
        const info = tracker.getInfo('conv-1');
        expect(info?.highestTier).toBe('premium');
    });

    it('does not downgrade highest tier', () => {
        tracker.recordTier('conv-1', 'frontier');
        tracker.recordTier('conv-1', 'free');
        const info = tracker.getInfo('conv-1');
        expect(info?.highestTier).toBe('frontier');
    });

    it('tracks multiple conversations independently', () => {
        tracker.recordTier('conv-a', 'free');
        tracker.recordTier('conv-b', 'premium');
        expect(tracker.getInfo('conv-a')?.highestTier).toBe('free');
        expect(tracker.getInfo('conv-b')?.highestTier).toBe('premium');
    });

    // ─── getTierFloor ───

    it('returns null for unknown conversation', () => {
        expect(tracker.getTierFloor('unknown')).toBeNull();
    });

    it('returns free floor for free highest tier', () => {
        tracker.recordTier('conv-1', 'free');
        expect(tracker.getTierFloor('conv-1')).toBe('free');
    });

    it('returns free floor for economical highest tier', () => {
        tracker.recordTier('conv-1', 'economical');
        expect(tracker.getTierFloor('conv-1')).toBe('free');
    });

    it('returns economical floor for premium highest tier', () => {
        tracker.recordTier('conv-1', 'premium');
        expect(tracker.getTierFloor('conv-1')).toBe('economical');
    });

    it('returns premium floor for frontier highest tier', () => {
        tracker.recordTier('conv-1', 'frontier');
        expect(tracker.getTierFloor('conv-1')).toBe('premium');
    });

    it('floor evolves as highest tier increases', () => {
        tracker.recordTier('conv-1', 'free');
        expect(tracker.getTierFloor('conv-1')).toBe('free');

        tracker.recordTier('conv-1', 'premium');
        expect(tracker.getTierFloor('conv-1')).toBe('economical');

        tracker.recordTier('conv-1', 'frontier');
        expect(tracker.getTierFloor('conv-1')).toBe('premium');
    });

    // ─── getInfo ───

    it('returns null for unknown conversation', () => {
        expect(tracker.getInfo('unknown')).toBeNull();
    });

    it('returns full info with tier floor computed', () => {
        tracker.recordTier('conv-1', 'frontier');
        tracker.recordTier('conv-1', 'economical');
        const info = tracker.getInfo('conv-1');
        expect(info).toEqual({
            highestTier: 'frontier',
            tierFloor: 'premium',
            requestCount: 2,
        });
    });

    // ─── LRU eviction ───

    it('evicts oldest conversations when maxSize is exceeded', () => {
        const small = new ConversationTracker({ maxSize: 2, ttlMs: 60_000 });
        small.recordTier('conv-1', 'free');
        small.recordTier('conv-2', 'economical');
        small.recordTier('conv-3', 'premium'); // should evict conv-1
        expect(small.getInfo('conv-1')).toBeNull();
        expect(small.getInfo('conv-2')).not.toBeNull();
        expect(small.getInfo('conv-3')).not.toBeNull();
    });

    // ─── TTL expiry ───

    it('expires conversations after TTL', () => {
        vi.useFakeTimers();
        const short = new ConversationTracker({ maxSize: 10, ttlMs: 100 });
        short.recordTier('conv-1', 'premium');
        expect(short.getInfo('conv-1')).not.toBeNull();

        vi.advanceTimersByTime(150);
        expect(short.getInfo('conv-1')).toBeNull();
        expect(short.getTierFloor('conv-1')).toBeNull();

        vi.useRealTimers();
    });
});
