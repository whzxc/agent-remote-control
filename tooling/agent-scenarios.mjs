import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { prepareCoreBinary } from '../tests/helpers/native-control.ts';
import { toolResult } from './mcp-result.mjs';
import { createNormalizer, coverage, diffJSON, expandJSON } from './agent-scenarios-lib.mjs';
import { gallery } from './agent-scenarios-gallery.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'arch/agent-scenarios');
const output = path.join(root, 'output/agent-scenarios');
const target = path.resolve(root, process.env.CARGO_TARGET_DIR || 'target');
const executable = name => path.join(target, 'debug', name + (process.platform === 'win32' ? '.exe' : ''));
const readJSON = async file => JSON.parse(await readFile(file, 'utf8'));
const writeJSON = async (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');

async function loadCaptures(directory) {
  const result = {};
  let files;
  try { files = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return result; throw error; }
  for (const file of files.filter(file => file.endsWith('.json')).sort()) result[path.basename(file, '.json')] = await readJSON(path.join(directory, file));
  return result;
}

function resolveValues(value, bindings) {
  if (typeof value === 'string') return value.replace(/\$\{([^}]+)\}/g, (_, key) => {
    const found = key.split('.').reduce((item, part) => item?.[part], bindings);
    if (found === undefined) throw new Error(`Unresolved scenario value: ${key}`);
    return String(found);
  });
  if (Array.isArray(value)) return value.map(item => resolveValues(item, bindings));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveValues(v, bindings)]));
  return value;
}

async function captureScenario(scenario) {
  const directory = await mkdtemp(path.join(tmpdir(), 'arc-agent-scenarios-'));
  const stateDir = path.join(directory, 'arc-state'), home = path.join(directory, 'home');
  const client = new Client({ name: 'agent-remote-control-test', version: '1' });
  const transport = new StdioClientTransport({ command: executable('contract-fixture'), env: {
    ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home,
    ARC_STATE_DIR: stateDir, ARC_FIXTURE_DATA: directory,
    ARC_FIXTURE_SCRIPT: path.join(root, 'tests/fixtures/codex-app-server.mjs'), ARC_FIXTURE_BINARY: process.execPath,
  }, stderr: 'inherit' });
  const interrupt = () => { void transport.close(); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    await mkdir(path.join(stateDir, 'ingresses/default'), { recursive: true });
    await writeJSON(path.join(stateDir, 'ingresses/index.json'), ['default']);
    await writeJSON(path.join(stateDir, 'ingresses/default/config.json'), {
      id: 'default', name: 'ChatGPT', controlSource: 'chatgpt', transport: 'openai-tunnel', auth: 'openai', enabled: true, toolPolicy: 'all', config: {},
    });
    await writeJSON(path.join(stateDir, 'ingresses/default/secrets.json'), { apiKey: '', cloudflareToken: '', ngrokAuthtoken: '' });
    await mkdir(home);
    await writeFile(path.join(home, '.gitconfig'), '[user]\nname = Global Fixture\nemail = fixture@example.invalid\n[commit]\ngpgSign = true\n');
    await client.connect(transport);
    const endpoint = await readJSON(path.join(stateDir, 'app/native.json'));
    const settings = await fetch(`http://127.0.0.1:${endpoint.port}/api/task-settings`, {
      method: 'PUT', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ autoOpenCodex: false }),
    });
    if (!settings.ok) throw new Error(`Fixture task-settings: HTTP ${settings.status}`);
    const bindings = { fixture: directory };
    for (const step of scenario.setup) {
      const call = resolveValues(step.call, bindings);
      let response = await client.callTool(call), result = toolResult(response);
      const deadline = Date.now() + 15_000;
      const ready = () => {
        const value = step.until?.path.split('.').reduce((item, key) => item?.[key], result);
        return !step.until || (step.until.nonEmpty ? Array.isArray(value) && value.length > 0 : value === step.until.equals);
      };
      while (!ready()) {
        if (response.isError || Date.now() >= deadline) throw new Error(`${scenario.id}/${step.id}: setup did not reach ${JSON.stringify(step.until)}: ${JSON.stringify(result)}`);
        await new Promise(resolve => setTimeout(resolve, 100));
        // Only the scenario's explicit readiness condition is retried. Writes use their receipt.
        const retry = call.name === 'act'
          ? { name: 'query', arguments: { op: 'receipt', args: { requestId: call.arguments.requestId } } } : call;
        response = await client.callTool(retry);
        result = toolResult(response);
      }
      if (response.isError) throw new Error(`${scenario.id}/${step.id}: ${JSON.stringify(result)}`);
      bindings[step.id] = result;
    }
    const call = resolveValues(scenario.call, bindings);
    const response = await client.callTool(call);
    const normalize = createNormalizer({ directory, cliPath: executable('contract-fixture') });
    const capture = normalize({ id: scenario.id, call, response });
    const text = response.content.find(block => block.type === 'text')?.text ?? '';
    await writeJSON(path.join(output, 'raw', `${scenario.id}.json`), { id: scenario.id, call, response });
    await writeJSON(path.join(output, 'current', `${scenario.id}.json`), capture);
    return { characters: text.length, approximateTokens: Math.ceil(text.length / 4) };
  } finally {
    await client.close();
    await transport.close();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const [mode, ...ids] = process.argv.slice(2);
  if (!['capture', 'check', 'approve'].includes(mode) || (mode !== 'approve' && ids.length) || (mode === 'approve' && !ids.length)) {
    throw new Error('Usage: npm run agent-scenarios -- capture|check|approve <ids...>');
  }
  const catalog = await readJSON(path.join(root, 'native/src/catalog.json'));
  const { capabilities } = await readJSON(path.join(source, 'capabilities.json'));
  const scenarios = await Promise.all((await readdir(path.join(source, 'scenarios'))).filter(file => file.endsWith('.json')).sort().map(async file => {
    const scenario = await readJSON(path.join(source, 'scenarios', file));
    if (!/^[a-z][a-z0-9-]*$/.test(scenario.id) || file !== `${scenario.id}.json`) throw new Error(`Scenario filename must match its safe id: ${file}`);
    return scenario;
  }));
  const initial = coverage(catalog, capabilities, scenarios);
  if (initial.errors.length) throw new Error(initial.errors.join('\n'));
  await mkdir(output, { recursive: true });
  let sizes = {};
  if (mode !== 'approve') {
    // Use the same locked fixture/Core builds and Core CLI staging as control-mcp.test.ts.
    const { enterHeavyBuild } = await import('./heavy-build.mjs');
    enterHeavyBuild();
    try {
      execFileSync('cargo', ['build', '--locked', '--quiet', '-p', 'contract-fixture', '--target-dir', target], { cwd: root, stdio: 'inherit' });
      await prepareCoreBinary(target);
    } finally {
      execFileSync(process.execPath, [path.join(root, 'tooling/prune-build-cache.mjs')], { cwd: root, stdio: 'inherit' });
    }
    // Remove stale captures so a failed run cannot present old responses as current.
    for (const dir of ['current', 'raw']) {
      await rm(path.join(output, dir), { recursive: true, force: true });
      await mkdir(path.join(output, dir), { recursive: true });
    }
    await rm(path.join(output, 'index.html'), { force: true });
    for (const scenario of scenarios) {
      sizes[scenario.id] = await captureScenario(scenario);
      console.log(`Captured ${scenario.id}: ${sizes[scenario.id].characters} characters`);
    }
    await writeJSON(path.join(output, 'sizes.json'), sizes);
  } else {
    try { sizes = await readJSON(path.join(output, 'sizes.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const current = await loadCaptures(path.join(output, 'current'));
  const approved = await loadCaptures(path.join(source, 'approved'));
  if (mode === 'approve') {
    // Explicit operator action after user review. Never approve as a capture/check side effect.
    for (const id of ids) {
      if (!scenarios.some(s => s.id === id)) throw new Error(`Unknown scenario: ${id}`);
      if (!current[id]) throw new Error(`Missing current capture: ${id}. Run capture first.`);
    }
    for (const id of new Set(ids)) {
      await writeJSON(path.join(source, 'approved', `${id}.json`), current[id]);
      approved[id] = current[id];
      console.log(`Approved ${id}`);
    }
  }
  const report = coverage(catalog, capabilities, scenarios, current, approved);
  await writeJSON(path.join(output, 'coverage.json'), { errors: report.errors, capabilities: report.rows });
  await writeFile(path.join(output, 'index.html'), gallery({ capabilities, scenarios, current, approved, report, sizes }));
  for (const row of report.rows) console.log(`${row.id}: ops ${row.coveredOps}/${row.ops}; scenarios approved ${row.approved}, pending ${row.pending}, missing ${row.missing}; uncovered ops ${row.missingOps.length}${row.missingNotificationKinds.length ? `; missing notification kinds ${row.missingNotificationKinds.join(', ')}` : ''}`);
  console.log(`Gallery: ${path.join(output, 'index.html')}`);
  if (mode === 'check') {
    const failures = [];
    for (const scenario of scenarios) {
      if (!current[scenario.id]) failures.push(`${scenario.id}: missing capture`);
      else if (!approved[scenario.id]) failures.push(`${scenario.id}: missing approval`);
      else for (const difference of diffJSON(expandJSON(approved[scenario.id]), expandJSON(current[scenario.id]))) {
        failures.push(`${scenario.id}: ${difference.change} ${difference.path}`);
      }
    }
    for (const id of Object.keys(approved)) if (!scenarios.some(s => s.id === id)) failures.push(`${id}: approved scenario no longer exists`);
    if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
