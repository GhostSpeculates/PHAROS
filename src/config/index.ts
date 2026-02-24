import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import dotenv from 'dotenv';
import { PharosConfigSchema, type PharosConfig } from './schema.js';

// Load .env file if it exists
dotenv.config();

/**
 * Load, merge, and validate the Pharos configuration.
 *
 * Priority (highest to lowest):
 * 1. Environment variables (PHAROS_PORT, PHAROS_API_KEY, etc.)
 * 2. User config file (pharos.yaml in project root)
 * 3. Default config (config/pharos.default.yaml)
 */
export function loadConfig(): PharosConfig {
    // 1. Load default config
    const defaultPath = path.resolve('config', 'pharos.default.yaml');
    let rawConfig: Record<string, unknown> = {};

    if (fs.existsSync(defaultPath)) {
        const content = fs.readFileSync(defaultPath, 'utf-8');
        rawConfig = parseYaml(content) ?? {};
    }

    // 2. Merge user config (if exists)
    const userConfigPath = path.resolve('pharos.yaml');
    if (fs.existsSync(userConfigPath)) {
        const userContent = fs.readFileSync(userConfigPath, 'utf-8');
        const userConfig = parseYaml(userContent) ?? {};
        rawConfig = deepMerge(rawConfig, userConfig);
    }

    // 3. Apply environment variable overrides
    applyEnvOverrides(rawConfig);

    // 4. Validate with Zod
    const result = PharosConfigSchema.safeParse(rawConfig);

    if (!result.success) {
        const errors = result.error.issues.map(
            (issue) => `  - ${issue.path.join('.')}: ${issue.message}`,
        );
        throw new Error(`Invalid Pharos configuration:\n${errors.join('\n')}`);
    }

    return result.data;
}

/**
 * Apply environment variable overrides to the raw config.
 */
function applyEnvOverrides(config: Record<string, unknown>): void {
    if (process.env.PHAROS_PORT) {
        ensureNested(config, 'server');
        (config.server as Record<string, unknown>).port = parseInt(process.env.PHAROS_PORT, 10);
    }

    if (process.env.PHAROS_HOST) {
        ensureNested(config, 'server');
        (config.server as Record<string, unknown>).host = process.env.PHAROS_HOST;
    }

    if (process.env.PHAROS_API_KEY) {
        ensureNested(config, 'auth');
        (config.auth as Record<string, unknown>).apiKey = process.env.PHAROS_API_KEY;
    }

    if (process.env.PHAROS_LOG_LEVEL) {
        ensureNested(config, 'logging');
        (config.logging as Record<string, unknown>).level = process.env.PHAROS_LOG_LEVEL;
    }
}

/**
 * Deep merge two objects. Source values overwrite target values.
 */
function deepMerge(
    target: Record<string, unknown>,
    source: Record<string, unknown>,
): Record<string, unknown> {
    const result = { ...target };

    for (const key of Object.keys(source)) {
        if (
            source[key] &&
            typeof source[key] === 'object' &&
            !Array.isArray(source[key]) &&
            target[key] &&
            typeof target[key] === 'object' &&
            !Array.isArray(target[key])
        ) {
            result[key] = deepMerge(
                target[key] as Record<string, unknown>,
                source[key] as Record<string, unknown>,
            );
        } else {
            result[key] = source[key];
        }
    }

    return result;
}

/**
 * Ensure a nested object path exists.
 */
function ensureNested(obj: Record<string, unknown>, key: string): void {
    if (!obj[key] || typeof obj[key] !== 'object') {
        obj[key] = {};
    }
}
