import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildEnv } from './build-env.mjs';
import { releaseSigningEnv } from './release-signing.mjs';
import { macosSigningIdentity } from './macos-signing.mjs';
import { compileIcon, requireXcode } from './macos-icons.mjs';
const root = new URL('../', import.meta.url);
const args = [fileURLToPath(new URL('node_modules/@tauri-apps/cli/tauri.js', root)), 'build'];
if (process.platform === 'win32') args.push('--config', 'tauri.windows.conf.json');
const signing = releaseSigningEnv(process.argv.includes('--release'));
if (signing.TAURI_SIGNING_PRIVATE_KEY) args.push('--config', JSON.stringify({ bundle: { createUpdaterArtifacts: true } }));
const buildArgs = process.argv.slice(2).filter(a => a !== '--release');
const targetAt = buildArgs.findIndex(a => a === '--target' || a.startsWith('--target='));
let target = targetAt < 0 ? undefined : buildArgs[targetAt] === '--target' ? buildArgs[targetAt + 1] : buildArgs[targetAt].slice('--target='.length);
if (targetAt >= 0 && !target) throw new Error('--target 需要目标三元组');
if (process.platform === 'darwin' && target && target !== 'aarch64-apple-darwin') throw new Error('macOS 安装包仅支持 aarch64-apple-darwin');
if (!target) {
  target = process.platform === 'darwin' ? 'aarch64-apple-darwin' : process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : undefined;
  if (target) buildArgs.push('--target', target);
}
args.push(...buildArgs);
const debug = buildArgs.some(a => a === '--debug' || a === '-d');
const profile = debug ? 'debug' : 'release';
const env = buildEnv(!debug);
args.push('--config', JSON.stringify({ version: env.CLC_BUILD_VERSION }));
for (const key of ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD']) {
  if (signing[key] !== undefined) env[key] = signing[key];
}
const identity = macosSigningIdentity(env);
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
execFileSync(process.execPath, args, { cwd: fileURLToPath(new URL('desktop/', root)), env, stdio: 'inherit' });
if (process.platform === 'darwin' && !buildArgs.includes('--no-bundle')) {
  execFileSync(process.execPath, [fileURLToPath(new URL('tooling/check-package.mjs', root)),
    `target/aarch64-apple-darwin/${profile}/bundle/macos/Agent Remote Control.app`],
  { cwd: fileURLToPath(root), env, stdio: 'inherit' });
  execFileSync('uv', ['run', '--script', fileURLToPath(new URL('tooling/build-dmg.py', root)),
    profile], { cwd: fileURLToPath(root), env, stdio: 'inherit' });
}
execFileSync(process.execPath, [prune, `--keep=target/${target || profile}`],
  { cwd: fileURLToPath(root), env, stdio: 'inherit' });
