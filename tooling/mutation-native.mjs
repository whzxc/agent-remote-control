import { execFileSync, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (!args.length) throw new Error('Usage: npm run mutation:native -- internal/core/<module>.go [...]');
execFileSync(process.execPath, ['tooling/check-tests.mjs'], { stdio: 'inherit' });
const result = spawnSync('go', ['run', './tooling/go-mutation', ...args], { stdio: 'inherit', env: { ...process.env, CGO_ENABLED: '0' } });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
