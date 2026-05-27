import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';

const CONTAINER_NAME = 'pharos-test-postgres';
const POSTGRES_PORT = 54329; // arbitrary free port to avoid conflicts
const POSTGRES_PASSWORD = 'pharos_test';

function run(cmd: string, args: string[]): { code: number; stdout: string; stderr: string } {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export async function startTestPostgres(): Promise<string> {
    // Clean any leftover container
    run('docker', ['rm', '-f', CONTAINER_NAME]);

    // Boot container
    const startResult = run('docker', [
        'run', '-d',
        '--name', CONTAINER_NAME,
        '-p', `${POSTGRES_PORT}:5432`,
        '-e', `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
        '-e', 'POSTGRES_DB=pharos_test',
        'postgres:16-alpine',
    ]);
    if (startResult.code !== 0) {
        throw new Error(`Failed to start Docker Postgres: ${startResult.stderr}`);
    }

    const url = `postgresql://postgres:${POSTGRES_PASSWORD}@localhost:${POSTGRES_PORT}/pharos_test`;

    // Wait for Postgres to be ready (poll pg_isready inside the container)
    for (let i = 0; i < 30; i++) {
        const ready = run('docker', ['exec', CONTAINER_NAME, 'pg_isready', '-U', 'postgres']);
        if (ready.code === 0) break;
        await new Promise(r => setTimeout(r, 500));
        if (i === 29) throw new Error('Postgres did not become ready within 15s');
    }

    // Apply schema
    const schemaPath = resolve(process.cwd(), 'db/schema.sql');
    const schemaSql = await fs.readFile(schemaPath, 'utf8');
    const applyResult = spawnSync('docker', [
        'exec', '-i', CONTAINER_NAME, 'psql', '-U', 'postgres', '-d', 'pharos_test',
    ], { input: schemaSql, encoding: 'utf8' });
    if (applyResult.status !== 0) {
        throw new Error(`Failed to apply schema: ${applyResult.stderr}`);
    }

    return url;
}

export function stopTestPostgres(): void {
    run('docker', ['rm', '-f', CONTAINER_NAME]);
}

export async function truncateAll(sqlClient: any): Promise<void> {
    await sqlClient`TRUNCATE TABLE wallet_ledger, requests, model_performance, users RESTART IDENTITY CASCADE`;
}
