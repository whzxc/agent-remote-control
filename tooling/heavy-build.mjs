import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Re-enter the same script under a kernel lock. Nested build steps share its lifetime.
export function enterHeavyBuild() {
  if (process.env.ARC_HEAVY_BUILD_HELD === '1') return;
  const root = fileURLToPath(new URL('../', import.meta.url));
  const source = path.join(root, 'tooling/heavy-build.rs');
  const commonGit = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
  const cache = path.join(commonGit, 'build-tools');
  const key = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 16);
  const binary = path.join(cache, `heavy-build-${key}${process.platform === 'win32' ? '.exe' : ''}`);
  mkdirSync(cache, { recursive: true });
  if (!existsSync(binary)) {
    const temporary = `${binary}-${process.pid}${process.platform === 'win32' ? '.exe' : ''}`;
    execFileSync('rustc', ['--edition=2021', '-C', 'debuginfo=0', source, '-o', temporary], { stdio: 'inherit' });
    try { renameSync(temporary, binary); }
    catch (error) {
      if (!existsSync(binary)) throw error;
      rmSync(temporary, { force: true });
    }
  }
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim();
  const label = `${branch || 'detached'} at ${root} (${process.env.npm_lifecycle_event || path.basename(process.argv[1])})`;
  const result = spawnSync(binary, [path.join(cache, 'heavy-build.lock'), label, process.execPath, ...process.argv.slice(1)], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
