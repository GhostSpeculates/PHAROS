import postgres from 'postgres';

let client: ReturnType<typeof postgres> | null = null;

/**
 * Lazy singleton accessor for the Postgres client.
 * Throws if DATABASE_URL is unset so tests can detect misconfiguration.
 */
export function getSql(): ReturnType<typeof postgres> {
    if (client) return client;
    const url = process.env.DATABASE_URL;
    if (!url) {
        throw new Error('DATABASE_URL is not set');
    }
    client = postgres(url, {
        max: 10,
        idle_timeout: 30,
        connect_timeout: 10,
    });
    return client;
}

/** For tests — close the pool and clear the singleton. */
export async function resetSql(): Promise<void> {
    if (client) {
        await client.end();
        client = null;
    }
}
