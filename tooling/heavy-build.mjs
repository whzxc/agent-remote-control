import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Re-enter the same script under a kernel lock. Nested build steps share its lifetime.
export function enterHeavyBuild() {
  if (process.env.ARC_HEAVY_BUILD_HELD === '1') return;
  const root = fileURLToPath(new URL('../', import.meta.url));
  const commonGit = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
  const cache = path.join(commonGit, 'build-tools');
  mkdirSync(cache, { recursive: true });
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim();
  const label = `${branch || 'detached'} at ${root} (${process.env.npm_lifecycle_event || path.basename(process.argv[1])})`;
  const result = spawnSync('go', ['run', './tooling/build-lock', path.join(cache, 'heavy-build.lock'), label, process.execPath, ...process.argv.slice(1)], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
