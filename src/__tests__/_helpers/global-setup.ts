import { startTestPostgres, stopTestPostgres } from './test-db.js';

export async function setup(): Promise<void> {
    const url = await startTestPostgres();
    process.env.DATABASE_URL = url;
    console.log(`[test-db] Postgres ready at ${url}`);
}

export async function teardown(): Promise<void> {
    stopTestPostgres();
}
