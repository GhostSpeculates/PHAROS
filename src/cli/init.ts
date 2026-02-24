import fs from 'node:fs';
import path from 'node:path';

// ANSI color helpers (no dependency needed)
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

/**
 * `pharos init` — Generate config files for getting started.
 */
export async function initCommand(options: { force?: boolean }) {
  const cwd = process.cwd();

  console.log('');
  console.log(bold('  PHAROS — Intelligent LLM Routing Gateway'));
  console.log(dim('  Initializing project configuration...\n'));

  // ── Generate pharos.yaml ──────────────────────────────
  console.log(bold('  Config'));

  const yamlDest = path.join(cwd, 'pharos.yaml');
  const yamlSource = path.resolve('config', 'pharos.default.yaml');

  if (fs.existsSync(yamlDest) && !options.force) {
    console.log(yellow('    ! pharos.yaml already exists') + dim(' (use --force to overwrite)'));
  } else if (fs.existsSync(yamlSource)) {
    fs.copyFileSync(yamlSource, yamlDest);
    console.log(green('    + Created pharos.yaml'));
  } else {
    console.log(yellow('    ! Default config not found at config/pharos.default.yaml'));
  }

  // ── Generate .env ─────────────────────────────────────
  const envDest = path.join(cwd, '.env');
  const envSource = path.resolve('.env.example');

  if (fs.existsSync(envDest) && !options.force) {
    console.log(yellow('    ! .env already exists') + dim(' (use --force to overwrite)'));
  } else if (fs.existsSync(envSource)) {
    fs.copyFileSync(envSource, envDest);
    console.log(green('    + Created .env'));
  } else {
    console.log(yellow('    ! .env.example not found'));
  }

  // ── Provider Signup Links ─────────────────────────────
  console.log('');
  console.log(bold('  Get Your API Keys'));
  console.log(
    cyan('    Groq (required)') + dim('     https://console.groq.com       — Free tier, powers classifier'),
  );
  console.log(
    cyan('    Anthropic') + dim('            https://console.anthropic.com — Claude models (premium/frontier)'),
  );
  console.log(
    cyan('    OpenAI') + dim('               https://platform.openai.com   — GPT models (all tiers)'),
  );
  console.log(
    cyan('    Google') + dim('               https://aistudio.google.com   — Gemini models (free tier)'),
  );

  // ── Next Steps ────────────────────────────────────────
  console.log('');
  console.log(bold('  Next Steps'));
  console.log(`    ${green('1.')} Edit ${cyan('.env')} and add your API keys (at minimum ${cyan('GROQ_API_KEY')} + ${cyan('PHAROS_API_KEY')})`);
  console.log(`    ${green('2.')} ${dim('(Optional)')} Edit ${cyan('pharos.yaml')} to customize tiers and models`);
  console.log(`    ${green('3.')} Run ${cyan('npm run dev')} to start the server`);
  console.log(`    ${green('4.')} Test with ${cyan('curl http://localhost:3777/health')}`);

  console.log('');
  console.log(dim('  Full setup guide: GETTING_STARTED.md'));
  console.log('');
}
