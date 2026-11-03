import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { buildEnv } from './build-env.mjs';
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
const output = path.resolve(directory), target = `${arch}-unknown-linux-gnu`;
const env = { ...buildEnv(true), ARC_BUILD_VERSION: version };
try {
  await runCommand('cargo-zigbuild', ['clippy', '--locked', '--manifest-path', 'native/Cargo.toml', '--target', `${target}.2.28`], { env });
  await runCommand('cargo', ['zigbuild', '--locked', '--release', '--manifest-path', 'native/Cargo.toml', '--bin', 'arc', '--target', `${target}.2.28`], { env });
  const binary = path.join(env.CARGO_TARGET_DIR, target, 'release/arc');
  validateLinuxElf(await readFile(binary), arch);
  const actual = capture(binary, ['--version']);
  if (actual !== version) throw new Error(`Linux ${arch} embedded version mismatch: ${actual}`);
  const help = capture(binary, ['cli', '--help']);
  if (!help) throw new Error('Linux CLI help returned no output');
  const symbols = capture('readelf', ['--version-info', binary]);
  const versions = [...symbols.matchAll(/GLIBC_(\d+)\.(\d+)/g)].map(match => [Number(match[1]), Number(match[2])]);
  if (!versions.length || versions.some(([major, minor]) => major > 2 || (major === 2 && minor > 28))) throw new Error('Linux build exceeds the GLIBC 2.28 compatibility baseline');
  const stage = path.join(output, '.package');
  await mkdir(stage, { recursive: true });
  try {
    await copyFile(binary, path.join(stage, 'arc'));
    await copyFile('LICENSE', path.join(stage, 'LICENSE'));
    await cp('skills', path.join(stage, 'skills'), { recursive: true });
    await cp('licenses', path.join(stage, 'licenses'), { recursive: true });
    const file = `agent-remote-control-v${version}-linux-${arch}.tar.gz`;
    await runCommand('tar', ['-czf', path.join(output, file), '-C', stage, 'arc', 'LICENSE', 'skills', 'licenses']);
    assertSource();
    await writeFile(path.join(output, 'receipt.json'), JSON.stringify({ version, sourceSha, arch, file,
      sha256: (await fileDigest(path.join(output, file))).slice(7), glibcBaseline: '2.28', runtimeVersion: actual, runtimeHelp: true }, null, 2) + '\n');
    console.log(`Verified ${file}: native ${arch}, version ${actual}, CLI help, ELF64, GLIBC <= 2.28`);
  } finally { await rm(stage, { recursive: true, force: true }); }
} finally {
  await runCommand(process.execPath, ['tooling/prune-build-cache.mjs']);
}
