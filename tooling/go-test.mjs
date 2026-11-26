import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableVersion } from './version.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const tagged = ['-tags', 'arcfixture'];

export async function testGo(run) {
  await run('go', ['vet', './...']);
  await run('go', ['test', './...']);
  await run('go', ['vet', ...tagged, './...']);
  await run('go', ['test', ...tagged, './...']);
}

export async function buildGoTestBinaries(run, env) {
  const target = path.resolve(env.CARGO_TARGET_DIR || path.join(root, 'target'), 'go-native-tests');
  mkdirSync(target, { recursive: true });
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const binaries = {
    ARC_TEST_BINARY: path.join(target, 'arc' + suffix),
    ARC_TEST_FIXTURE_BINARY: path.join(target, 'contract-fixture' + suffix),
  };
  const version = stableVersion(env.ARC_BUILD_VERSION);
  const flags = ['-ldflags', `-X github.com/whzxc/agent-remote-control/internal/core.buildVersion=${version}`];
  await run('go', ['build', ...flags, '-o', binaries.ARC_TEST_BINARY, './cmd/arc']);
  await run('go', ['build', ...tagged, ...flags, '-o', binaries.ARC_TEST_FIXTURE_BINARY, './cmd/contract-fixture']);
  return binaries;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit' });
    run(process.execPath, ['tooling/check-tests.mjs']);
    await testGo(run);
  } catch (error) {
    process.exitCode = error.status ?? 1;
  }
}
