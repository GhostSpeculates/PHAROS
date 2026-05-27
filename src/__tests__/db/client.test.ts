import { describe, it, expect } from 'vitest';
import { getSql } from '../../db/index.js';

describe('postgres client', () => {
    it('exports a getSql() factory that requires DATABASE_URL', () => {
        const prev = process.env.DATABASE_URL;
        delete process.env.DATABASE_URL;
        expect(() => getSql()).toThrow(/DATABASE_URL/);
        if (prev) process.env.DATABASE_URL = prev;
    });

    it('returns a tagged-template sql client when DATABASE_URL is set', () => {
        process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
        const sql = getSql();
        expect(typeof sql).toBe('function');
        // postgres.js clients expose .end() for graceful shutdown
        expect(typeof (sql as any).end).toBe('function');
    });
});
