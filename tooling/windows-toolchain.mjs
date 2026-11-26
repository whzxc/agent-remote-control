import { execFileSync, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileDigest } from './release-support.mjs';

async function downloadGo(version, directory) {
  const distribution = `go${version}.windows-amd64.zip`;
  const index = await fetch('https://go.dev/dl/?mode=json&include=all', { signal: AbortSignal.timeout(30_000) });
  if (!index.ok) throw new Error(`Go distribution index returned HTTP ${index.status}`);
  const release = (await index.json()).find(entry => entry.version === `go${version}`);
  const sha256 = release?.files.find(entry => entry.filename === distribution)?.sha256;
  if (!/^[a-f0-9]{64}$/.test(sha256 || '')) throw new Error(`Missing official SHA-256 for ${distribution}`);
  const root = path.dirname(directory);
  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(path.join(root, '.go-'));
  try {
    const archive = path.join(staging, distribution);
    const response = await fetch(`https://dl.google.com/go/${distribution}`, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body) throw new Error(`Go SDK download returned HTTP ${response.status}`);
    await pipeline(response.body, createWriteStream(archive, { flags: 'wx' }));
    if (await fileDigest(archive) !== `sha256:${sha256}`) throw new Error(`SHA-256 mismatch for ${distribution}`);
    execFileSync('tar.exe', ['-xf', archive, '-C', staging], { stdio: 'inherit' });
    await rename(path.join(staging, 'go'), directory);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function configureWindowsToolchain(env = process.env) {
  const version = /^go (\d+\.\d+\.\d+)$/m.exec(await readFile('go.mod', 'utf8'))?.[1];
  if (!version) throw new Error('Expected a pinned Go version in go.mod');
  env.GOTOOLCHAIN = 'local';
  const matches = executable => spawnSync(executable, ['version'], { env, encoding: 'utf8' })
    .stdout?.trim() === `go version go${version} windows/amd64`;
  const directory = path.resolve('..', 'toolchains', `go${version}`);
  const executable = path.join(directory, 'bin', 'go.exe');
  if (!matches('go.exe')) {
    if (!existsSync(directory)) await downloadGo(version, directory);
    if (!matches(executable)) throw new Error(`Invalid Windows Go SDK in ${directory}; replace this release cache`);
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'Path';
    env[pathKey] = [path.dirname(executable), env[pathKey]].filter(Boolean).join(path.delimiter);
  }
  if (!env.ARC_MAKENSIS && spawnSync('where.exe', ['makensis.exe']).status !== 0) {
    const installed = path.join(env['ProgramFiles(x86)'] || '', 'NSIS', 'makensis.exe');
    const cached = path.join(env.LOCALAPPDATA || '', 'tauri', 'NSIS', 'makensis.exe');
    // Reuse the standalone NSIS executable already cached on the shared worker.
    if (!existsSync(installed) && existsSync(cached)) env.ARC_MAKENSIS = cached;
  }
}
