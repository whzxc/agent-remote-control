import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

export function screenshotsEnabled(argv) {
  return argv.includes('--screenshots') && !argv.includes('--no-screenshots');
}

export function planUiRunRetention(entries, engine, screenshots) {
  const screenshotPattern = new RegExp(`^\\d{4}-\\d{2}-\\d{2}T.*-${engine}$`);
  const layoutPattern = new RegExp(`^\\d{4}-\\d{2}-\\d{2}T.*-${engine}-layout$`);
  const screenshotDirs = entries.filter(name => screenshotPattern.test(name)).sort();
  const layoutDirs = entries.filter(name => layoutPattern.test(name)).sort();
  const previous = screenshotDirs.at(-1) ?? null;
  const keepScreenshots = screenshots ? 1 : 2;
  const keepLayouts = screenshots ? 2 : 1;
  const remove = [
    ...screenshotDirs.slice(0, Math.max(0, screenshotDirs.length - keepScreenshots)),
    ...layoutDirs.slice(0, Math.max(0, layoutDirs.length - keepLayouts)),
  ];
  return { previous, remove };
}

export async function pruneUiRuns(base, engine, screenshots) {
  const entries = (await readdir(base, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
  const { previous, remove } = planUiRunRetention(entries, engine, screenshots);
  await Promise.all(remove.map(name => rm(path.join(base, name), { recursive: true, force: true })));
  return previous;
}
