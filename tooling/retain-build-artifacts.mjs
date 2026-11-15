import { readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function retainBuildArtifacts(root, apply = false) {
  const report = { retained: [], removed: [] };
  const list = directory => readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const profile of ['debug', 'release']) {
    const directory = path.join(root, 'target/aarch64-apple-darwin', profile, 'bundle/dmg');
    const files = [];
    for (const entry of await list(directory)) {
      if (entry.isFile() && /^(agent-remote-control_|Local Connector_).+_aarch64(?:_debug)?\.dmg$/.test(entry.name)) {
        const file = path.join(directory, entry.name);
        files.push({ file, modified: (await stat(file)).mtimeMs });
      }
    }
    files.sort((a, b) => b.modified - a.modified);
    report.retained.push(...files.slice(0, 2).map(value => value.file));
    for (const { file } of files.slice(2)) {
      if (apply) await rm(file);
      report.removed.push(file);
    }
  }
  const directory = path.join(root, 'release-artifacts');
  const groups = new Map();
  for (const entry of await list(directory)) {
    if (!entry.isDirectory() || !entry.name.startsWith('v')) continue;
    const folder = path.join(directory, entry.name);
    let state;
    try { state = JSON.parse(await readFile(path.join(folder, 'release-state.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!state.complete) continue;
    for (const platform of state.platforms) {
      const group = groups.get(platform) || [];
      group.push({ folder, state, modified: (await stat(path.join(folder, 'release-state.json'))).mtimeMs });
      groups.set(platform, group);
    }
  }
  const keep = new Set();
  const completed = new Map();
  for (const group of groups.values()) {
    group.sort((a, b) => b.modified - a.modified);
    for (const item of group.slice(0, 2)) keep.add(item.folder);
    for (const item of group) completed.set(item.folder, item.state);
  }
  report.retained.push(...keep);
  for (const [folder, state] of completed) {
    if (keep.has(folder)) continue;
    for (const asset of state.assets) {
      if (path.basename(asset.name) !== asset.name) throw new Error(`Invalid artifact name: ${asset.name}`);
      if (!/\.(dmg|exe|tar\.gz)(\.sig)?$/.test(asset.name)) continue;
      const file = path.join(folder, asset.name);
      if (!(await list(folder)).some(entry => entry.isFile() && entry.name === asset.name)) continue;
      if (apply) await rm(file);
      report.removed.push(file);
    }
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { parseArgs } = await import('node:util');
  const { values } = parseArgs({ options: { apply: { type: 'boolean', default: false } } });
  console.log(JSON.stringify(await retainBuildArtifacts(fileURLToPath(new URL('../', import.meta.url)), values.apply), null, 2));
}
