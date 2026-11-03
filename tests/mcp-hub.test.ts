import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nativeControl } from './helpers/native-control.ts';

// Minimal newline-delimited MCP server: two tools/list pages, an echo tool and a tool that
// announces a new tool through notifications/tools/list_changed.
const server = `
import { createInterface } from 'node:readline';
const tools = [{ name: 'echo', description: 'Echo text. Second sentence.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }];
const pages = () => [tools.slice(0, 1), tools.slice(1)];
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  const reply = result => send({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize') reply({ protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'sample', version: '1' } });
  else if (message.method === 'tools/list') {
    const page = message.params?.cursor === 'two' ? 1 : 0;
    reply({ tools: pages()[page], ...(page === 0 && tools.length > 1 ? { nextCursor: 'two' } : {}) });
  } else if (message.params?.name === 'echo') reply({ content: [{ type: 'text', text: String(message.params.arguments.text) }], structuredContent: { env: process.env.SAMPLE_TOKEN === 'secret-value' } });
  else if (message.params?.name === 'grow') {
    tools.push({ name: 'later', description: 'Added later', inputSchema: { type: 'object' } });
    send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    reply({ content: [], isError: false });
  } else if (message.params?.name === 'later') reply({ content: [{ type: 'text', text: 'later' }] });
  else send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Unknown tool' } });
}
`;

test('MCP hub exposes downstream tools to control sources through query and act', async () => {
  // Contract: mcp_tools/mcp_call/mcp_configure stay hidden while disabled, redact secrets, page and refresh tool lists, and return actionable hub error codes.
  const work = await mkdtemp(path.join(tmpdir(), 'arc-mcp-hub-'));
  const script = path.join(work, 'server.mjs');
  await writeFile(script, server.replace('const tools = [', "const tools = [{ name: 'grow', description: 'Grow', inputSchema: { type: 'object' } }, "));
  const codex = path.join(work, 'codex');
  await mkdir(codex);
  await writeFile(path.join(codex, 'config.toml'), `[mcp_servers.sample]\ncommand = "node"\n\n[mcp_servers."remote service"]\nurl = "https://example.invalid/mcp"\nhttp_headers = { "X-Key" = "value" }\n`);
  const fixture = await nativeControl('', { CODEX_HOME: codex });
  try {
    const disabled = await fixture.call('mcp_tools');
    assert.equal(disabled.error?.code ?? disabled.code, 'OP_UNAVAILABLE', JSON.stringify(disabled));
    await fixture.api('preferences', { values: { 'mcp-services': 'on' } }, 'PUT');

    const added = await fixture.call('mcp_configure', { action: 'add', name: 'sample', transport: 'stdio', command: process.execPath, args: [script], env: { SAMPLE_TOKEN: 'secret-value' } });
    assert.equal(added.server.state, 'ready', JSON.stringify(added));
    assert.deepEqual(added.server.tools.map((tool: any) => tool.name), ['grow', 'echo']);
    assert.deepEqual(added.server.envNames, ['SAMPLE_TOKEN']);
    assert.ok(!JSON.stringify(added).includes('secret-value'));

    const index = await fixture.call('mcp_tools');
    assert.deepEqual(index.servers.map((row: any) => row.name), ['sample']);
    assert.equal(index.servers[0].tools[1].description, 'Echo text');
    const definition = await fixture.call('mcp_tools', { server: 'sample', tool: 'echo' });
    assert.equal(definition.tool.inputSchema.properties.text.type, 'string');

    const echoed = await fixture.call('mcp_call', { server: 'sample', tool: 'echo', arguments: { text: 'hello' } });
    assert.equal(echoed.content[0].text, 'hello');
    assert.deepEqual(echoed.structuredContent, { env: true });
    assert.equal(echoed.isError, false);

    // list_changed marks the cached list stale; the next call discovers the new tool.
    await fixture.call('mcp_call', { server: 'sample', tool: 'grow' });
    const later = await fixture.call('mcp_call', { server: 'sample', tool: 'later' });
    assert.equal(later.content[0].text, 'later', JSON.stringify(later));

    const unknown = await fixture.call('mcp_call', { server: 'sample', tool: 'missing' });
    assert.equal(unknown.error.code, 'MCP_TOOL_UNKNOWN');
    assert.equal(unknown.next.op, 'mcp_tools');
    const duplicate = await fixture.call('mcp_configure', { action: 'add', name: 'sample', transport: 'stdio', command: process.execPath });
    assert.equal(duplicate.error.code, 'MCP_SERVER_EXISTS');

    const imported = await fixture.call('mcp_configure', { action: 'import', from: 'codex' });
    assert.deepEqual(imported.imported, ['remote-service'], JSON.stringify(imported));
    assert.deepEqual(imported.skipped.map((row: any) => row.name), ['sample']);

    await fixture.call('mcp_configure', { action: 'disable', name: 'sample' });
    const off = await fixture.call('mcp_call', { server: 'sample', tool: 'echo', arguments: { text: 'x' } });
    assert.equal(off.error.code, 'MCP_SERVER_DISABLED');
    assert.equal(off.next.args.action, 'enable');
    const removed = await fixture.call('mcp_configure', { action: 'remove', name: 'remote-service' });
    assert.equal(removed.removed, 'remote-service');
    const remaining = await fixture.call('mcp_tools');
    assert.deepEqual(remaining.servers.map((row: any) => [row.name, row.state]), [['sample', 'disabled']]);
  } finally {
    await fixture.close();
    await rm(work, { recursive: true, force: true });
  }
});
