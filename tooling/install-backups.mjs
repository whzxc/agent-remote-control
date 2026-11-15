import { readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Local development artifacts belong to the checkout, independently of runtime state.
export const backupRoot = fileURLToPath(new URL('../.local/install-backups/macos/', import.meta.url));

export function pruneInstallBackups(root = backupRoot) {
  const entries = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^installed-\d+$/.test(entry.name))
    .map(entry => path.join(root, entry.name))
    .filter(directory => statSync(path.join(directory, 'previous-app.zip')).isFile())
    .sort((a, b) => Number(path.basename(b).slice(10)) - Number(path.basename(a).slice(10)));
  const removed = entries.slice(2);
  for (const directory of removed) rmSync(directory, { recursive: true });
  return { retained: entries.slice(0, 2), removed };
}
