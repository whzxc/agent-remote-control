import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// Only read user-provided keys into the child environment; never write or log them.
export function releaseSigningEnv(required = false) {
  const env = { ...process.env };
  const key = env.TAURI_SIGNING_PRIVATE_KEY;
  const keyIsPath = key && (existsSync(key) || path.isAbsolute(key) || key.startsWith('.') || key.startsWith('~'));
  const file = keyIsPath ? key : env.TAURI_SIGNING_PRIVATE_KEY_FILE || path.join(homedir(), '.tauri/agent-remote-control.key');
  if (!key || keyIsPath) {
    try {
      env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(file, 'utf8').trim();
    } catch (error) {
      if (keyIsPath || env.TAURI_SIGNING_PRIVATE_KEY_FILE || error.code !== 'ENOENT') {
        throw new Error('无法读取签名文件；请检查 TAURI_SIGNING_PRIVATE_KEY_FILE 的路径与权限。');
      }
    }
  }
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= '';
  if (required && !env.TAURI_SIGNING_PRIVATE_KEY) {
    throw new Error('缺少 updater 签名私钥。请设置 TAURI_SIGNING_PRIVATE_KEY，或设置 TAURI_SIGNING_PRIVATE_KEY_FILE 指向已有私钥，或自行配置 ~/.tauri/agent-remote-control.key；加密密钥另设 TAURI_SIGNING_PRIVATE_KEY_PASSWORD。详见 docs/release.md。');
  }
  return env;
}
