import { requireMainCheckout } from './coding-lane.mjs';
import { readFile, writeFile, readdir, mkdir, mkdtemp, stat, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWindows, buildMac, checkLocalWindowsTools, runCommand } from './windows-release.mjs';
import { buildLinux } from './linux-release.mjs';
import { testEnvironment } from './test-environment.mjs';
import { buildVersion, stableVersion } from './version.mjs';
import { readReleaseNotes, rehearsalReleaseNotes } from './release-notes.mjs';
import { buildOnlyEnv, checkLegacyUpdatePublicKey, feedName, rehearsalSigning, signMygoFeed, updateTargets, verifier, verifyMygoFeed } from './release-signing.mjs';
import { collectDesktop, fragmentName, installerName, requireEmptyStage, signLegacyPayload, legacyPayloadName } from './release-desktop.mjs';
import { desktopExecutable } from './dev-identity.mjs';
import { retainBuildArtifacts } from './retain-build-artifacts.mjs';
import { macosSigningIdentity } from './macos-signing.mjs';
import { gh, ghTransfer, releaseByTag, releaseById, requireDraftRelease, uploadReleaseAsset, publishedTags, fileDigest, publicationStages,
  validateResume, validateRemoteAssets, validateArtifactInventory, platformAssetNames, retry, boundedMap, stageTimer, parallelPlatforms, releasePlatforms } from './release-support.mjs';
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
let version = buildVersion();
const repo = 'whzxc/agent-remote-control';
let base = `https://github.com/${repo}/releases/download/v${version}`;
const [mode, ...args] = process.argv.slice(2);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => readFile(file, 'utf8').then(JSON.parse);
const writeJson = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
async function validateManifest(manifest, dir) {
  if (manifest.version !== version || !manifest.platforms || !Object.keys(manifest.platforms).every(key => ['darwin-aarch64', 'windows-x86_64', 'windows-x86_64-nsis'].includes(key))) throw new Error('Invalid release manifest');
  const keys = Object.keys(manifest.platforms);
  if (!keys.length) {
    for (const arch of ['x86_64', 'aarch64']) await readFile(path.join(dir, `agent-remote-control-v${version}-linux-${arch}.tar.gz`));
  }
  for (const key of keys) {
    const value = manifest.platforms[key];
    if (!value.url.startsWith(base + '/')) throw new Error('Unexpected updater download origin/version');
    const name = value.url.slice(base.length + 1);
    const target = key === 'darwin-aarch64' ? updateTargets.mac : updateTargets.windows;
    if (name !== legacyPayloadName(target, version)) throw new Error('Invalid updater asset name');
    if ((await readFile(path.join(dir,name+'.sig'),'utf8')).trim() !== value.signature) throw new Error('Manifest signature mismatch');
    await readFile(path.join(dir,name));
  }

}
async function cask(dir) {
  const dmg = path.join(dir, installerName(updateTargets.mac, version));
  await writeFile(path.join(dir, 'agent-remote-control.rb'), `cask "agent-remote-control" do
  version "${version}"
  sha256 "${(await fileDigest(dmg)).slice(7)}"

  url "https://github.com/${repo}/releases/download/v#{version}/agent-remote-control_#{version}_aarch64.dmg"
  name "Agent Remote Control"
  desc "Connect Claude and ChatGPT to local coding agents"
  homepage "https://github.com/${repo}"
  depends_on arch: :arm64
  auto_updates true
  app "Agent Remote Control.app"

  caveats <<~EOS
    See the repository installation guide if macOS blocks the first launch.
    Install and sign in to Codex for the default workflow.
    Connect Claude with HTTPS + OAuth, or ChatGPT with OpenAI Secure Tunnel.
  EOS
end
`);
}
const git = (...args) => execFileSync('git', args, {encoding:'utf8'}).trim();
function parts(value) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error(`Invalid stable version: ${value}`);
  return value.split('.').map(BigInt);
}
function compare(a, b) {
  const x=parts(a), y=parts(b);
  for (let i=0;i<3;i++) if(x[i]!==y[i]) return x[i]>y[i]?1:-1;
  return 0;
}
async function releaseInventory(output, selected, manifest, checkpoint) {
  const names = platformAssetNames(manifest, version, selected);
  const assets = await Promise.all(names.map(async name => ({
    name, size: (await stat(path.join(output, name))).size, digest: await fileDigest(path.join(output, name)),
  })));
  validateArtifactInventory(assets, await readFile(path.join(output, 'SHA256SUMS.txt'), 'utf8'), checkpoint);
  return assets;
}

async function verifyFeeds(output, selected, manifest, env) {
  await validateManifest(manifest, output);
  const payloads = [...new Set(Object.values(manifest.platforms).map(value => path.join(output, value.url.slice(base.length + 1))))];
  if (payloads.length) console.log(verifier('verify-tauri', version, payloads, { publicOnly: true, env }));
  for (const platform of selected) {
    const target = updateTargets[platform];
    if (target) await verifyMygoFeed({ target, version, directory: output, base, env });
  }
}

async function finalize(output, selected, notes, env) {
  const manifest = { version, notes: notes.en, notes_zh_cn: notes.zh, pub_date: new Date().toISOString(), platforms: {} };
  for (const platform of selected) {
    const target = updateTargets[platform];
    if (!target) continue;
    const fragment = await json(path.join(output, fragmentName(target)));
    if (fragment.version !== version) throw new Error('Mixed release versions');
    Object.assign(manifest.platforms, fragment.platforms);
    await signMygoFeed({ target, version, directory: output, base, notes, env });
  }
  await verifyFeeds(output, selected, manifest, env);
  await writeFile(path.join(output, 'release-notes.md'), notes.body);
  if (selected.includes('mac')) await cask(output);
  await writeJson(path.join(output, 'latest.json'), manifest);
  const sums = await Promise.all(platformAssetNames(manifest, version, selected).filter(name => name !== 'SHA256SUMS.txt').map(async name =>
    `${(await fileDigest(path.join(output, name))).slice(7)}  ${name}`));
  await writeFile(path.join(output, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
  return manifest;
}

const releaseBase = () => `https://github.com/${repo}/releases/download/v${version}`;

async function localRehearsal(output, keyDirectory, selected) {
  if (!path.isAbsolute(output) || !path.isAbsolute(keyDirectory)) throw new Error('Use absolute output and test-key directories.');
  await requireEmptyStage(output);
  const env = { ...buildOnlyEnv(), ...await rehearsalSigning(keyDirectory), ARC_BUILD_VERSION: version };
  if (selected.includes('windows')) checkLocalWindowsTools(env);
  console.log(verifier('check-keys', version, [], { env }) || 'Rehearsal public and private keys match.');
  const sourceSha = git('rev-parse', 'HEAD');
  if (git('status', '--porcelain')) throw new Error('Rehearsal requires clean, committed source.');
  const parent = path.join(output, '.packages');
  for (const platform of selected) {
    const target = updateTargets[platform];
    if (target) {
      await runCommand(process.execPath, ['tooling/desktop-build.mjs', '--target', target.replace('-', '/'), '--output', parent, '--adhoc'],
        { env: buildOnlyEnv(env) });
      const input = path.join(parent, target);
      if (platform === 'windows') {
        console.log(verifier('verify-windows', version, [
          path.join(input, desktopExecutable + '.exe'),
          path.join(input, 'bin', 'arc.exe'),
        ], { publicOnly: true, env }));
      }
      await collectDesktop({ target, version, input, output });
      await signLegacyPayload({ target, version, output, base, env });
    } else if (platform === 'linux') {
      await buildLinux({ sourceSha, version, output, env, timer: stageTimer(null, () => {}) });
    }
  }
  const manifest = await finalize(output, selected, rehearsalReleaseNotes, env);
  const assets = await releaseInventory(output, selected, manifest);
  if (git('status', '--porcelain') || git('rev-parse', 'HEAD') !== sourceSha) throw new Error('Source changed during rehearsal.');
  await writeJson(path.join(output, 'rehearsal.json'), { sourceSha, version, platforms: selected, assets });
  console.log(`Verified local release rehearsal: ${output}`);
}

async function coordinateRelease(options, { resume, dryRun, withExtended = false }) {
  const saved = resume ? await json(path.join(options.resume, 'release-state.json')) : undefined;
  const requested = options.version === undefined ? saved?.version : stableVersion(options.version);
  const platforms = releasePlatforms(options.platforms ?? saved?.platforms?.join(','));
  const mac = platforms.includes('mac');
  const windows = platforms.includes('windows');
  const linux = platforms.includes('linux');
  if (!dryRun) requireMainCheckout();
  await mkdir('release-artifacts', { recursive: true });
  const timingDir = await mkdtemp(path.join('release-artifacts', '.timings-'));
  const timingFile = path.resolve(timingDir, 'stages.jsonl');
  await writeFile(timingFile, '');
  const timer = stageTimer(timingFile);
  const startedAt = Date.now();
  let output = resume ? path.resolve(options.resume) : undefined;
  let state = saved;
  let sourceSha;
  let env, notes;
  const assertSource = () => {
    if (git('status', '--porcelain') || git('rev-parse', 'HEAD') !== sourceSha) throw new Error('Source changed during release; refusing to tag or publish');
    const tag = `v${version}`;
    if (git('tag', '--list', tag) && git('rev-parse', `${tag}^{commit}`) !== sourceSha) throw new Error(`${tag} belongs to another commit`);
  };
  const saveState = async () => {
    const file = path.join(output, 'release-state.json');
    await writeJson(file + '.tmp', state);
    await rename(file + '.tmp', file);
  };
  const transferRetry = (name, operation) => retry(operation, {
    onRetry: (error, attempt, delay) => console.error(`${name}: attempt ${attempt} failed (${error.message}); retrying in ${delay / 1000}s`),
  });
  try {
    if (!resume && withExtended) await timer.run('extended gate', () =>
      runCommand('npm', ['run', 'test:extended'], { env: testEnvironment(buildOnlyEnv()) }));
    else if (!resume) timer.skip('extended gate');
    await timer.run('checks', async () => {
      if (!resume && mac && (process.platform !== 'darwin' || process.arch !== 'arm64')) throw new Error('macOS releases require a local build and signing on an Apple Silicon Mac');
      env = { ...process.env };
      if (mac || windows) checkLegacyUpdatePublicKey(env);
      if (!resume && (mac || windows)) verifier('check-keys', requested || version, [], { env });
      if (!resume && windows) checkLocalWindowsTools(env);
      env.ARC_RELEASE_TIMINGS_FILE = timingFile;
      if (!resume && mac) macosSigningIdentity(env, { release: true });
      sourceSha = git('rev-parse', 'HEAD');
      if (git('status', '--porcelain')) throw new Error('Release builds require a clean committed source');
      if (!dryRun) {
        if (git('branch', '--show-current') !== 'main') throw new Error('Run release from main');
        if (git('status', '--porcelain')) throw new Error('Commit or set aside existing changes before release');
        await runCommand('gh', ['auth', 'status'], { stdio: 'ignore' });
        await runCommand('git', ['fetch', 'origin', 'main', '--tags']);
        git('merge-base', '--is-ancestor', 'origin/main', 'HEAD');
        if (resume) {
          version = requested;
          validateResume(state, { version, sourceSha, platforms });
          if (!git('tag', '--list', `v${version}`)) throw new Error('Resume requires the original release tag');
        } else {
          const latest = publishedTags(repo).map(stableVersion).sort(compare).at(-1);
          version = requested ?? (latest ? [...parts(latest).slice(0, 2), parts(latest)[2] + 1n].join('.') : '0.1.0');
          if (latest && compare(version, latest) <= 0) throw new Error('Version is already published or older than the latest release; use a new version');
          if (latest) {
            const previous = `refs/tags/v${latest}`;
            git('merge-base', '--is-ancestor', previous, sourceSha);
            if (!git('log', '-1', '--no-merges', '--format=%H', `${previous}..${sourceSha}`)) throw new Error('No changes since the published release');
          }
          const existing = releaseByTag(repo, `v${version}`);
          if (existing && !existing.draft) throw new Error('Public versions cannot be overwritten');
        }
        assertSource();
      } else version = requested ?? version;
      parts(version);
      if (!resume) notes = await readReleaseNotes(version, { dryRun });
      env.ARC_BUILD_VERSION = version;
      process.env.ARC_BUILD_VERSION = version;
      base = releaseBase();
      console.log(`Release v${version} from ${sourceSha}; platforms: ${platforms.join(',')}; no version commit`);
    });
    if (resume) {
      for (const name of ['tests', 'UI smoke', 'macOS wall', 'Windows wall', 'Linux wall', 'platform critical path']) timer.skip(name);
    } else {
      output = path.resolve(await mkdtemp(path.join('release-artifacts', `v${version}-`)));
      console.log(`Release artifacts: ${output}`);
      const tests = async () => timer.run('tests', () => runCommand('npm', ['test'], { env: testEnvironment(buildOnlyEnv(env)) }));
      await timer.run('build/test critical path', async () => {
        await tests();
        if (mac || windows) await timer.run('UI smoke', () => runCommand('npm', ['run', 'accept:ui',
          ...(dryRun ? ['--', '--lane-fixtures', '--port=5287', '--no-screenshots'] : [])],
        { env: testEnvironment(buildOnlyEnv(env)) }));
        await timer.run('platform critical path', () => parallelPlatforms([
          ...(mac ? [() => timer.run('macOS wall', () => buildMac({ sourceSha, output, env, timer }))] : []),
          ...(windows ? [() => timer.run('Windows wall', () => buildWindows({ sourceSha, version, output, env, timer }))] : []),
          ...(linux ? [() => timer.run('Linux wall', () => buildLinux({ sourceSha, version, output, env, timer }))] : []),
        ]));
      });
      assertSource();
    }
    await timer.run('verification', async () => {
      const manifest = resume
        ? await json(path.join(output, 'latest.json'))
        : await finalize(output, platforms, notes, env);
      if (resume) await verifyFeeds(output, platforms, manifest, env);
      const assets = await releaseInventory(output, platforms, manifest, resume ? state.assets : undefined);
      if (!resume && !dryRun) {
        state = { schema: 1, version, sourceSha, platforms, verified: true, assets };
        await saveState();
      } else if (dryRun) await writeJson(path.join(output, 'rehearsal.json'), { sourceSha, version, platforms, assets });
    });
    if (!dryRun) {
      assertSource();
      if (!resume) await timer.run('tag/source push', async () => {
        if (!git('tag', '--list', `v${version}`)) git('tag', `v${version}`);
        git('push', '--atomic', 'origin', 'main', `refs/tags/v${version}`);
      });
      const tag = `v${version}`;
      let release = state.releaseId ? await releaseById(repo, state.releaseId) : releaseByTag(repo, tag);
      if (state.releaseId && (release?.id !== state.releaseId || release.tag_name !== tag)) throw new Error('Original release was removed or replaced; refusing to resume');
      const stages = publicationStages(state, release);
      if (stages.includes('upload')) await timer.run('upload', async () => {
        if (!release) {
          gh(['release', 'create', tag, '--repo', repo, '--draft', '--verify-tag', '--notes-file', path.join(output, 'release-notes.md')], { stdio: 'inherit' });
          release = releaseByTag(repo, tag);
        }
        if (!release?.draft) throw new Error('Expected a draft release');
        state.releaseId = release.id;
        await saveState();
        await boundedMap(state.assets, asset => transferRetry(asset.name, async () => {
          const uploaded = await uploadReleaseAsset({ repo, releaseId: state.releaseId, tag, asset, file: path.join(output, asset.name), timer });
          console.log(`${uploaded ? 'Uploaded' : 'Already uploaded'}: ${asset.name}`);
        }));
      });
      else {
        timer.skip('upload');
        state.releaseId = release.id;
        await saveState();
      }
      await timer.run('remote verification', async () => {
        release = await releaseById(repo, state.releaseId);
        if (!release || release.id !== state.releaseId || release.tag_name !== tag) throw new Error('Original release changed');
        validateRemoteAssets(state.assets, release.assets);
        await boundedMap(state.assets, async asset => {
          const remote = release.assets.find(item => item.name === asset.name);
          if (!remote.digest) {
            // Older GitHub assets have no digest: download and hash without buffering binaries in gh.
            const temp = await mkdtemp(path.join(timingDir, 'verify-'));
            try {
              await transferRetry(asset.name, () => ghTransfer(['release', 'download', tag, '--repo', repo, '--pattern', asset.name, '--dir', temp, '--clobber']));
              const file = path.join(temp, asset.name);
              if ((await stat(file)).size !== asset.size || await fileDigest(file) !== asset.digest) throw new Error(`Remote checksum mismatch: ${asset.name}`);
            } finally { await rm(temp, { recursive: true, force: true }); }
          }
        });
      });
      if (stages.includes('publish')) await timer.run('publish', async () => {
        assertSource();
        validateRemoteAssets(state.assets, (await requireDraftRelease(repo, state.releaseId, tag)).assets);
        // Persist before the request: a lost publish response must resume as read-only readback.
        state.publishAttempted = true;
        await saveState();
        gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest', '--notes-file', path.join(output, 'release-notes.md')], { stdio: 'inherit' });
      });
      else timer.skip('publish');
      await timer.run('readback', async () => {
        const names = ['latest.json', ...platforms.filter(platform => updateTargets[platform]).map(platform => feedName(updateTargets[platform]))];
        await boundedMap(names, name => transferRetry(`public ${name}`, async () => {
          const current = await releaseById(repo, state.releaseId);
          if (!current || current.draft || current.id !== state.releaseId || current.tag_name !== tag) throw new Error('Release is not public');
          const response = await fetch(`https://github.com/${repo}/releases/latest/download/${name}`, { signal: AbortSignal.timeout(60_000), cache: 'no-store' });
          if (!response.ok) throw new Error(`Public ${name} returned HTTP ${response.status}`);
          const bytes = Buffer.from(await response.arrayBuffer());
          const expected = state.assets.find(asset => asset.name === name);
          if (bytes.length !== expected.size || `sha256:${hash(bytes)}` !== expected.digest) throw new Error(`Public ${name} does not match this release`);
        }));
        state.complete = true;
        await saveState();
      });
      await retainBuildArtifacts(process.cwd(), true);
    } else for (const name of ['tag/source push', 'upload', 'remote verification', 'publish', 'readback']) timer.skip(name);
  } catch (error) {
    if (state?.verified && output) console.error(`Resume after resolving the failure: npm run release -- --resume ${JSON.stringify(path.resolve(output))}`);
    throw error;
  } finally {
    const rows = (await readFile(timingFile, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    console.log(`Stage timings: ${timingFile}`);
    console.table(rows);
    console.log(`Overall wall: ${((Date.now() - startedAt) / 1000).toFixed(1)}s (nested stages overlap)`);
  }
}

if (mode === 'release') {
  const options = {};
  const flags = new Set();
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (['--version', '--platforms', '--resume', '--local-output', '--test-keys'].includes(option)) {
      const key = option.slice(2);
      if (!args[i + 1] || args[i + 1].startsWith('--') || options[key] !== undefined) throw new Error(`Invalid or repeated ${option}`);
      options[key] = args[++i];
    } else if (['--dry-run', '--with-extended'].includes(option) && !flags.has(option)) flags.add(option);
    else throw new Error('release [--dry-run] [--with-extended] [--version X.Y.Z] [--platforms mac,windows,linux] [--resume DIR] [--local-output DIR --test-keys DIR]');
  }
  const resume = options.resume !== undefined;
  const dryRun = flags.has('--dry-run');
  const withExtended = flags.has('--with-extended');
  if (resume && dryRun) throw new Error('--resume cannot be combined with --dry-run');
  if (options['local-output'] || options['test-keys']) {
    if (!dryRun || !options['local-output'] || !options['test-keys'] || !options.version) {
      throw new Error('Local rehearsal requires --dry-run --version X.Y.Z --local-output DIR --test-keys DIR.');
    }
    version = stableVersion(options.version);
    base = releaseBase();
    await localRehearsal(options['local-output'], options['test-keys'], releasePlatforms(options.platforms));
  } else {
    await coordinateRelease(options, { resume, dryRun, withExtended });
  }
} else if (mode === 'stage') {
  const [legacyTarget, input, output] = args;
  const target = { 'darwin-aarch64': 'darwin-arm64', 'windows-x86_64': 'windows-amd64' }[legacyTarget] || legacyTarget;
  if (!Object.values(updateTargets).includes(target) || !input || !output || args.length !== 3) throw new Error('stage <darwin-arm64|windows-amd64> <platform-dir> <output-dir>');
  checkLegacyUpdatePublicKey();
  if (target === 'darwin-arm64') executePackageCheck(input);
  await requireEmptyStage(output);
  await collectDesktop({ target, version, input: path.resolve(input), output: path.resolve(output) });
  await signLegacyPayload({ target, version, output, base });
  console.log(`Staged ${target} artifacts for metadata generation.`);
} else if (mode === 'finalize') {
  const [output] = args;
  if (!output || args.length !== 1) throw new Error('finalize <artifact-dir>');
  const entries = await readdir(output);
  const selected = Object.entries(updateTargets).filter(([, target]) => entries.includes(fragmentName(target))).map(([platform]) => platform);
  if (entries.includes(`agent-remote-control-v${version}-linux-x86_64.tar.gz`)) selected.push('linux');
  if (!selected.length) throw new Error('No platform artifacts');
  if (selected.some(platform => updateTargets[platform])) checkLegacyUpdatePublicKey();
  const manifest = await finalize(output, selected, await readReleaseNotes(version));
  await releaseInventory(output, selected, manifest);
  console.log('Release metadata generated for staged platforms.');
} else throw new Error('Expected release, stage, or finalize');

function executePackageCheck(directory) {
  if (process.platform !== 'darwin') throw new Error('macOS artifacts must be verified on a Mac before staging');
  execFileSync(process.execPath, ['tooling/check-package.mjs', path.join(directory, 'Agent Remote Control.app')],
    { env: buildOnlyEnv(), stdio: 'inherit' });
}
