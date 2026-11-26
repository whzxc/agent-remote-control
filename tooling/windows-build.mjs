// Runs in the dedicated Windows worker checkout with public build inputs only.
import { execFileSync } from 'node:child_process';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileDigest, stageTimer, dependencyEnv } from './release-support.mjs';
import { installDependencies } from './build-cache.mjs';
import { collectDesktop, installerName } from './release-desktop.mjs';
import { archiveReceipt } from './release-signing.mjs';
import { stableVersion } from './version.mjs';
import { desktopExecutable } from './dev-identity.mjs';
import { configureWindowsToolchain } from './windows-toolchain.mjs';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 worker required');
if (Object.keys(process.env).some(key => /^(TAURI_SIGNING_|ARC_MYGO_UPDATE_PRIVATE_KEY_FILE$|MYGO_UPDATER_PRIVATE_KEY$|CSC_|WIN_CSC_)/.test(key))) {
  throw new Error('Signing secrets must not be present on the Windows worker');
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
if (git('status', '--porcelain')) throw new Error('Windows source checkout is dirty');
const sourceSha = git('rev-parse', 'HEAD');
const version = stableVersion(process.env.ARC_BUILD_VERSION);
const output = path.resolve('release-artifacts/windows');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
process.env.ARC_RELEASE_TIMINGS_FILE = path.join(output, 'windows-stages.jsonl');
process.env.ARC_RELEASE_PLATFORM = 'windows';
const timer = stageTimer();
await timer.run('Windows toolchain', () => configureWindowsToolchain());
await timer.run('Windows dependencies', () => installDependencies(process.cwd(), async () => execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm ci'], { stdio: 'inherit', env: dependencyEnv(process.env) })));
const target = 'windows-amd64';
const parent = path.resolve('dist/windows-release');
const input = path.join(parent, target);
await timer.run('Windows MyGo and NSIS build', async () => execFileSync(process.execPath, ['tooling/desktop-build.mjs', '--target', 'windows/amd64', '--output', parent], { stdio: 'inherit' }));
if (git('status', '--porcelain') || git('rev-parse', 'HEAD') !== sourceSha) throw new Error('Windows build changed source');
const binary = await readFile(path.join(input, desktopExecutable + '.exe'));
const pe = binary.readUInt32LE(0x3c);
if (binary.toString('ascii', pe, pe + 4) !== 'PE\0\0' || binary.readUInt16LE(pe + 4) !== 0x8664) throw new Error('Windows binary must be x86_64 PE');
const coreVersion = execFileSync(path.join(input, 'bin/arc.exe'), ['--version'], { encoding: 'utf8' }).trim();
if (coreVersion !== version) throw new Error('Windows Core embedded version mismatch');
const archive = await collectDesktop({ target, version, input, output });
const file = installerName(target, version);
await writeFile(path.join(output, 'windows-receipt.json'), JSON.stringify({ version, sourceSha, arch: 'x86_64', file,
  sha256: (await fileDigest(path.join(output, file))).slice(7), archive: await archiveReceipt(archive) }, null, 2) + '\n');
