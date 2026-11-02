export function testEnvironment(env = process.env) {
  const result = { ...env };
  for (const key of ['ARC_BUILD_VERSION', 'ARC_RELEASE_TIMINGS_FILE', 'ARC_RELEASE_PLATFORM', 'TAURI_CONFIG']) delete result[key];
  result.ARC_BUILD_VERSION = '0.0.0';
  return result;
}
