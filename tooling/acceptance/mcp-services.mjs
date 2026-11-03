// Synthetic transport/task acceptance. Optional --live-agent=<id> uses that Agent's native login with synthetic tools only.
import { requireMainCheckout } from '../coding-lane.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const tool = { name: 'sample_echo', description: 'Echo a synthetic message.', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } };
const response = (request, second = false) => {
  if (request.method === 'initialize') return { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'sample-service', version: '1' } };
  if (request.method === 'tools/list') return request.params?.cursor === 'page-two' ? { tools: [{ ...tool, name: 'sample_second' }] } : { tools: [tool], nextCursor: second ? 'page-two' : undefined };
  if (request.method === 'tools/call') return { content: [{ type: 'text', text: `TOOL_RESULT:${request.params.arguments.message}` }] };
  return {};
};
if (process.argv.includes('--stdio-server')) {
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: response(request, true) }) + '\n');
  }
  process.exit(0);
}
requireMainCheckout();
const repo = fileURLToPath(new URL('../../', import.meta.url));
const out = path.resolve(process.argv[2] ?? path.join(repo, 'output/acceptance/mcp-services', String(Date.now())));
const state = path.join(out, 'state');
await mkdir(state, { recursive: true });
const put = async (name, value) => { const file = path.join(state, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value)); };
const report = { checks: [], defects: [], scope: 'Synthetic MCP services and real ARC orchestration', tasks: [] };
const check = (name, condition) => { assert.ok(condition, name); report.checks.push(name); };
let online = true, initialized = false;
const requests = [];
const server = createServer(async (req, res) => {
  if (!online) { res.writeHead(503); res.end(); return; }
  if (req.headers.authorization !== 'Bearer synthetic-local-token' || req.headers['x-sample'] !== 'sample') { res.writeHead(401); res.end(); return; }
  if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
  const parts = []; for await (const part of req) parts.push(part);
  const request = JSON.parse(Buffer.concat(parts).toString());
  if (request.method === 'initialize') initialized = false;
  else if (request.method === 'notifications/initialized') initialized = true;
  else if (!initialized) { res.writeHead(400); res.end(); return; }
  requests.push({ method: request.method, message: request.params?.arguments?.message });
  if (request.method !== 'initialize' && req.headers['mcp-session-id'] !== 'sample-session') { res.writeHead(400); res.end(); return; }
  if (request.id === undefined) { res.writeHead(202); res.end(); return; }
  const message = { jsonrpc: '2.0', id: request.id, result: response(request, true) };
  // Initialization uses JSON; other replies use a real persistent SSE response.
  if (request.method === 'initialize') { res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sample-session' }); res.end(JSON.stringify(message)); }
  else { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`: keepalive\r\n\r\nevent: message\r\ndata: ${JSON.stringify(message)}\r\n\r\n`); req.on('close', () => res.end()); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/mcp`;
await put('app/preferences.json', { proxyMode: 'direct' });
await put('agents/disabled.json', []);
await put('task-settings.json', { autoOpenCodex: false });
await put('dispatch-policy.json', {});
const acp = path.join(out, 'sample-acp.mjs'), native = path.join(out, 'sample-native.mjs');
await writeFile(acp, `import {createInterface} from 'node:readline';
import {Client} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/index.js'))};
import {StdioClientTransport} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/stdio.js'))};
const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');const clients=[];
for await(const line of createInterface({input:process.stdin})){
 const r=JSON.parse(line);if(r.id===undefined)continue;let result={};
 try {
 if(r.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:true,mcpCapabilities:{http:false}}};
 if(['session/new','session/load'].includes(r.method)){
  for(const server of r.params.mcpServers){const client=new Client({name:'sample-agent',version:'1'});await client.connect(new StdioClientTransport({command:server.command,args:server.args,env:{...process.env,...Object.fromEntries(server.env.map(e=>[e.name,e.value]))},stderr:'pipe'}));clients.push(client);}
  result={sessionId:'sample-session'};
 }
 if(r.method==='session/prompt'){
  const text=r.params.prompt.map(p=>p.text||'').join('');const output=[];
  for(const c of clients){const list=await c.listTools();if(list.tools.some(t=>t.name==='sample_echo')){const called=await c.callTool({name:'sample_echo',arguments:{message:text}});output.push(...called.content.filter(i=>i.type==='text').map(i=>i.text));}}
  emit({jsonrpc:'2.0',method:'session/update',params:{sessionId:'sample-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:output.join('\\n')||'NO_ASSIGNED_SERVICES'}}}});result={stopReason:'end_turn'};
 }
 emit({jsonrpc:'2.0',id:r.id,result});
 }catch(e){emit({jsonrpc:'2.0',id:r.id,error:{code:-32000,message:e.message}});}
}
for(const c of clients)await c.close();
`);
await writeFile(native, `import {createInterface} from 'node:readline';for await(const line of createInterface({input:process.stdin})){const r=JSON.parse(line);if(r.id!==undefined)console.log(JSON.stringify({id:r.id,result:r.method==='initialize'?{userAgent:'synthetic'}:{data:[],nextCursor:null}}));}`);
await put('agents/manifests.json', [{ id: 'sample-acp', command: process.execPath, args: [acp], versionArgs: [], displayName: 'Sample ACP' }]);
await put('agents/mcp.json', { 'sample-acp': { includeContextProvider: false, mcpServers: [{ name: 'Legacy sample', command: process.execPath, args: [fileURLToPath(import.meta.url), '--stdio-server'], env: {} }] } });
const env = { ...process.env, ARC_STATE_DIR: state, ARC_FIXTURE_BINARY: process.execPath, ARC_FIXTURE_SCRIPT: native, CODEX_HOME: path.join(out, 'codex'), CLAUDE_CONFIG_DIR: path.join(out, 'claude'), PI_CODING_AGENT_DIR: path.join(out, 'pi') };
await mkdir(env.CODEX_HOME, { recursive: true }); await mkdir(env.CLAUDE_CONFIG_DIR, { recursive: true });
const binaries = path.join(out, 'native');
await mkdir(path.join(binaries, 'bin'), { recursive: true });
await copyFile(path.join(repo, 'target/debug/arc'), path.join(binaries, 'bin/arc'));
await copyFile(path.join(repo, 'target/debug/contract-fixture'), path.join(binaries, 'contract-fixture'));
const child = spawn(path.join(binaries, 'contract-fixture'), ['http'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
const logs = []; child.stderr.on('data', data => logs.push(String(data)));
const lines = createInterface({ input: child.stdout });
const endpoint = JSON.parse((await lines[Symbol.asyncIterator]().next()).value);
async function api(route, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/api/${route}`, { method, headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result;
}
async function call(op, args) {
  const result = await api('cli/control', { op, args });
  if (result.isError) throw new Error(JSON.stringify(result));
  return result.structuredContent?.result ?? result;
}
async function create(prompt, agent = 'sample-acp') {
  let result = await call('agent_create', { agent, cwd: out, prompt, purpose: 'self-test', notify: null, requestId: randomUUID() });
  while (['pending','reserved','running'].includes(result.state)) { await new Promise(r => setTimeout(r, 50)); result = await call('receipt', { requestId: result.requestId }); }
  check('task dispatch accepted: ' + prompt, !!result.taskId);
  report.tasks.push(result.taskId);
  const deadline = Date.now() + 90000;
  let read;
  do {
    await call('agent_wait', { agent, taskId: result.taskId, timeoutMs: 10000 });
    read = await call('agent_read', { agent, taskId: result.taskId });
  } while (!['completed','failed','cancelled'].includes(read.status) && Date.now() < deadline);
  return read;
}
try {
  check('disabled by default', (await api('preferences'))['mcp-services'] === 'off');
  const original = await readFile(path.join(state, 'agents/mcp.json'), 'utf8');
  await api('preferences', { values: { 'mcp-services': 'on' } }, 'PUT');
  let service = await api('mcp-services/save', { configuration: { name: 'remote-sample', transport: 'http', url, headers: { Authorization: 'Bearer synthetic-local-token', 'X-Sample': 'sample' }, agents: ['sample-acp'] } });
  check('saved configuration is unchecked and redacted', service.check.state === 'unchecked' && !JSON.stringify(await api('mcp-services')).includes('synthetic-local-token'));
  service = await api('mcp-services/check', { id: service.id });
  check('HTTP initialization and paged SSE tool discovery', service.check.state === 'ready' && service.check.tools.some(t => t.name === 'sample_second'));
  service = await api('mcp-services/save', { id: service.id, expectedRevision: service.revision, configuration: { headers: { Authorization: 'Bearer wrong-synthetic-token', 'X-Sample': 'sample' } } });
  service = await api('mcp-services/check', { id: service.id });
  check('authentication failure is actionable and redacted', service.check.state === 'failed' && service.check.error.includes('MCP_HTTP_401') && !JSON.stringify(service).includes('wrong-synthetic-token'));
  service = await api('mcp-services/save', { id: service.id, expectedRevision: service.revision, configuration: { headers: { Authorization: 'Bearer synthetic-local-token', 'X-Sample': 'sample' } } });
  online = false;
  service = await api('mcp-services/check', { id: service.id });
  check('recoverable connection failure has actionable state', service.check.state === 'failed' && service.check.error.includes('MCP_HTTP_503'));
  online = true;
  service = await api('mcp-services/check', { id: service.id });
  check('explicit check recovers the failed connection', service.check.state === 'ready');
  const adopted = await api('mcp-services/adopt', { agent: 'sample-acp', name: 'Legacy sample' });
  check('adoption preserves the original ACP configuration', original === await readFile(path.join(state, 'agents/mcp.json'), 'utf8'));
  const local = await api('mcp-services/check', { id: adopted.id });
  check('stdio tool discovery', local.check.state === 'ready' && local.check.tools.some(t => t.name === 'sample_echo'));
  const first = await create('FIRST_MARKER');
  check('ARC task calls real HTTP and stdio tools', first.finalResponse?.includes('TOOL_RESULT:FIRST_MARKER') && requests.some(r => r.method === 'tools/call' && r.message === 'FIRST_MARKER'));
  check('task status omits configured credentials', !JSON.stringify(first).includes('synthetic-local-token'));
  check('task readback reports process-scoped HTTP assignment', first.mcpConfiguration?.services.some(s => s.transport === 'http' && s.delivery === 'rust-http-stdio'));
  check('adopted source is mounted once', first.mcpServers.filter(name => name === 'Legacy sample').length === 1);
  await api('preferences', { values: { 'mcp-services': 'off' } }, 'PUT');
  await call('agent_send', { agent: 'sample-acp', taskId: first.taskId, prompt: 'RETAINED_MARKER', purpose: 'self-test', notify: null, requestId: randomUUID() });
  await call('agent_wait', { agent: 'sample-acp', taskId: first.taskId, timeoutMs: 10000 });
  check('disabling preserves existing process tools', requests.some(r => r.message === 'RETAINED_MARKER'));
  const after = await create('AFTER_DISABLE');
  check('new processes omit experimental services after disable', after.mcpConfiguration?.services.length === 0 && !after.mcpServers.includes('remote-sample') && after.mcpServers.includes('Legacy sample'));
  await api('preferences', { values: { 'mcp-services': 'on' } }, 'PUT');
  service = await api('mcp-services/save', { id: service.id, expectedRevision: service.revision, configuration: { agents: [] } });
  check('editing invalidates check and preserves credentials', service.check.state === 'unchecked' && service.headerNames.includes('Authorization'));
  await api('mcp-services/remove', { id: service.id, expectedRevision: service.revision });
  check('service removal persists', !(await api('mcp-services')).services.some(s => s.id === service.id));
  check('guide exposes the metadata operation', JSON.stringify(await call('guide', { op: 'mcp_services' })).includes('mcp_services'));
  const liveAgent = process.argv.find(value => value.startsWith('--live-agent='))?.split('=')[1];
  if (liveAgent) {
    await api('mcp-services/save', { configuration: { name: 'live-sample', transport: 'http', url, headers: { Authorization: 'Bearer synthetic-local-token', 'X-Sample': 'sample' }, agents: [liveAgent] } });
    const marker = 'LIVE_AGENT_MCP_' + randomUUID();
    const live = await create('Call the sample_echo MCP tool from live-sample exactly once with message ' + marker + '. Do not use any other tools or read files. Return the tool result.', liveAgent);
    report.liveAgent = { agent: liveAgent, taskId: live.taskId, status: live.status, finalResponse: live.finalResponse };
    check('installed Agent calls the assigned HTTP service', requests.some(r => r.method === 'tools/call' && r.message === marker) && live.finalResponse?.includes(marker));
  }
} catch (error) { report.defects.push(error.stack); throw error; }
finally {
  child.stdin.end('\n');
  await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
  lines.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(path.join(out, 'native.log'), logs.join(''));
  console.log(JSON.stringify(report, null, 2));
}
