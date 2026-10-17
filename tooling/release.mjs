import { readFile, writeFile, readdir, mkdir, copyFile, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildVersion, stableVersion } from './version.mjs';
import { releaseSigningEnv } from './release-signing.mjs';
import { macosSigningIdentity, verifyMacosReleaseSignature } from './macos-signing.mjs';
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
  execFileSync('cargo', ['run', '--quiet', '--locked', '--manifest-path', 'tooling/verifier/Cargo.toml', '--', 'desktop/tauri.conf.json', ...artifacts], { stdio: 'inherit' });
}
async function validateManifest(manifest, dir, keys = Object.keys(manifest.platforms)) {
  if (manifest.version !== version || !manifest.platforms['darwin-aarch64']) throw new Error('Invalid release manifest');
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
function previousPublished() {
  const tags=execFileSync('gh',['api',`repos/${repo}/releases`,'--paginate','--jq','.[] | select(.draft == false and .prerelease == false) | .tag_name'],{encoding:'utf8'}).trim();
  return tags ? tags.split('\n').map(tag=>tag.replace(/^v/,'')).filter(value => compare(value, version) < 0).sort(compare).at(-1) : undefined;
}
function changesSince(previous) {
  const range=previous ? `refs/tags/v${previous}..HEAD` : 'HEAD';
  if(previous) {
    git('rev-parse','--verify',`refs/tags/v${previous}`);
    git('merge-base','--is-ancestor',`refs/tags/v${previous}`,'HEAD');
  }
  const messages=git('log','--no-merges','--format=%s',range);
  if(!messages) throw new Error('No changes since the published release');
  return messages.split('\n').map(subject=>`- ${subject}`).join('\n');
}
async function notes() {
  const previous = previousPublished();
  const changes = changesSince(previous);
  // Include the manual identity change only when upgrading from an old release.
  if (!previous || !git('show', `refs/tags/v${previous}:native/src/lib.rs`).includes('chatgpt-local-connector')) return changes;
  const migration = 'for base in "$HOME/.local/state" "${XDG_STATE_HOME:-$HOME/.local/state}" "${XDG_CONFIG_HOME:-$HOME/.config}"; do for suffix in "" -dev -preview; do old="$base/chatgpt-local-connector$suffix"; new="$base/agent-remote-control$suffix"; if [ -d "$old" ] && [ ! -e "$new" ]; then mv "$old" "$new" || exit; fi; done; done';
  return `${changes}\n\n## Upgrading from CLC\n\nDisable the old login item and quit ARC before installing/opening this update. On macOS/Linux, move existing state once (existing destinations are left untouched):\n\n\`\`\`sh\n${migration}\n\`\`\`\n\nOn Windows, move %LOCALAPPDATA%/chatgpt-local-connector to %LOCALAPPDATA%/agent-remote-control (and the -dev/-preview variants) before opening the new app. Re-enable login items and grant macOS permissions to the new app identity. Maintainers: move ~/.tauri/local-connector.key to ~/.tauri/agent-remote-control.key. No automatic migration is performed.\n`;
}
if (mode === 'release') {
  const versionAt = args.indexOf('--version');
  const requested = versionAt < 0 ? undefined : stableVersion(args[versionAt + 1] || '');
  const flags = versionAt < 0 ? args : args.filter((_, index) => index !== versionAt && index !== versionAt + 1);
  if (flags.some(arg => !['--skip-tests', '--dry-run', '--ci'].includes(arg))) throw new Error('release [--dry-run | --ci] [--skip-tests] [--version 0.8.29]');
  const dryRun = args.includes('--dry-run');
  const ci = args.includes('--ci');
  if (ci && dryRun) throw new Error('--ci 与 --dry-run 不能同时使用');
  if (!ci && (process.platform !== 'darwin' || process.arch !== 'arm64')) throw new Error('本地发布需要 Apple Silicon Mac；其他主机请使用 --ci');
  // Fail before compilation, and pass credentials only in the environment.
  const env = ci ? { ...process.env } : releaseSigningEnv(true);
  let sourceSha;
  if (!ci) macosSigningIdentity(env, { release: true });
  const run = (script, ...options) => execFileSync(process.execPath, [script, ...options], { env, stdio: 'inherit' });
  if (!dryRun) {
    if (git('branch', '--show-current') !== 'main') throw new Error('Run release from main');
    if (git('status', '--porcelain')) throw new Error('Commit or set aside existing changes before release');
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
    git('fetch', 'origin', 'main', '--tags');
    git('merge-base', '--is-ancestor', 'origin/main', 'HEAD');
    const published = execFileSync('gh', ['api', `repos/${repo}/releases`, '--paginate', '--jq', '.[] | select(.draft == false and .prerelease == false) | .tag_name'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(stableVersion).sort(compare);
    const latest = published.at(-1);
    version = requested ?? (latest ? [...parts(latest).slice(0, 2), parts(latest)[2] + 1n].join('.') : '0.1.0');
    if (latest && compare(version, latest) <= 0) throw new Error('Version is already published or older than the latest release; use a new version');
    const tag = `v${version}`;
    if (git('tag', '--list', tag) && git('rev-parse', `${tag}^{commit}`) !== git('rev-parse', 'HEAD')) throw new Error(`${tag} belongs to another commit`);
    sourceSha = git('rev-parse', 'HEAD');
    console.log(`Release ${tag} from ${sourceSha}; no version commit`);
    if (!args.includes('--skip-tests')) execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'], { env: { ...env, ARC_BUILD_VERSION: version }, stdio: 'inherit', shell: process.platform === 'win32' });
  } else version = requested ?? version;
  parts(version);
  env.ARC_BUILD_VERSION = version;
  process.env.ARC_BUILD_VERSION = version;
  base = `https://github.com/${repo}/releases/download/v${version}`;
  let output;
  if (!ci) {
    run('tooling/desktop-build.mjs', '--release', '--target', 'aarch64-apple-darwin');
    await mkdir('release-artifacts', { recursive: true });
    output = await mkdtemp(path.join('release-artifacts', `v${version}-`));
    // Every child uses the same version without editing the checkout.
    run('tooling/release.mjs', 'stage', 'darwin-aarch64', 'target/aarch64-apple-darwin/release/bundle', output);
    run('tooling/release.mjs', 'finalize', output);
    console.log(`Release artifacts: ${path.resolve(output)}`);
  }
  if (!dryRun) {
    if (git('status', '--porcelain') || git('rev-parse', 'HEAD') !== sourceSha) throw new Error('Source changed during release; refusing to tag or publish');
    if (!git('tag', '--list', `v${version}`)) git('tag', `v${version}`);
    git('push', '--atomic', 'origin', 'main', `refs/tags/v${version}`);
    if (ci) execFileSync('gh', ['workflow', 'run', 'release.yml', '--ref', 'main', '-f', `tag=v${version}`], { stdio: 'inherit' });
    else {
      const assets = (await files(output)).filter(file => path.basename(file) !== 'darwin-aarch64.json');
      const existing = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/releases`, '--paginate', '--slurp'], { encoding: 'utf8' })).flat().find(release => release.tag_name === `v${version}`);
      if (existing && !existing.draft) throw new Error('Release already published');
      if (!existing) execFileSync('gh', ['release', 'create', `v${version}`, '--draft', '--verify-tag', '--notes-file', path.join(output, 'release-notes.md')], { stdio: 'inherit' });
      execFileSync('gh', ['release', 'upload', `v${version}`, ...assets, '--clobber'], { stdio: 'inherit' });
      execFileSync('gh', ['release', 'edit', `v${version}`, '--draft=false', '--latest', '--notes-file', path.join(output, 'release-notes.md')], { stdio: 'inherit' });
    }
  }
} else if (mode === 'stage') {
  const [target, input, output] = args;
  if (!['darwin-aarch64','windows-x86_64'].includes(target) || !input || !output) throw new Error('stage <darwin-aarch64|windows-x86_64> <bundle-dir> <output-dir>');
  if (target === 'darwin-aarch64') {
    if (process.platform !== 'darwin') throw new Error('macOS 产物必须在 Mac 上验签后整理');
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
} else if (mode === 'finalize' || mode === 'merge-windows') {
  const [dir] = args;
  if (!dir) throw new Error(`${mode} <artifact-dir>`);
  const windows = mode === 'merge-windows';
  const fragment = await json(path.join(dir, windows ? 'windows-x86_64.json' : 'darwin-aarch64.json'));
  if (fragment.version !== version) throw new Error('Mixed release versions');
  const manifest = windows ? await json(path.join(dir, 'latest.json')) : {
    version, notes: await notes(), pub_date: new Date().toISOString(), platforms: {},
  };
  Object.assign(manifest.platforms, fragment.platforms);
  await validateManifest(manifest, dir, Object.keys(fragment.platforms));
  const payloads = [...new Set(Object.values(fragment.platforms).map(value => path.join(dir, value.url.slice(base.length + 1))))];
  verifySignatures(payloads);
  if (!windows) {
    await writeFile(path.join(dir, 'release-notes.md'), manifest.notes + '\n');
    await cask(dir);
  }
  const sumsFile = path.join(dir, 'SHA256SUMS.txt');
  const sums = new Map();
  if (windows) {
    for (const line of (await readFile(sumsFile, 'utf8')).trim().split('\n')) {
      const [, digest, name] = line.match(/^([a-f0-9]{64})  (.+)$/) ?? [];
      if (!name) throw new Error('Invalid SHA256SUMS entry');
      // Replace all previous Windows checksums, including renamed installers.
      if (!/\.exe(?:\.sig)?$/.test(name)) sums.set(name, digest);
    }
  }
  await writeJson(path.join(dir, 'latest.json'), manifest);
  const assets = (await files(dir)).filter(f => /\.(dmg|exe|gz|sig)$/.test(f) || ['agent-remote-control.rb', 'latest.json', 'release-notes.md'].includes(path.basename(f)));
  for (const file of assets) sums.set(path.basename(file), hash(await readFile(file)));
  await writeFile(sumsFile, [...sums].sort(([a], [b]) => a.localeCompare(b)).map(([name, digest]) => `${digest}  ${name}`).join('\n') + '\n');
  console.log(windows ? 'Windows metadata merged; existing macOS entries preserved.' : 'macOS release metadata generated.');
} else throw new Error('Expected release, stage, finalize, or merge-windows');
