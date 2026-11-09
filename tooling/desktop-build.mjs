import { requireMainCheckout } from './coding-lane.mjs';
requireMainCheckout();
import { enterHeavyBuild } from './heavy-build.mjs';
enterHeavyBuild();
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildEnv } from './build-env.mjs';
import { releaseSigningEnv } from './release-signing.mjs';
import { macosSigningIdentity } from './macos-signing.mjs';
import { compileIcon, requireXcode } from './macos-icons.mjs';
import { stageTimer } from './release-support.mjs';
import { buildNative } from './build-native.mjs';
const root = new URL('../', import.meta.url);
const args = [fileURLToPath(new URL('node_modules/@tauri-apps/cli/tauri.js', root)), 'build'];
if (process.platform === 'win32') args.push('--config', 'tauri.windows.conf.json');
const unsigned = process.argv.includes('--unsigned-updater');
if (unsigned && process.platform !== 'win32') throw new Error('--unsigned-updater is only supported on the Windows worker');
const signing = unsigned ? {} : releaseSigningEnv(process.argv.includes('--release'));
if (signing.TAURI_SIGNING_PRIVATE_KEY) args.push('--config', JSON.stringify({ bundle: { createUpdaterArtifacts: true } }));
const buildArgs = process.argv.slice(2).filter(a => !['--release', '--unsigned-updater'].includes(a));
const targetAt = buildArgs.findIndex(a => a === '--target' || a.startsWith('--target='));
let target = targetAt < 0 ? undefined : buildArgs[targetAt] === '--target' ? buildArgs[targetAt + 1] : buildArgs[targetAt].slice('--target='.length);
if (targetAt >= 0 && !target) throw new Error('--target requires a target triple');
if (process.platform === 'darwin' && target && target !== 'aarch64-apple-darwin') throw new Error('macOS packages support only aarch64-apple-darwin');
if (!target) {
  target = process.platform === 'darwin' ? 'aarch64-apple-darwin' : process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : undefined;
  if (target) buildArgs.push('--target', target);
}
args.push(...buildArgs);
const debug = buildArgs.some(a => a === '--debug' || a === '-d');
const profile = debug ? 'debug' : 'release';
const env = buildEnv(!debug);
// Local-install candidates retain incremental dev builds without shipping assertions.
if (debug) {
  env.CARGO_PROFILE_DEV_OPT_LEVEL = '1';
  env.CARGO_PROFILE_DEV_DEBUG_ASSERTIONS = 'false';
}
if (unsigned) for (const key of Object.keys(env)) if (/^(TAURI_SIGNING_|CSC_|WIN_CSC_)/.test(key)) delete env[key];
args.push('--config', JSON.stringify({ version: env.ARC_BUILD_VERSION }));
for (const key of ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD']) {
  if (signing[key] !== undefined) env[key] = signing[key];
}
const identity = macosSigningIdentity(env, { release: true });
for (const key of Object.keys(env)) if (/^(CSC_|WIN_CSC_)/.test(key)) delete env[key];
if (process.platform === 'darwin') args.push('--config', JSON.stringify({ bundle: { macOS: {
  signingIdentity: identity, hardenedRuntime: true,
} } }));
if (process.platform === 'darwin' && !buildArgs.includes('--no-bundle')) {
  requireXcode(env);
  compileIcon(fileURLToPath(new URL('desktop/icons/AgentRemoteControl.icon', root)),
    fileURLToPath(new URL('target/release-icon/', root)), env);
  args.push('--config', JSON.stringify({ bundle: { icon: [
    'icons/icon.png', 'icons/macos/Icon.icns', '../target/release-icon/Assets.car',
  ] } }));
}
const prune = fileURLToPath(new URL('tooling/prune-build-cache.mjs', root));
execFileSync(process.execPath, [prune, `--keep=target/${target || profile}`], { cwd: fileURLToPath(root), env, stdio: 'inherit' });
execFileSync(process.execPath, [fileURLToPath(new URL('tooling/prepare-desktop.mjs', root)), ...buildArgs],
  { cwd: fileURLToPath(root), env, stdio: 'inherit' });
const timed = (name, operation) => process.env.ARC_RELEASE_TIMINGS_FILE ? stageTimer().run(name, operation) : operation();
const packageDesktop = async () => {
  const tauriOptions = { cwd: fileURLToPath(new URL('desktop/', root)), env, stdio: 'inherit' };
  const common = args.slice(2).filter(value => value !== '--no-bundle');
  await timed('Rust Desktop/Core build', async () => execFileSync(process.execPath,
    [args[0], 'build', ...common, '--features', 'core-bin', '--no-bundle'], tauriOptions));
  await timed('Core staging/sign', () => buildNative({ release: !debug, target, bundled: true, stageOnly: true }));
  if (!buildArgs.includes('--no-bundle')) await timed(process.platform === 'win32' ? 'NSIS bundle' : 'macOS app bundle/sign', async () => {
    // Core is already packaged as a resource; keep it out of the installer's root binary list.
    execFileSync(process.execPath, [args[0], 'bundle', ...common], tauriOptions);
  });
  if (process.platform === 'darwin' && !buildArgs.includes('--no-bundle')) {
    execFileSync(process.execPath, [fileURLToPath(new URL('tooling/check-package.mjs', root)),
      `target/aarch64-apple-darwin/${profile}/bundle/macos/Agent Remote Control.app`],
    { cwd: fileURLToPath(root), env, stdio: 'inherit' });
    await timed('macOS DMG', async () => execFileSync('uv', ['run', '--script', fileURLToPath(new URL('tooling/build-dmg.py', root)),
      profile], { cwd: fileURLToPath(root), env, stdio: 'inherit' }));
  }
  execFileSync(process.execPath, [prune, `--keep=target/${target || profile}`],
    { cwd: fileURLToPath(root), env, stdio: 'inherit' });
};
if (process.env.ARC_RELEASE_TIMINGS_FILE) await stageTimer().run('Rust Desktop build/sign', packageDesktop);
else await packageDesktop();
