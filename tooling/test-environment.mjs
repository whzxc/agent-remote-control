import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function testEnvironment(env = process.env) {
  const result = { ...env };
  for (const key of ['ARC_BUILD_VERSION', 'ARC_RELEASE_TIMINGS_FILE', 'ARC_RELEASE_PLATFORM',
    'ARC_MYGO_DEVELOPMENT', 'ARC_MYGO_UPDATE_BASE', 'ARC_MYGO_UPDATE_PUBLIC_KEY', 'MYGO_LDFLAGS', 'GOOS', 'GOARCH', 'GOFLAGS']) delete result[key];
  result.ARC_BUILD_VERSION = '0.0.0';
  // Git normalizes its ceiling list, while Core compares canonical directory paths.
  const temporaryRoot = path.resolve(fileURLToPath(new URL('../tmp/tests/', import.meta.url)));
  mkdirSync(temporaryRoot, { recursive: true });
  result.TMPDIR = result.TMP = result.TEMP = temporaryRoot;
  result.GIT_CEILING_DIRECTORIES = temporaryRoot;
  return result;
}
