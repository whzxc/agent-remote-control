import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableVersion } from './version.mjs';
import { buildEnv, coreFlags } from './build-env.mjs';
import { prepareDesktop } from './prepare-desktop.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const tagged = ['-tags', 'arcfixture'];
const excluded = new Set(['node_modules', 'vendor', 'third_party', 'third-party', 'testdata']);

export function repositoryGoFiles() {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.go'], {
    cwd: root, encoding: 'utf8',
  }).split('\0').filter(Boolean);
  return files.filter(file => {
    let directory = root;
    for (const name of file.split('/').slice(0, -1)) {
      directory = path.join(directory, name);
      if (excluded.has(name) || /^[._]/.test(name) || existsSync(path.join(directory, 'go.mod'))) return false;
    }
    return existsSync(path.join(root, file));
  });
}

export async function testGo(run, { vetOnly = false } = {}) {
  const directories = [...new Set(repositoryGoFiles().map(file => './' + path.posix.dirname(file)))];
  for (const tags of [[], tagged]) {
    // Go decides which repository directories are packages for this platform and tag set.
    const format = '{{if or .GoFiles .CgoFiles .TestGoFiles .XTestGoFiles .InvalidGoFiles}}{{.ImportPath}}{{end}}';
    const packages = execFileSync('go', ['list', '-e', '-f', format, ...tags, ...directories], {
      cwd: root, env: buildEnv(), encoding: 'utf8',
    }).trim().split('\n').filter(Boolean);
    if (!packages.length) throw new Error('No repository Go packages found.');
    await run('go', ['vet', ...tags, ...packages]);
    if (!vetOnly) await run('go', ['test', ...tags, ...packages]);
  }
}

export async function buildGoTestBinaries(run, env) {
  await prepareDesktop();
  const target = path.resolve(env.ARC_TEST_TARGET_DIR || path.join(root, 'dist/native-tests'));
  mkdirSync(target, { recursive: true });
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const binaries = {
    ARC_TEST_BINARY: path.join(target, 'arc' + suffix),
    ARC_TEST_FIXTURE_BINARY: path.join(target, 'contract-fixture' + suffix),
  };
  const version = stableVersion(env.ARC_BUILD_VERSION);
  const flags = coreFlags(version);
  await run('go', ['build', '-tags', 'arcbrowser', ...flags, '-o', binaries.ARC_TEST_BINARY, './cmd/arc']);
  await run('go', ['build', '-tags', 'arcfixture,arcbrowser', ...flags, '-o', binaries.ARC_TEST_FIXTURE_BINARY, './cmd/contract-fixture']);
  return binaries;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const run = (command, args) => execFileSync(command, args, { cwd: root, env: buildEnv(), stdio: 'inherit' });
    run(process.execPath, ['tooling/check-tests.mjs']);
    await testGo(run, { vetOnly: process.argv.includes('--vet-only') });
  } catch (error) {
    process.exitCode = error.status ?? 1;
  }
}
