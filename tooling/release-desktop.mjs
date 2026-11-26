import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { desktopExecutable, desktopName } from './dev-identity.mjs';
import { archiveName, buildOnlyEnv, verifier } from './release-signing.mjs';

const updaterKeys = {
  'darwin-arm64': ['darwin-aarch64'],
  'windows-amd64': ['windows-x86_64', 'windows-x86_64-nsis'],
};
export const fragmentName = target => updaterKeys[target][0] + '.json';
export const installerName = (target, version) => target === 'darwin-arm64'
  ? `agent-remote-control_${version}_aarch64.dmg` : `agent-remote-control_${version}_x64-setup.exe`;
export const legacyPayloadName = (target, version) => target === 'darwin-arm64'
  ? `agent-remote-control_${version}_aarch64.app.tar.gz` : installerName(target, version);

function archive(output, directory, entries) {
  execFileSync('tar', ['-czf', output, '-C', directory, ...entries], {
    env: { ...buildOnlyEnv(), COPYFILE_DISABLE: '1' }, stdio: 'inherit',
  });
}

export async function collectDesktop({ target, version, input, output }) {
  await mkdir(output, { recursive: true });
  await copyFile(path.join(input, installerName(target, version)), path.join(output, installerName(target, version)));
  const mygoArchive = path.join(output, archiveName(target, version));
  if (target === 'darwin-arm64') {
    archive(mygoArchive, input, [`${desktopName}.app`]);
    // Both formats install the same signed and versioned macOS bundle.
    await copyFile(mygoArchive, path.join(output, legacyPayloadName(target, version)));
  } else if (target === 'windows-amd64') {
    const list = (await readFile(path.join(input, '.mygo-files'), 'utf8')).trim().split(/\r?\n/);
    const expected = [desktopExecutable + '.exe', 'bin', 'licenses', 'menubar-18Template@2x.png', 'skills', 'tray-logo.png'];
    if (list.sort().join('\n') !== expected.sort().join('\n')) throw new Error('Unexpected Windows installed payload inventory.');
    archive(mygoArchive, input, ['.mygo-files', ...list]);
  } else throw new Error(`Unknown desktop target ${target}`);
  return mygoArchive;
}

export async function signLegacyPayload({ target, version, output, base, env }) {
  const name = legacyPayloadName(target, version);
  const file = path.join(output, name);
  console.log(verifier('sign-tauri', version, [file], { env }));
  const value = { url: `${base}/${name}`, signature: (await readFile(file + '.sig', 'utf8')).trim() };
  const platforms = Object.fromEntries(updaterKeys[target].map(key => [key, value]));
  await writeFile(path.join(output, fragmentName(target)), JSON.stringify({ version, platforms }, null, 2) + '\n');
}

export async function requireEmptyStage(directory) {
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length) throw new Error('Stage directory must be empty; use a fresh directory');
}
