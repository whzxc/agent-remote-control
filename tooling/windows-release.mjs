import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileDigest, dependencyEnv } from './release-support.mjs';
import { installDependencies } from './build-cache.mjs';
import { archiveName, buildOnlyEnv, archiveReceipt } from './release-signing.mjs';
import { collectDesktop, signLegacyPayload } from './release-desktop.mjs';
import { resolveMygoUpdatePublicKey } from './mygo-update-public-key.mjs';

export function runCommand(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`${file} exited ${code ?? signal}`)));
  });
}

export function workerReady(state) {
  return state.status === 'running' && [true, 'true'].includes(state.ssh_reachable) && [true, 'true'].includes(state.ready);
}

export function validateWindowsReceipt(receipt, { version, sourceSha, digest }) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || receipt.version !== version || receipt.sourceSha !== sourceSha
      || receipt.arch !== 'x86_64' || receipt.file !== `agent-remote-control_${version}_x64-setup.exe`
      || receipt.sha256 !== digest.replace(/^sha256:/, '')) throw new Error('Windows receipt version/SHA/architecture/checksum mismatch');
}

export function canStopWorker(initial, current, owner) {
  return initial.status === 'stopped' && current.owner === owner && current.owner_worker === 'windows';
}

const capture = (file, args) => execFileSync(file, args, { encoding: 'utf8', maxBuffer: 16 * 1024 ** 2 }).trim();
const psQuote = value => `'${value.replaceAll("'", "''")}'`;
const shellQuote = value => `'${value.replaceAll("'", "'\"'\"'")}'`;
const sshOptions = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];
const workerEnv = () => Object.fromEntries(Object.entries(buildOnlyEnv()).filter(([key]) => !/^(APPLE_|CSC_|WIN_CSC_)/.test(key)));
export const workProfileRoot = (workRoot, override) => override?.trim() || path.join(workRoot, 'profiles', 'personal');
const powershell = (host, script) => runCommand('ssh', [...sshOptions, host,
  `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from("$ProgressPreference='SilentlyContinue'\n" + script, 'utf16le').toString('base64')}`], { env: workerEnv() });

export async function prepareWindowsWorker({ timer }) {
  const runtime = JSON.parse(capture('enjoy', ['runtime']));
  const fleet = JSON.parse(await readFile(path.join(runtime.profileRoot, 'fleet/targets.json'))).targets;
  const work = runtime.packages.find(pkg => pkg.identity.name === '@whzxc/work');
  if (!work) throw new Error('Windows release requires the installed @whzxc/work package; inspect enjoy runtime.');
  const workProfile = workProfileRoot(work.root, process.env.ENJOY_PROFILE_ROOT);
  const builds = JSON.parse(await readFile(path.join(workProfile, 'client/client-build-targets.json')));
  const target = builds.targets[builds.windowsTarget];
  const host = target.ssh;
  const owner = `arc-${randomUUID()}`;
  const operation = async action => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const result = await promisify(execFile)('enjoy', ['infra', 'execute', '--operation', `proxmox.worker.${action}`,
      '--target', 'k12', '--args-json', JSON.stringify(action === 'inspect' ? { worker: 'windows' } : { worker: 'windows', owner }),
      '--fresh', ...(action === 'inspect' ? [] : ['--idempotency-key', `${owner}-${action}`])], { timeout: 180000, maxBuffer: 1024 ** 2, env: workerEnv() });
    const receipt = JSON.parse(result.stdout);
    if (receipt.outcome !== 'ok' || receipt.data?.ok !== true) throw new Error(`Worker ${action} failed; inspect owner ${owner}`);
    return receipt.data;
  };
  const initial = await operation('inspect');
  const remoteRoot = 'C:/Build/arc-release';
  console.log(`Windows worker owner: ${owner}`);
  let claimed = false;
  const cleanup = async () => {
    if (claimed) await timer.run('Windows worker cleanup', async () => {
      const current = await operation('inspect');
      if (canStopWorker(initial, current, owner)) {
        const stopped = await operation('stop');
        if (stopped.status !== 'stopped' || stopped.owner) throw new Error(`Worker cleanup unconfirmed: ${owner}`);
      } else if (current.owner === owner) throw new Error(`Worker cleanup requires inspection: ${owner}`);
    });
  };
  try {
    await timer.run('Windows worker readiness', async () => {
      // The source checkout lock also covers SCNet jobs which have not started their guest yet.
      const source = builds.source.checkout;
      await runCommand('ssh', [...sshOptions, fleet.k12.ssh,
        `test ! -d ${shellQuote(`${source}/.git/enjoy-build.lock`)} && test ! -d ${shellQuote(`${source}/.git/enjoy-platform.lock`)}`], { env: workerEnv() });
      if (initial.owner || initial.status !== 'stopped' || initial.other_status !== 'stopped') throw new Error('K12 worker is occupied; refusing to take over');
      claimed = true; // Includes ambiguous start responses; cleanup must inspect ownership.
      await operation('start');
      const deadline = Date.now() + 240000;
      for (;;) {
        const state = await operation('inspect');
        if (state.owner !== owner) throw new Error('Windows worker ownership lost');
        if (workerReady(state)) break;
        if (Date.now() > deadline) throw new Error('Windows worker SSH readiness timeout');
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      await powershell(host, `$ErrorActionPreference='Stop'
if (Test-Path ${psQuote(`${target.checkout}/.git/enjoy-build.lock`)}) { throw 'SCNet build lock exists' }
if (Test-Path ${psQuote(`${target.checkout}/.git/enjoy-platform.lock`)}) { throw 'SCNet platform lock exists' }
$busy = Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(node|cargo|rustc|msbuild|electron-builder)(.exe)?$' -and $_.CommandLine -match 'sacp-client|scnet' }
if ($busy) { throw 'SCNet build process exists' }
New-Item -ItemType Directory -Force ${psQuote(remoteRoot + '/release-artifacts')} | Out-Null`);
    });
    return { host, remoteRoot, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function buildWindows({ sourceSha, version, output, env, timer, worker, onCollected }) {
  const { host, remoteRoot } = await worker;
  const bundle = path.join(output, 'source.bundle');
  try {
    await timer.run('Windows source transfer', async () => {
      await runCommand('git', ['bundle', 'create', bundle, 'HEAD']);
      await runCommand('scp', [...sshOptions, bundle, `${host}:${remoteRoot}/release-artifacts/source.bundle`], { env: workerEnv() });
    });
    await timer.run('Windows checkout/dependencies/build', async () => {
      await powershell(host, `$ErrorActionPreference='Stop'
function checked { if ($LASTEXITCODE -ne 0) { throw "Command failed: $LASTEXITCODE" } }
Set-Location ${psQuote(remoteRoot)}
if (!(Test-Path source/.git)) { git init source; checked }
Set-Location source
foreach ($legacy in @('desktop/gen', 'desktop/runtime')) { if (Test-Path $legacy) { Remove-Item -Recurse -Force $legacy } }
if ((git status --porcelain)) { throw 'Windows release checkout is dirty' }
git fetch ../release-artifacts/source.bundle HEAD:refs/remotes/source/frozen; checked
if (!(Test-Path .git/packed-refs)) { git pack-refs --all; checked }
if ((git rev-parse --verify --quiet HEAD) -ne '${sourceSha}') { git checkout --detach ${sourceSha}; checked }
foreach ($legacy in @('desktop/gen', 'desktop/runtime')) { if (Test-Path $legacy) { Remove-Item -Recurse -Force $legacy } }
if ((git rev-parse HEAD) -ne '${sourceSha}') { throw 'Windows source SHA mismatch' }
$env:ARC_BUILD_VERSION='${version}'
$env:ARC_MYGO_UPDATE_PUBLIC_KEY=${psQuote(resolveMygoUpdatePublicKey(env))}
node tooling/windows-build.mjs; checked`);
    });
    await timer.run('Windows artifact collection/sign', async () => {
      const name = `agent-remote-control_${version}_x64-setup.exe`;
      const archive = archiveName('windows-amd64', version);
      for (const file of [name, archive, 'windows-receipt.json', 'windows-stages.jsonl']) {
        await runCommand('scp', [...sshOptions, `${host}:${remoteRoot}/source/release-artifacts/windows/${file}`, path.join(output, file)], { env: workerEnv() });
      }
      const receipt = JSON.parse(await readFile(path.join(output, 'windows-receipt.json')));
      validateWindowsReceipt(receipt, { version, sourceSha, digest: await fileDigest(path.join(output, name)) });
      const copied = await archiveReceipt(path.join(output, archive));
      if (receipt.archive?.name !== copied.name || receipt.archive?.sha256 !== copied.sha256) throw new Error('Windows MyGo archive receipt mismatch');
      onCollected();
      await signLegacyPayload({ target: 'windows-amd64', version, output,
        base: `https://github.com/whzxc/agent-remote-control/releases/download/v${version}`, env });
    });
  } finally {
    await rm(bundle, { force: true });
    onCollected();
  }
}

export async function buildMac({ sourceSha, output, env, timer }) {
  const source = path.resolve('release-artifacts/.macos-source');
  await timer.run('macOS checkout/dependencies', async () => {
    try { await readFile(path.join(source, '.git/HEAD')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await runCommand('git', ['clone', '--no-hardlinks', '.', source]);
    }
    await Promise.all(['desktop/gen', 'desktop/runtime'].map(rel => rm(path.join(source, rel), { recursive: true, force: true })));
    if (capture('git', ['-C', source, 'status', '--porcelain'])) throw new Error('macOS release checkout is dirty');
    await runCommand('git', ['-C', source, 'fetch', path.resolve('.'), sourceSha]);
    if (capture('git', ['-C', source, 'rev-parse', 'HEAD']) !== sourceSha) {
      await runCommand('git', ['-C', source, 'checkout', '--detach', sourceSha]);
    }
    await Promise.all(['desktop/gen', 'desktop/runtime'].map(rel => rm(path.join(source, rel), { recursive: true, force: true })));
    await installDependencies(source, () => runCommand('npm', ['ci'], { cwd: source, env: dependencyEnv(env) }));
  });
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
