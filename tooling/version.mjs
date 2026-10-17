import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function stableVersion(value) {
  const version = value.replace(/^v/, '');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error(`Invalid stable version: ${value}`);
  return version;
}

export function buildVersion() {
  if (process.env.ARC_BUILD_VERSION) return stableVersion(process.env.ARC_BUILD_VERSION);
  let tag;
  try {
    tag = execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return '0.0.0'; }
  return stableVersion(tag);
}
