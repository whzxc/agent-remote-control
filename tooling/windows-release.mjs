import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileDigest, dependencyEnv } from './release-support.mjs';
import { installDependencies } from './build-cache.mjs';
import { buildOnlyEnv, archiveReceipt, verifier } from './release-signing.mjs';
import { collectDesktop, installerName, signLegacyPayload } from './release-desktop.mjs';
import { desktopExecutable } from './dev-identity.mjs';

export function runCommand(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`${file} exited ${code ?? signal}`)));
  });
}

export function validateWindowsReceipt(receipt, { version, sourceSha, digest }) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || receipt.version !== version || receipt.sourceSha !== sourceSha
      || receipt.arch !== 'x86_64' || receipt.file !== `agent-remote-control_${version}_x64-setup.exe`
      || receipt.sha256 !== digest.replace(/^sha256:/, '')) throw new Error('Windows receipt version/SHA/architecture/checksum mismatch');
}

const capture = (file, args) => execFileSync(file, args, { encoding: 'utf8', maxBuffer: 16 * 1024 ** 2 }).trim();

export function checkLocalWindowsTools(env = process.env) {
  const makensis = env.ARC_MAKENSIS || 'makensis';
  try {
    execFileSync(makensis, ['-VERSION'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new Error(`Windows cross-packaging requires NSIS (${makensis}); install with "brew install makensis". (${error.message})`);
  }
}

export async function prepareLocalSource(name, sourceSha, env, timer, stageName) {
  const source = path.resolve('release-artifacts', name);
  await timer.run(stageName, async () => {
    try { await readFile(path.join(source, '.git/HEAD')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await runCommand('git', ['clone', '--no-hardlinks', '.', source]);
    }
    await Promise.all(['desktop/gen', 'desktop/runtime'].map(rel => rm(path.join(source, rel), { recursive: true, force: true })));
    if (capture('git', ['-C', source, 'status', '--porcelain'])) throw new Error(`${name} release checkout is dirty`);
    await runCommand('git', ['-C', source, 'fetch', path.resolve('.'), sourceSha]);
    if (capture('git', ['-C', source, 'rev-parse', 'HEAD']) !== sourceSha) {
      await runCommand('git', ['-C', source, 'checkout', '--detach', sourceSha]);
    }
    await Promise.all(['desktop/gen', 'desktop/runtime'].map(rel => rm(path.join(source, rel), { recursive: true, force: true })));
    await installDependencies(source, () => runCommand('npm', ['ci'], { cwd: source, env: dependencyEnv(env) }));
  });
  return source;
}

export async function buildWindows({ sourceSha, version, output, env, timer }) {
  const source = await prepareLocalSource('.windows-source', sourceSha, env, timer, 'Windows checkout/dependencies');
  const parent = path.join(source, 'dist/windows-release');
  const target = 'windows-amd64';
  const input = path.join(parent, target);
  await runCommand(process.execPath, ['tooling/desktop-build.mjs', '--release', '--target', 'windows/amd64', '--output', parent],
    { cwd: source, env: { ...buildOnlyEnv(env), ARC_BUILD_VERSION: version, ARC_RELEASE_PLATFORM: 'windows' } });
  await timer.run('Windows staging verification', async () => {
    console.log(verifier('verify-windows', version, [
      path.join(input, desktopExecutable + '.exe'),
      path.join(input, 'bin', 'arc.exe'),
    ], { publicOnly: true, env }));
    const archive = await collectDesktop({ target, version, input, output });
    const file = installerName(target, version);
    const digest = await fileDigest(path.join(output, file));
    const receipt = { version, sourceSha, arch: 'x86_64', file, sha256: digest.slice(7), archive: await archiveReceipt(archive) };
    validateWindowsReceipt(receipt, { version, sourceSha, digest });
    await signLegacyPayload({ target, version, output,
      base: `https://github.com/whzxc/agent-remote-control/releases/download/v${version}`, env });
    if (capture('git', ['-C', source, 'status', '--porcelain']) || capture('git', ['-C', source, 'rev-parse', 'HEAD']) !== sourceSha) {
      throw new Error('Windows build changed source');
    }
    await writeFile(path.join(output, 'windows-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  });
}

export async function buildMac({ sourceSha, output, env, timer }) {
  const source = await prepareLocalSource('.macos-source', sourceSha, env, timer, 'macOS checkout/dependencies');
  const parent = path.join(source, 'dist/desktop-release');
  await runCommand(process.execPath, ['tooling/desktop-build.mjs', '--release', '--target', 'darwin/arm64', '--output', parent],
    { cwd: source, env: { ...buildOnlyEnv(env), ARC_RELEASE_PLATFORM: 'mac' } });
  await timer.run('macOS staging verification', async () => {
    const version = env.ARC_BUILD_VERSION, target = 'darwin-arm64';
    await collectDesktop({ target, version, input: path.join(parent, target), output });
    await signLegacyPayload({ target, version, output, base: `https://github.com/whzxc/agent-remote-control/releases/download/v${version}`, env });
    if (capture('git', ['-C', source, 'status', '--porcelain']) || capture('git', ['-C', source, 'rev-parse', 'HEAD']) !== sourceSha) throw new Error('macOS build changed source');
    await writeFile(path.join(output, 'macos-receipt.json'), JSON.stringify({ version, sourceSha, arch: 'aarch64' }) + '\n');
  });
}
