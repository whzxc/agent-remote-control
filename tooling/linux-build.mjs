import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { buildEnv } from './build-env.mjs';
import { buildNative } from './build-native.mjs';
import { prepareDesktop } from './prepare-desktop.mjs';
import { stableVersion } from './version.mjs';
import { validateLinuxElf } from './linux-release.mjs';
import { fileDigest } from './release-support.mjs';
import { runCommand } from './windows-release.mjs';

const [sourceSha, requestedVersion, arch, directory] = process.argv.slice(2);
const version = stableVersion(requestedVersion);
if (!/^[a-f0-9]{40}$/.test(sourceSha) || !directory || process.platform !== 'linux'
    || process.arch !== { x86_64: 'x64', aarch64: 'arm64' }[arch]) {
  throw new Error('Usage on the matching native Linux runner: node tooling/linux-build.mjs <full-sha> <version> <x86_64|aarch64> <output>');
}
const capture = (file, args) => execFileSync(file, args, { encoding: 'utf8' }).trim();
const assertSource = () => {
  if (capture('git', ['rev-parse', 'HEAD']) !== sourceSha || capture('git', ['status', '--porcelain'])) throw new Error('Linux build requires clean source at the requested full SHA');
};
assertSource();
const output = path.resolve(directory);
const target = `linux/${arch === 'aarch64' ? 'arm64' : 'amd64'}`;
process.env.ARC_BUILD_VERSION = version;
await runCommand('go', ['vet', './cmd/arc', './internal/core'], { env: buildEnv() });
await prepareDesktop();
const stage = path.join(output, '.package');
await mkdir(stage, { recursive: true });
try {
  const binary = await buildNative({ target, release: true, directory: stage });
  validateLinuxElf(await readFile(binary), arch);
  const actual = capture(binary, ['--version']);
  if (actual !== version) throw new Error(`Linux ${arch} embedded version mismatch: ${actual}`);
  if (!capture(binary, ['cli', '--help'])) throw new Error('Linux CLI help returned no output');
  if (/INTERP\s/.test(capture('readelf', ['-l', binary])) ||
      /\(NEEDED\)/.test(capture('readelf', ['-d', binary])) ||
      /GLIBC_/.test(capture('readelf', ['--version-info', binary]))) {
    throw new Error('Linux Core must be independent of the system libc and dynamic loader.');
  }
  await copyFile('LICENSE', path.join(stage, 'LICENSE'));
  await cp('licenses', path.join(stage, 'licenses'), { recursive: true });
  const file = `agent-remote-control-v${version}-linux-${arch}.tar.gz`;
  await runCommand('tar', ['-czf', path.join(output, file), '-C', stage, 'arc', 'LICENSE', 'skills', 'licenses']);
  assertSource();
  await writeFile(path.join(output, 'receipt.json'), JSON.stringify({ version, sourceSha, arch, file,
    sha256: (await fileDigest(path.join(output, file))).slice(7), glibcBaseline: '2.28', linkage: 'static',
    runtimeVersion: actual, runtimeHelp: true }, null, 2) + '\n');
  console.log(`Verified ${file}: native ${arch}, version ${actual}, CLI help, static ELF64`);
} finally { await rm(stage, { recursive: true, force: true }); }
