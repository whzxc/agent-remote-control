import { requireMainCheckout } from './coding-lane.mjs';
requireMainCheckout();
import { readFile, writeFile, readdir, mkdir, copyFile, mkdtemp, stat, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWindows, buildMac, runCommand, prepareWindowsWorker } from './windows-release.mjs';
import { buildLinux, preflightLinux } from './linux-release.mjs';
import { testEnvironment } from './test-environment.mjs';
import { buildVersion, stableVersion } from './version.mjs';
import { readReleaseNotes } from './release-notes.mjs';
import { releaseSigningEnv } from './release-signing.mjs';
import { macosSigningIdentity, verifyMacosReleaseSignature } from './macos-signing.mjs';
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
async function files(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await files(file)); else out.push(file);
  }
  return out;
}
function verifySignatures(artifacts) {
  try {
    execFileSync('cargo', ['run', '--quiet', '--locked', '--manifest-path', 'tooling/verifier/Cargo.toml', '--', 'desktop/tauri.conf.json', ...artifacts], { stdio: 'inherit' });
  } finally {
    execFileSync(process.execPath, ['tooling/prune-build-cache.mjs'], { stdio: 'inherit' });
  }
}
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
    if (name !== path.basename(name) || !/\.(gz|exe)$/.test(name)) throw new Error('Invalid updater asset name');
    if ((await readFile(path.join(dir,name+'.sig'),'utf8')).trim() !== value.signature) throw new Error('Manifest signature mismatch');
    await readFile(path.join(dir,name));
  }

}
async function cask(dir) {
  const dmg = (await files(dir)).filter(f => f.endsWith('_aarch64.dmg'));
  if (dmg.length !== 1) throw new Error('Expected one Apple Silicon DMG');
  await writeFile(path.join(dir, 'agent-remote-control.rb'), `cask "agent-remote-control" do
  version "${version}"
  sha256 "${hash(await readFile(dmg[0]))}"

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
if (mode === 'release') {
  const options = {};
  const flags = new Set();
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (['--version', '--platforms', '--resume'].includes(option)) {
      const key = option.slice(2);
      if (!args[i + 1] || args[i + 1].startsWith('--') || options[key] !== undefined) throw new Error(`Invalid or repeated ${option}`);
      options[key] = args[++i];
    } else if (['--skip-tests', '--dry-run'].includes(option) && !flags.has(option)) flags.add(option);
    else throw new Error('release [--dry-run] [--skip-tests] [--version X.Y.Z] [--platforms mac,windows,linux] [--resume <artifact-dir>]');
  }
  const resume = options.resume !== undefined;
  const dryRun = flags.has('--dry-run');
  if (resume && dryRun) throw new Error('--resume cannot be combined with --dry-run');
  const saved = resume ? await json(path.join(options.resume, 'release-state.json')) : undefined;
  const requested = options.version === undefined ? saved?.version : stableVersion(options.version);
  const platforms = releasePlatforms(options.platforms ?? saved?.platforms?.join(','));
  const mac = platforms.includes('mac');
  const windows = platforms.includes('windows');
  const linux = platforms.includes('linux');
  await mkdir('release-artifacts', { recursive: true });
  const timingDir = await mkdtemp(path.join('release-artifacts', '.timings-'));
  const timingFile = path.resolve(timingDir, 'stages.jsonl');
  await writeFile(timingFile, '');
  const timer = stageTimer(timingFile);
  const startedAt = Date.now();
  let output = resume ? path.resolve(options.resume) : undefined;
  let state = saved;
  let sourceSha;
  let env;
  let workerPreparation, workerCleanup;
  const releaseWorker = () => {
    if (workerPreparation && !workerCleanup) {
      workerCleanup = workerPreparation.then(worker => worker.cleanup());
      workerCleanup.catch(() => {});
    }
    return workerCleanup;
  };
  const run = (script, ...args) => execFileSync(process.execPath, [script, ...args], { env, stdio: 'inherit' });
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
    await timer.run('checks', async () => {
      if (!resume && (mac || windows) && (process.platform !== 'darwin' || process.arch !== 'arm64')) throw new Error('macOS releases require a local build and signing on an Apple Silicon Mac');
      env = !resume && (mac || windows) ? releaseSigningEnv(true) : { ...process.env };
      env.ARC_RELEASE_TIMINGS_FILE = timingFile;
      if (!resume && mac) macosSigningIdentity(env, { release: true });
      sourceSha = git('rev-parse', 'HEAD');
      if (git('status', '--porcelain')) throw new Error('Release builds require a clean committed source');
      if (!resume && linux) await preflightLinux(sourceSha);
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
      if (!resume) await readReleaseNotes(version);
      if (!resume && windows) {
        workerPreparation = prepareWindowsWorker({ timer });
        workerPreparation.catch(() => {});
      }
      env.ARC_BUILD_VERSION = version;
      process.env.ARC_BUILD_VERSION = version;
      base = `https://github.com/${repo}/releases/download/v${version}`;
      console.log(`Release v${version} from ${sourceSha}; platforms: ${platforms.join(',')}; no version commit`);
    });
    if (resume) {
      for (const name of ['tests', 'macOS wall', 'Windows wall', 'Linux wall', 'platform critical path']) timer.skip(name);
    } else {
      output = path.resolve(await mkdtemp(path.join('release-artifacts', `v${version}-`)));
      console.log(`Release artifacts: ${output}`);
      const tests = async () => {
        if (flags.has('--skip-tests')) {
          console.log('Tests explicitly skipped.');
          timer.skip('tests');
        } else await timer.run('tests', () => runCommand('npm', ['test'], { env: testEnvironment(env) }));
      };
      await timer.run('build/test critical path', async () => {
        await tests();
        await timer.run('platform critical path', () => parallelPlatforms([
          ...(mac ? [() => timer.run('macOS wall', () => buildMac({ sourceSha, output, env, timer }))] : []),
          ...(windows ? [() => timer.run('Windows wall', () => buildWindows({ sourceSha, version, output, env, timer,
            worker: workerPreparation, onCollected: releaseWorker }))] : []),
          ...(linux ? [() => timer.run('Linux wall', () => buildLinux({ sourceSha, version, output, timer, platforms }))] : []),
        ]));
      });
      assertSource();
    }
    await timer.run('verification', async () => {
      const selected = platforms;
      if (!resume) run('tooling/release.mjs', 'finalize', output);
      const manifest = await json(path.join(output, 'latest.json'));
      await validateManifest(manifest, output);
      const names = platformAssetNames(manifest, version, selected);
      const assets = await Promise.all(names.map(async name => ({ name, size: (await stat(path.join(output, name))).size, digest: await fileDigest(path.join(output, name)) })));
      // Checksums must describe exactly the payloads about to be uploaded.
      validateArtifactInventory(assets, await readFile(path.join(output, 'SHA256SUMS.txt'), 'utf8'), resume ? state.assets : undefined);
      if (!resume && !dryRun) {
        state = { schema: 1, version, sourceSha, platforms, verified: true, assets };
        await saveState();
      }
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
        await transferRetry('public latest.json', async () => {
          const current = await releaseById(repo, state.releaseId);
          if (!current || current.draft || current.id !== state.releaseId || current.tag_name !== tag) throw new Error('Release is not public');
          const response = await fetch(`https://github.com/${repo}/releases/latest/download/latest.json`, { signal: AbortSignal.timeout(60_000), cache: 'no-store' });
          if (!response.ok) throw new Error(`Public latest.json returned HTTP ${response.status}`);
          const bytes = Buffer.from(await response.arrayBuffer());
          const expected = state.assets.find(asset => asset.name === 'latest.json');
          if (bytes.length !== expected.size || `sha256:${hash(bytes)}` !== expected.digest) throw new Error('Public latest.json does not match this release');
        });
        state.complete = true;
        await saveState();
      });
    } else for (const name of ['tag/source push', 'upload', 'remote verification', 'publish', 'readback']) timer.skip(name);
  } catch (error) {
    if (state?.verified && output) console.error(`Resume after resolving the failure: npm run release -- --resume ${JSON.stringify(path.resolve(output))}`);
    throw error;
  } finally {
    try { await releaseWorker(); }
    catch (error) { console.error(`Windows worker cleanup failed: ${error.message}`); process.exitCode = 1; }
    const rows = (await readFile(timingFile, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    console.log(`Stage timings: ${timingFile}`);
    console.table(rows);
    console.log(`Overall wall: ${((Date.now() - startedAt) / 1000).toFixed(1)}s (nested stages overlap)`);
  }
} else if (mode === 'stage') {
  const [target, input, output] = args;
  if (!['darwin-aarch64','windows-x86_64'].includes(target) || !input || !output) throw new Error('stage <darwin-aarch64|windows-x86_64> <bundle-dir> <output-dir>');
  if (target === 'darwin-aarch64') {
    if (process.platform !== 'darwin') throw new Error('macOS artifacts must have their signatures verified on a Mac before staging');
    const app = path.join(input, 'macos/Agent Remote Control.app');
    verifyMacosReleaseSignature(app, 'com.whzxc.agent-remote-control');
    execFileSync(process.execPath, ['tooling/check-package.mjs', app], { stdio: 'inherit' });
  }
  await mkdir(output,{recursive:true});
  if ((await readdir(output)).length) throw new Error('Stage directory must be empty; use a fresh directory');
  const productName = (await json('desktop/tauri.conf.json')).productName;
  const candidates = (await files(input)).filter(f => {
    const name = path.basename(f);
    return target === 'darwin-aarch64'
      ? [`agent-remote-control_${version}_aarch64.dmg`, `${productName}.app.tar.gz`, `${productName}.app.tar.gz.sig`].includes(name)
      : name.startsWith(`${productName}_${version}_`) && /\.exe(?:\.sig)?$/.test(name);
  });
  for (const file of candidates) {
    let name = path.basename(file).replace(/^Agent Remote Control/, 'agent-remote-control').replaceAll(' ','.');
    if (target === 'darwin-aarch64' && name.includes('.app.tar.gz')) name = name.replace('.app.tar.gz', `_${version}_aarch64.app.tar.gz`);
    await copyFile(file,path.join(output,name));
  }
  const staged = await files(output);
  const payloads = staged.filter(f => target === 'darwin-aarch64' ? f.endsWith('.app.tar.gz') : /\.exe$/.test(f));
  if (payloads.length !== 1) throw new Error('Missing/duplicate updater bundles');
  if (target === 'darwin-aarch64' && staged.filter(f=>f.endsWith('_aarch64.dmg')).length !== 1) throw new Error('Missing Apple Silicon DMG');
  const platforms = {};
  for (const file of payloads) {
    const value = { signature:(await readFile(file+'.sig','utf8')).trim(), url:`${base}/${path.basename(file)}` };
    const keys = target === 'darwin-aarch64' ? ['darwin-aarch64'] : ['windows-x86_64','windows-x86_64-nsis'];
    for (const key of keys) platforms[key] = value;
  }
  await writeJson(path.join(output,`${target}.json`), { version, platforms });
  console.log(`Staged ${target} artifacts for metadata generation.`);
} else if (mode === 'finalize') {
  const [dir] = args;
  if (!dir) throw new Error('finalize <artifact-dir>');
  const entries = await readdir(dir);
  const fragments = entries.filter(name => ['darwin-aarch64.json', 'windows-x86_64.json'].includes(name));
  const linux = entries.filter(name => name === `agent-remote-control-v${version}-linux-x86_64.tar.gz` || name === `agent-remote-control-v${version}-linux-aarch64.tar.gz`);
  if (!fragments.length && !linux.length) throw new Error('No platform artifacts');
  const notes = await readReleaseNotes(version);
  const manifest = { version, notes: notes.en, notes_zh_cn: notes.zh, pub_date: new Date().toISOString(), platforms: {} };
  for (const name of fragments) {
    const fragment = await json(path.join(dir, name));
    if (fragment.version !== version) throw new Error('Mixed release versions');
    Object.assign(manifest.platforms, fragment.platforms);
  }
  await validateManifest(manifest, dir);
  const payloads = [...new Set(Object.values(manifest.platforms).map(value => path.join(dir, value.url.slice(base.length + 1))))];
  if (payloads.length) verifySignatures(payloads);
  await writeFile(path.join(dir, 'release-notes.md'), notes.body);
  if (manifest.platforms['darwin-aarch64']) await cask(dir);
  await writeJson(path.join(dir, 'latest.json'), manifest);
  const assets = (await files(dir)).filter(f => /\.(dmg|exe|gz|sig)$/.test(f) || ['agent-remote-control.rb', 'latest.json', 'release-notes.md', 'install-agent-remote-control.sh'].includes(path.basename(f)));
  const sums = new Map();
  for (const file of assets) sums.set(path.basename(file), hash(await readFile(file)));
  await writeFile(path.join(dir, 'SHA256SUMS.txt'), [...sums].sort(([a], [b]) => a.localeCompare(b)).map(([name, digest]) => `${digest}  ${name}`).join('\n') + '\n');
  console.log('Release metadata generated for staged platforms.');
} else throw new Error('Expected release, stage, or finalize');
