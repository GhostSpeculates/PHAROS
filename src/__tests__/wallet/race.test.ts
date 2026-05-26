import { describe, it, expect, beforeEach } from 'vitest';
import postgres from 'postgres';
import { WalletStore } from '../../tracking/wallet-store.js';
import { truncateAll } from '../_helpers/test-db.js';
import type { Logger } from '../../utils/logger.js';

const silentLogger = {
    info: () => {}, warn: () => {}, error: () => {},
    debug: () => {}, fatal: () => {}, trace: () => {},
    child: function () { return this; },
} as unknown as Logger;

describe('wallet race conditions', () => {
    let sql: ReturnType<typeof postgres>;
    let store: WalletStore;

    beforeEach(async () => {
        sql = postgres(process.env.DATABASE_URL!);
        await truncateAll(sql);
        store = new WalletStore({ sql, logger: silentLogger });
    });

    it('serializes concurrent debits — no double-spend', async () => {
        const user = await store.createUser({
            email: 'race@x.com',
            apiKeyHash: 'h1',
            balanceCents: 1000,
        });

        // 20 concurrent debits of 100 cents each, budget for 10
        const debits = Array.from({ length: 20 }, (_, i) =>
            store.debit({
                userId: user.id,
                amountCents: 100,
                txnType: 'chat',
                model: 'test',
                provider: 'test',
                requestId: `req-${i}`,
            }),
        );

        const results = await Promise.allSettled(debits);
        const succeeded = results.filter(r => r.status === 'fulfilled').length;
        expect(succeeded).toBe(10);
        expect(await store.getBalanceCents(user.id)).toBe(0);

        await sql.end();
    });
});
