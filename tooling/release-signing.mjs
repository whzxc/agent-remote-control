import { execFileSync } from 'node:child_process';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileDigest } from './release-support.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const updateTargets = { mac: 'darwin-arm64', windows: 'windows-amd64' };
export const archiveName = (target, version) => `agent-remote-control-${version}-${target}.tar.gz`;
export const feedName = target => `update-${target}.json`;
const tauriPublic = 'ARC_TAURI_UPDATE_PUBLIC_KEY';
const mygoPublic = 'ARC_MYGO_UPDATE_PUBLIC_KEY';
const tauriPrivate = 'TAURI_SIGNING_PRIVATE_KEY_FILE';
const mygoPrivate = 'ARC_MYGO_UPDATE_PRIVATE_KEY_FILE';

export function verifier(operation, version, files = [], { publicOnly = false, env = process.env } = {}) {
  const signing = { PATH: env.PATH, SystemRoot: env.SystemRoot, HOME: env.HOME, USERPROFILE: env.USERPROFILE };
  // Pass explicit key references only to the coordinator's Go verifier.
  for (const name of [tauriPublic, mygoPublic, ...publicOnly ? [] : [tauriPrivate, mygoPrivate, 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD'],
    'GOCACHE', 'GOMODCACHE', 'GOPATH', 'GOTOOLCHAIN', 'TMPDIR', 'TEMP']) {
    if (env[name] !== undefined) signing[name] = env[name];
  }
  for (const [key, value] of Object.entries(signing)) if (value === undefined) delete signing[key];
  return execFileSync('go', ['run', './tooling/verifier', operation, version, ...files], {
    cwd: root, env: { ...signing, CGO_ENABLED: '0' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

export async function rehearsalSigning(directory) {
  directory = await realpath(directory);
  const files = {};
  for (const name of ['tauri.key', 'tauri.pub', 'mygo.key', 'mygo.pub']) {
    const file = path.join(directory, name);
    if (await realpath(file) !== file || !(await stat(file)).isFile()) throw new Error('Use the four files in a generated rehearsal-key directory.');
    files[name] = file;
  }
  return { [tauriPublic]: (await readFile(files['tauri.pub'], 'utf8')).trim(),
    [mygoPublic]: (await readFile(files['mygo.pub'], 'utf8')).trim(),
    [tauriPrivate]: files['tauri.key'], [mygoPrivate]: files['mygo.key'], TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' };
}

export function buildOnlyEnv(env = process.env) {
  const safe = { ...env };
  for (const name of Object.keys(safe)) {
    if (/^(TAURI_SIGNING_|MYGO_UPDATER_PRIVATE_KEY$|ARC_MYGO_UPDATE_PRIVATE_KEY_FILE$)/.test(name)) delete safe[name];
  }
  return safe;
}

export async function signMygoFeed({ target, version, directory, base, notes, env }) {
  const name = archiveName(target, version);
  const file = path.join(directory, name);
  const feed = { version, notes: notes.en, notes_zh_cn: notes.zh, date: new Date().toISOString(),
    url: `${base}/${name}`, size: (await stat(file)).size,
    signature: verifier('sign-mygo', version, [file], { env }) };
  await writeFile(path.join(directory, feedName(target)), JSON.stringify(feed, null, 2) + '\n');
}

export async function verifyMygoFeed({ target, version, directory, base, env }) {
  const feed = JSON.parse(await readFile(path.join(directory, feedName(target)), 'utf8'));
  const name = archiveName(target, version);
  const file = path.join(directory, name);
  if (feed.version !== version || feed.url !== `${base}/${name}` || feed.size <= 0 ||
      (await stat(file)).size !== feed.size || !Number.isFinite(Date.parse(feed.date))) {
    throw new Error(`MyGo feed version, size or artifact URL mismatch for ${target}`);
  }
  console.log(verifier('verify-mygo', version, [file, feed.signature], { publicOnly: true, env }));
}

export async function archiveReceipt(file) {
  return { name: path.basename(file), sha256: (await fileDigest(file)).slice(7) };
}
