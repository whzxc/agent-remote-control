import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { compileIcon, requireXcode } from './macos-icons.mjs';

import { devStateDir } from './dev-state.mjs';
import { buildNative } from './build-native.mjs';
import { buildEnv } from './build-env.mjs';

// One development process owns the core and all desktop windows.
const root = new URL('../', import.meta.url);
if (process.argv.includes('--release')) throw new Error('dev 仅运行开发模式；发行构建请用 desktop:build。');
const env = { ...buildEnv(), CLC_STATE_DIR: devStateDir };
let owner;
try {
  const info = JSON.parse(readFileSync(path.join(devStateDir, 'web/native.json'), 'utf8'));
  if (Number.isInteger(info.port) && info.port > 0 && info.port <= 65535 && typeof info.token === 'string') {
    const response = await fetch(`http://127.0.0.1:${info.port}/healthz`, {
      headers: { Authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(1000),
    });
    if (response.ok && (await response.json()).instance === info.instance) owner = info;
  }
} catch { /* Stale metadata does not prevent starting a new development owner. */ }
if (owner) {
  if (owner.owner !== 'core' || owner.version !== env.CLC_BUILD_VERSION) throw new Error('这份数据已有旧版本后台运行，请先退出旧应用，或使用另一 CLC_STATE_DIR。');
}
if (spawnSync('cargo', ['--version'], { env, stdio: 'ignore' }).status !== 0) {
  const cargo = spawnSync('rustup', ['which', 'cargo'], { env, encoding: 'utf8' });
  if (cargo.status !== 0) throw new Error('请先安装 Rust stable 工具链，并确保 cargo 或 rustup 在 PATH 中。');
  env.PATH = path.dirname(cargo.stdout.trim()) + path.delimiter + (env.PATH || '');
}
const prune = spawnSync(process.execPath, [fileURLToPath(new URL('tooling/prune-build-cache.mjs', root))],
  { cwd: fileURLToPath(root), env, stdio: 'inherit' });
if (prune.status !== 0) throw new Error('无法检查 Rust 构建缓存');
await buildNative();
if (process.platform === 'win32') {
  cpSync(fileURLToPath(new URL('dist/native/', root)), fileURLToPath(new URL('target/debug/bin/', root)), { recursive: true });
}
if (process.platform === 'darwin') {
  requireXcode(env);
  const output = fileURLToPath(new URL('target/dev-icon/', root));
  const source = path.join(output, 'Icon.icon');
  cpSync(fileURLToPath(new URL('desktop/icons/AgentRemoteControl.icon', root)), source, { recursive: true });
  const document = JSON.parse(readFileSync(path.join(source, 'icon.json'), 'utf8'));
  document['fill-specializations'][0].value = { solid: 'srgb:0.87843,0.94902,0.99216,1.00000' };
  writeFileSync(path.join(source, 'icon.json'), JSON.stringify(document, null, 2) + '\n');
  compileIcon(source, path.join(output, 'Resources'), env);
  const runner = 'node ../tooling/macos-dev-app.mjs';
  env.CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER = runner;
  env.CARGO_TARGET_X86_64_APPLE_DARWIN_RUNNER = runner;
}
const args = [fileURLToPath(new URL('node_modules/@tauri-apps/cli/tauri.js', root)), 'dev'];
if (process.platform === 'win32') args.push('--config', 'tauri.windows.conf.json');
args.push('--config', 'tauri.dev.conf.json');
args.push('--config', JSON.stringify({ version: env.CLC_BUILD_VERSION }));
if (process.platform === 'darwin') args.push('--config', JSON.stringify({ bundle: {
  icon: ['icons/icon.png', '../target/dev-icon/Resources/Icon.icns'],
} }));
args.push('--config', JSON.stringify({ build: { beforeDevCommand: {
  script: 'npm run dev:ui', cwd: fileURLToPath(root),
} } }));
args.push(...process.argv.slice(2));
const child = spawn(process.execPath, args, {
  cwd: fileURLToPath(new URL('desktop/', root)), stdio: 'inherit', env,
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
