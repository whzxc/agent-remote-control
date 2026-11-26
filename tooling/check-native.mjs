import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { enterHeavyBuild } from './heavy-build.mjs';

enterHeavyBuild();
const cwd = fileURLToPath(new URL('../', import.meta.url));
for (const args of [['tooling/go-format.mjs'], ['tooling/go-test.mjs', '--vet-only']]) {
  execFileSync(process.execPath, args, { cwd, stdio: 'inherit' });
}
