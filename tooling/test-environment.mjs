import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function testEnvironment(env = process.env) {
  const result = { ...env };
  for (const key of ['ARC_BUILD_VERSION', 'ARC_RELEASE_TIMINGS_FILE', 'ARC_RELEASE_PLATFORM', 'TAURI_CONFIG']) delete result[key];
  result.ARC_BUILD_VERSION = '0.0.0';
  const temporaryRoot = fileURLToPath(new URL('../tmp/tests/', import.meta.url));
  mkdirSync(temporaryRoot, { recursive: true });
  result.TMPDIR = result.TMP = result.TEMP = temporaryRoot;
  result.GIT_CEILING_DIRECTORIES = temporaryRoot;
  return result;
}
