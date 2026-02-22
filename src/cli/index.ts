#!/usr/bin/env node
import { Command } from 'commander';
import { startCommand } from './start.js';
import { initCommand } from './init.js';

/**
 * Pharos CLI
 */
const program = new Command();

program
    .name('pharos')
    .description('⚡ Pharos — Intelligent LLM Routing Gateway')
    .version('0.1.0');

program
    .command('start')
    .description('Start the Pharos routing server')
    .option('-p, --port <port>', 'Server port', '3777')
    .option('-c, --config <path>', 'Path to config file')
    .action(startCommand);

program
    .command('init')
    .description('Generate a pharos.yaml config file and .env template')
    .option('-f, --force', 'Overwrite existing files')
    .action(initCommand);

program.parse();
