import fs from 'node:fs';
import path from 'node:path';

/**
 * `pharos init` — Generate config files for getting started.
 */
export async function initCommand(options: { force?: boolean }) {
    const cwd = process.cwd();

    // Generate pharos.yaml
    const yamlDest = path.join(cwd, 'pharos.yaml');
    const yamlSource = path.resolve('config', 'pharos.default.yaml');

    if (fs.existsSync(yamlDest) && !options.force) {
        console.log('⚠  pharos.yaml already exists (use --force to overwrite)');
    } else if (fs.existsSync(yamlSource)) {
        fs.copyFileSync(yamlSource, yamlDest);
        console.log('✓  Created pharos.yaml');
    } else {
        console.log('⚠  Default config not found at config/pharos.default.yaml');
    }

    // Generate .env
    const envDest = path.join(cwd, '.env');
    const envSource = path.resolve('.env.example');

    if (fs.existsSync(envDest) && !options.force) {
        console.log('⚠  .env already exists (use --force to overwrite)');
    } else if (fs.existsSync(envSource)) {
        fs.copyFileSync(envSource, envDest);
        console.log('✓  Created .env — fill in your API keys');
    } else {
        console.log('⚠  .env.example not found');
    }

    console.log('\nNext steps:');
    console.log('  1. Edit .env and add your API keys (at minimum GOOGLE_AI_API_KEY)');
    console.log('  2. Customize pharos.yaml if needed');
    console.log('  3. Run: npm run dev');
}
