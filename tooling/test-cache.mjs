import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { release, homedir } from 'node:os';
import path from 'node:path';
import { inputKey } from './build-cache.mjs';
import { randomUUID } from 'node:crypto';

const capture = (file, args) => execFileSync(file, args, { encoding: 'utf8' }).trim();
export function testEnvironment(env = process.env) {
  const result = { ...env };
  for (const key of ['ARC_BUILD_VERSION', 'ARC_RELEASE_TIMINGS_FILE', 'ARC_RELEASE_PLATFORM', 'TAURI_CONFIG']) delete result[key];
  result.ARC_BUILD_VERSION = '0.0.0';
  return result;
}
export async function testInputs() {
  if (capture('git', ['status', '--porcelain'])) return undefined;
  const env = testEnvironment();
  const inputs = { schema: 1, testVersion: env.ARC_BUILD_VERSION, tree: capture('git', ['rev-parse', 'HEAD^{tree}']), platform: process.platform, arch: process.arch,
    os: release(), node: process.version, npm: process.platform === 'win32' ? capture('cmd.exe', ['/d', '/s', '/c', 'npm --version']) : capture('npm', ['--version']), rustc: capture(env.RUSTC || 'rustc', ['-vV']), cargo: capture('cargo', ['--version']),
    flags: inputKey(['RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'CARGO_BUILD_TARGET', 'CC', 'CFLAGS', 'RUSTDOCFLAGS', 'RUSTC', 'RUSTC_WRAPPER',
      'RUSTC_WORKSPACE_WRAPPER', 'RUSTUP_TOOLCHAIN', 'CARGO_HOME', 'RUSTUP_HOME', 'CARGO_TARGET_DIR', 'SDKROOT'].map(key => [key, env[key] ?? null])), files: {} };
  if (process.platform === 'darwin') inputs.sdk = capture('xcrun', ['--show-sdk-version']);
  for (const file of ['Cargo.lock', 'package-lock.json', 'rust-toolchain.toml', '.cargo/config.toml', 'package.json', 'node_modules/.package-lock.json']) {
    inputs.files[file] = inputKey(await readFile(file, 'utf8'));
  }
  for (const [name, file] of [['cargoUser', path.join(homedir(), '.cargo/config.toml')], ['npmUser', path.join(homedir(), '.npmrc')], ['npmProject', '.npmrc']]) {
    try { inputs.files[name] = inputKey(await readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; inputs.files[name] = null; }
  }
  return inputs;
}
export function testPassMatches(receipt, inputs) {
  return !!inputs && receipt?.schema === 1 && receipt.status === 'passed' && receipt.key === inputKey(inputs);
}
export async function cachedTestPass(inputs = undefined) {
  inputs ??= await testInputs();
  if (!inputs) return undefined;
  try {
    const receipt = JSON.parse(await readFile(path.join('release-artifacts/test-cache', inputKey(inputs) + '.json')));
    return testPassMatches(receipt, inputs) ? receipt : undefined;
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
}
export async function recordTestPass(before) {
  const after = await testInputs();
  if (!before || !after || inputKey(before) !== inputKey(after)) { console.log('Tests passed; no cache recorded because source or test inputs changed.'); return; }
  const key = inputKey(after), dir = 'release-artifacts/test-cache';
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, key + '.json');
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ schema: 1, status: 'passed', key, inputs: after, passedAt: new Date().toISOString() }, null, 2) + '\n');
  await rename(temporary, file);
  console.log(`Recorded passing tests for tree ${after.tree}: ${file}`);
}
