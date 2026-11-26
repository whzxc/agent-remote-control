import { execFileSync } from 'node:child_process';
import { repositoryGoFiles } from './go-test.mjs';

const files = repositoryGoFiles();
let changed = '';
// Bound argv size on Windows.
for (let i = 0; i < files.length; i += 100) {
  changed += execFileSync('gofmt', ['-l', ...files.slice(i, i + 100)], { encoding: 'utf8' });
}
if (changed) {
  console.error(`Run gofmt on these Go files:\n${changed.trimEnd()}`);
  process.exitCode = 1;
}
