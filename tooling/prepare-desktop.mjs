import { build } from 'vite';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncDirectory } from './build-cache.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function stageBrowserBundle() {
  const source = path.join(root, 'dist/ui');
  const destination = path.join(root, 'internal/core/browser_dist');
  await mkdir(destination, { recursive: true });
  await copyFile(path.join(source, 'browser.html'), path.join(destination, 'browser.html'));
  await syncDirectory(path.join(source, 'assets'), path.join(destination, 'assets'));
}

export async function prepareDesktop() {
  // Build to a sibling directory before staging, so a failed frontend build
  // leaves the last usable resources available.
  const staging = path.join(root, 'dist/frontend-stage');
  await build({ configFile: path.join(root, 'vite.config.ts'), build: { outDir: staging } });
  await syncDirectory(staging, path.join(root, 'dist/ui'));
  await stageBrowserBundle();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await prepareDesktop();
