import { buildVersion } from './version.mjs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const targetDir = fileURLToPath(new URL('../target/', import.meta.url));

export function buildEnv(release = false) {
  const env = { ...process.env, ARC_BUILD_VERSION: buildVersion(), CARGO_TARGET_DIR: targetDir };
  if (release) {
    const flags = env.CARGO_ENCODED_RUSTFLAGS?.split('\x1f') ?? env.RUSTFLAGS?.trim().split(/\s+/).filter(Boolean) ?? [];
    const root = fileURLToPath(new URL('../', import.meta.url));
    for (const flag of [`--remap-path-prefix=${homedir()}=/build-user`, `--remap-path-prefix=${root}=/workspace/`]) {
      if (!flags.includes(flag)) flags.push(flag);
    }
    env.CARGO_ENCODED_RUSTFLAGS = flags.join('\x1f');
    delete env.RUSTFLAGS;
  }
  return env;
}
