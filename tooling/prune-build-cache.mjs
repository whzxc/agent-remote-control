import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
if (!process.env.CI) {
  const source = path.join(root, 'tooling/prune-build-cache.rs');
  const directory = path.join(root, 'target/cache-tool');
  const binary = path.join(directory, process.platform === 'win32' ? 'prune.exe' : 'prune');
  mkdirSync(directory, { recursive: true });
  if (!existsSync(binary) || statSync(source).mtimeMs > statSync(binary).mtimeMs) {
    execFileSync('rustc', ['--edition=2021', '-C', 'debuginfo=0', source, '-o', binary], { cwd: root, stdio: 'inherit' });
  }
  execFileSync(binary, ['8', 'target', ...process.argv.slice(2).filter(arg => arg === '--dry-run' || arg.startsWith('--keep='))], { cwd: root, stdio: 'inherit' });
}
