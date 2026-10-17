import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const value = key => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
const binary = value('--binary');
const output = value('--output');
const state = value('--state-dir');
const devHtml = value('--dev-html');
if (!binary || !output || args.length % 2 || args.some((arg, index) => index % 2 === 0 && !['--binary','--output','--state-dir','--dev-html'].includes(arg))) {
  throw new Error('Usage: node tooling/export-plugin.mjs --binary <standalone executable> --output <plugin directory> [--state-dir <directory>] [--dev-html <rebuilt HTML file>]');
}
const target = resolve(output);
execFileSync(resolve(binary), ['export', target], { stdio: 'inherit' });
if (state || devHtml) {
  const config = JSON.parse(await readFile(`${target}/.mcp.json`, 'utf8'));
  const server = config.mcpServers.arc;
  if (devHtml) server.command = resolve(binary);
  server.env = {};
  if (state) server.env.ARC_STATE_DIR = resolve(state);
  if (devHtml) server.env.ARC_PLUGIN_DEV_HTML = resolve(devHtml);
  await writeFile(`${target}/.mcp.json`, JSON.stringify(config, null, 2) + '\n');
}
