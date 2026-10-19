import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { identifyPolicy, normalizeSelection, presetPolicy, type ToolCatalog, type ToolPolicy } from '../ui/toolPolicy.ts';
import { buildVersion } from '../tooling/version.mjs';
import { toolFingerprint } from '../tooling/catalog.mjs';
const catalog = JSON.parse(await readFile(new URL('../native/src/catalog.json', import.meta.url), 'utf8'));
const nativeDomains = catalog.domains;
const version = buildVersion();

let directory: string;
let client: Client;
let fixtureCommand: string;
let fixtureEnv: Record<string,string>;
async function connectFixture() {
  client = new Client({name:"agent-remote-control-test",version:"1"});
  await client.connect(new StdioClientTransport({command:fixtureCommand,env:fixtureEnv,stderr:"pipe"}));
}
let inventory: Awaited<ReturnType<Client['listTools']>>;
let operations: typeof inventory.tools;
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'agent-remote-control-test-'));
  // Explicit all policy exercises the entire registered tool surface.
  await mkdir(path.join(directory, 'ingresses/default'), { recursive: true });
  await writeFile(path.join(directory, 'ingresses/index.json'), JSON.stringify(['default']));
  await writeFile(path.join(directory, 'ingresses/default/config.json'), JSON.stringify({ id: 'default', name: 'ChatGPT', controlSource: 'chatgpt', transport: 'openai-tunnel', auth: 'openai', enabled: true, toolPolicy: 'all', config: {} }));
  await writeFile(path.join(directory, 'ingresses/default/secrets.json'), JSON.stringify({apiKey:'',cloudflareToken:'',ngrokAuthtoken:''}));
  const home = path.join(directory, 'home');
  await mkdir(home);
  await writeFile(path.join(home, '.gitconfig'), '[user]\nname = Global Fixture\nemail = fixture@example.invalid\n[commit]\ngpgSign = true\n');
  const fixture = path.join(directory, 'app-server.mjs');
  await writeFile(fixture, `
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const fixtureState = process.env.ARC_STATE_DIR + '/dispatch-fixture.json';
const counts = new Map();
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params, result } = JSON.parse(line);
  if (!method && result) {
    const saved = JSON.parse(readFileSync(fixtureState,'utf8'));
    const row = Object.values(saved).find(r=>r.pendingId===id);
    if(row){row.answer=result;row.turns.at(-1).status='completed';delete row.pendingId;writeFileSync(fixtureState,JSON.stringify(saved));}
    continue;
  }
  if (id === undefined) continue;
  const calls = (counts.get(method) || 0) + 1; counts.set(method, calls);
  const reply = () => {
    if (params?.fail) return emit({ id, error: { code: -32042, message: 'native fixture rejection', data: { retryable: false, detail: params.fail } } });
    if (method === 'initialize') return emit({ id, result: { userAgent: 'fixture' } });
    if (method === 'fixture/counts') return emit({ id, result: Object.fromEntries(counts) });
    if (method === 'fixture/null') return emit({ id, result: null });
    if (method === 'fixture/array') return emit({ id, result: [null, 1, { native: true }] });
    const saved = existsSync(fixtureState) ? JSON.parse(readFileSync(fixtureState, 'utf8')) : {};
    if (method === 'thread/start' && params.model?.startsWith('fixture-dispatch')) {
      const thread = {id:randomUUID(),cwd:params.cwd,path:process.env.ARC_STATE_DIR+'/seed-'+randomUUID()+'.jsonl'};
      writeFileSync(thread.path, '{}');
      saved[thread.id] = {thread,model:params.model,turns:[],metadataReads:0,archived:false};
      writeFileSync(fixtureState, JSON.stringify(saved));
      return emit({id,result:{thread,model:params.model}});
    }
    if (saved[params?.threadId]) {
      const row = saved[params.threadId];
      if (method === 'thread/read') {
        if (params.includeTurns) return emit({id,error:{code:-32601,message:'list_turns is not supported yet'}});
        row.metadataReads++;
        writeFileSync(fixtureState,JSON.stringify(saved));
        return emit({id,result:{thread:{...row.thread,status:{type:row.turns.at(-1)?.status==='inProgress'?'active':'idle'}}}});
      }
      if (method === 'turn/start') {
        if (row.model === 'fixture-dispatch-reject') return emit({id,error:{code:-32602,message:'invalid turn configuration'}});
        const overload=row.model.includes('overload') && (row.model.includes('exhausted') || row.model.includes('side-effect') || row.turns.length<2);
        row.turns.push({id:randomUUID(),status:overload?'failed':(row.model.includes('queue')||(row.model.includes('question')&&row.turns.length===0))?'inProgress':'completed',error:overload?{codexErrorInfo:'serverOverloaded',message:'Selected model is at capacity'}:null,items:overload?(row.model.includes('side-effect')?[{type:'commandExecution',status:'completed'}]:[]):[{id:randomUUID(),type:'agentMessage',text:'pong'}],input:params.input,model:params.model||row.model});
        writeFileSync(fixtureState,JSON.stringify(saved));
        if(row.model.includes('question')&&row.turns.length===1) {row.pendingId='question:'+params.threadId;writeFileSync(fixtureState,JSON.stringify(saved));emit({id:row.pendingId,method:'item/tool/requestUserInput',params:{threadId:params.threadId,turnId:row.turns.at(-1).id,questions:[{id:'q',question:'2+2?',options:[]}]}});}
        if (row.model === 'fixture-dispatch-uncertain') return process.exit(0);
        return emit({id,result:{turn:row.turns.at(-1)}});
      }
      if (method === 'turn/steer') { row.steers=(row.steers||0)+1;writeFileSync(fixtureState,JSON.stringify(saved));return emit({id,result:{turnId:row.turns.at(-1).id}}); }
      if (method === 'fixture/finish-turn') { row.turns.at(-1).status=params.status||'completed';writeFileSync(fixtureState,JSON.stringify(saved));return emit({id,result:{}}); }
      if (method === 'thread/turns/list') {
        const rows = [...row.turns];
        if(params.sortDirection === 'desc') rows.reverse();
        const offset = Number(params.cursor || 0);
        return emit({id,result:{data:rows.slice(offset,offset+1),nextCursor:offset+1<rows.length?String(offset+1):null}});
      }
      if (method === 'thread/archive') {
        row.archived=true;writeFileSync(fixtureState,JSON.stringify(saved));
        return emit({id,result:{}});
      }
    }
    if (params?.threadId === 'image-pagination' || params?.threadId === 'empty-images') {
      if (method === 'thread/turns/list') return emit({id,result:{data:params.threadId === 'empty-images' ? [] : [{id:'turn-latest',items:[]}],nextCursor:null}});
      if (method === 'thread/items/list') {
        if ('latest' in params || 'includeImages' in params || 'maxImages' in params) return emit({id,error:{message:'connector parameters leaked'}});
        const binding = (params.turnId || 'all') + ':' + params.sortDirection;
        const rows = [{turnId:'turn-old',item:{id:'old-first',type:'agentMessage',text:'old first'}},{turnId:'turn-latest',item:{id:'latest-first',type:'agentMessage',text:'latest first'}},{turnId:'turn-latest',item:{id:'latest-last',type:'agentMessage',text:'latest last'}}].filter(r=>!params.turnId || r.turnId===params.turnId);
        if(params.sortDirection === 'desc') rows.reverse();
        let offset=0;
        if(params.cursor) {
          const cursor=JSON.parse(params.cursor);
          if(cursor.binding!==binding) return emit({id,error:{message:'cursor binding changed'}});
          offset=cursor.offset;
        }
        const end=offset+(params.limit||1);
        return emit({id,result:{data:rows.slice(offset,end),nextCursor:end<rows.length?JSON.stringify({binding,offset:end}):null}});
      }
    }
    if (method === 'thread/list' && params.searchTerm === 'fixture-overview') {
      if ('view' in params) return emit({id,error:{message:'ARC view leaked to native API'}});
      return emit({id,result:{data:[{id:'overview-live',name:'Live',cwd:'/fixture',preview:'x'.repeat(77000),updatedAt:123,status:{type:'notLoaded'}},{id:'overview-unloaded',name:'Unloaded',cwd:'/fixture',preview:'history',status:{type:'notLoaded'}},{id:'overview-unavailable',name:'Unavailable',cwd:'/fixture',status:{type:'notLoaded'}}],nextCursor:'native-cursor'}});
    }
    if (params?.threadId?.startsWith('overview-')) {
      if(params.threadId==='overview-unavailable' && method==='thread/read')return emit({id,error:{code:-32000,message:'owner unavailable'}});
      if(method==='thread/read')return emit({id,result:{thread:{id:params.threadId,cwd:'/fixture',updatedAt:124,model:'fixture-model',status:{type:params.threadId==='overview-live'?'active':'notLoaded'}}}});
      if(method==='thread/turns/list')return emit({id,result:{data:[{id:'current-turn',status:params.threadId==='overview-live'?'inProgress':'completed'}],nextCursor:null}});
    }
    if (method === 'model/list' || method === 'thread/list' || method === 'project/list') return emit({ id, result: { data: [], nextCursor: null } });
    if (method === 'process/spawn') {
      emit({ method: 'process/outputDelta', params: { processHandle: params.processHandle, stream: 'stdout', deltaBase64: 'b2s=' } });
      emit({ method: 'process/exited', params: { processHandle: params.processHandle, exitCode: 0 } });
    }
    if (method === 'fs/watch') emit({ method: 'fs/changed', params: { watchId: params.watchId, paths: [params.path] } });
    emit({ id, result: { method, params, calls } });
  };
  if (params?.delay) setTimeout(reply, params.delay); else reply();
}
`);
  const target = fileURLToPath(new URL('../target', import.meta.url));
  execFileSync('cargo', ['build', '--locked', '--quiet', '-p', 'contract-fixture', '--target-dir', target], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit',
  });
  fixtureCommand=path.join(target, 'debug', 'contract-fixture' + (process.platform === 'win32' ? '.exe' : ''));
  fixtureEnv={ ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, ARC_STATE_DIR: directory, ARC_FIXTURE_SCRIPT: fixture, ARC_FIXTURE_BINARY: process.execPath } as Record<string,string>;
  await connectFixture();
  inventory = await client.listTools();
  const index = (await call('guide')).result.ops;
  operations = await Promise.all(index.map(async ({op}: {op: string}) => {
    const detail = (await call('guide', {op})).result;
    return {...catalog.ops.find((item: any) => item.name === op), inputSchema: detail.inputSchema, description: detail.description};
  }));
});
after(async () => { await client?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

function opCall(name: string, args: Record<string, unknown> = {}) {
  if (name === 'guide') return { name, arguments: args };
  const spec = catalog.ops.find((op: any) => op.name === name);
  const via = spec.annotations.readOnlyHint ? 'query' : 'act';
  const {requestId, ...rest} = args;
  return {name: via, arguments: {op: name, args: via === 'act' && requestId !== undefined ? rest : args, ...(via === 'act' && requestId !== undefined ? {requestId} : {})}};
}
async function call(name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool(opCall(name, args));
  return { response, result: (response.structuredContent as { result: any } | undefined)?.result };
}
async function completed(name: string, args: Record<string, unknown>) {
  let { result } = await call(name, args);
  const deadline = Date.now() + 15000;
  while (['pending', 'reserved', 'submitting', 'thread-submitting', 'thread-created', 'turn-submitting'].includes(result.state)) {
    assert.ok(Date.now() < deadline, 'receipt completed before deadline');
    await new Promise(resolve => setTimeout(resolve, 20));
    result = (await call('receipt', { requestId: args.requestId })).result;
  }
  return result;
}

test('MCP lists frozen tools and guide exposes existing ops and native domains with valid object schemas', async () => {
  assert.deepEqual(inventory.tools.map(tool => tool.name), ['guide', 'query', 'act']);
  const status = await call('notify_status');
  assert.equal(status.response.isError, false);
  assert.equal(status.result.arcInbox, undefined);
  const existing = ['codex_queue', 'codex_queue_control', 'notify_status', 'notify_control', 'notification_ack', 'guide', 'edit', 'write', 'codex_changes', 'logs', 'connector_verify', 'projects', 'overview', 'tree', 'search', 'read', 'screen', 'git', 'git_write', 'codex_tasks', 'codex_read', 'codex_wait', 'codex_create', 'codex_send', 'codex_interrupt', 'codex_capabilities', 'receipt', 'codex_items', 'codex_schema', 'codex_query', 'codex_call', 'codex_pending', 'codex_respond', 'codex_events', 'control_output'];
  assert.deepEqual(operations.map(tool => tool.name).sort(), [...existing, 'agents', 'agent_capabilities', 'agent_tasks', 'agent_create', 'agent_read', 'agent_context', 'agent_wait', 'agent_send', 'agent_interrupt', 'agent_events', 'agent_pending', 'agent_respond', 'fs', 'command', 'process', 'mcp', 'file_search', 'codex_thread', 'codex_account'].filter(name => !name.startsWith('agent') || operations.some(tool => tool.name === 'agents')).sort());
  for (const tool of operations) {
    assert.equal(tool.inputSchema.type, 'object');
    new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
  }
  const waitSchema = operations.find(tool => tool.name === 'codex_wait')!.inputSchema;
  assert.equal((waitSchema.properties!.timeoutMs as { maximum: number }).maximum, 90000);
  const validateWait = new AjvJsonSchemaValidator().getValidator(waitSchema);
  assert.equal(validateWait({ threadId: 'fixture', timeoutMs: 90000 }).valid, true);
  for (const timeoutMs of [90001, 100000, 270000]) {
    assert.equal(validateWait({ threadId: 'fixture', timeoutMs }).valid, false);
    const rejected = await call('codex_wait', { threadId: 'fixture', timeoutMs });
    assert.equal(rejected.response.isError, true);
  }
  for (const name of ['read', 'codex_read', 'codex_items']) {
    const exposed = operations.find(tool => tool.name === name)!;
    const source = catalog.ops.find((tool: {name: string}) => tool.name === name);
    assert.deepEqual(exposed.inputSchema, source.inputSchema);
    assert.equal(exposed.description, source.description);
    assert.match(exposed.description!, /MCP image/);
    assert.doesNotMatch(exposed.description!, /二进制使用原生/);
    const params = name === 'read' ? ['maxEdge', 'quality'] : ['includeImages', 'maxImages'];
    for (const key of params) assert.ok(exposed.inputSchema.properties?.[key]);
  }
  assert.ok(operations.find(tool => tool.name === 'codex_items')!.inputSchema.properties?.latest);
  const agents = (await management('agents')).agents;
  assert.deepEqual(agents.map((agent: { agent: string }) => agent.agent).sort(), ['claude', 'cline', 'codex', 'copilot', 'cursor', 'devin', 'gemini', 'grok', 'hermes', 'junie', 'kimi', 'kiro', 'opencode', 'pi', 'qwen']);
  for (const agent of agents.filter((agent: { protocol: string }) => agent.protocol === 'acp-v1')) {
    assert.equal(agent.descriptor.protocol, 'acp-v1');
    assert.ok(['native', 'adapter'].includes(agent.integration));
  }
  const gitWrite = operations.find(tool => tool.name === 'git_write')!;
  assert.equal(gitWrite.annotations?.readOnlyHint, false);
  assert.equal(operations.find(tool => tool.name === 'git')!.annotations?.readOnlyHint, true);
  assert.deepEqual(catalog.toolExposure.tools.git_write.presets, []);
  assert.deepEqual(catalog.toolExposure.tools.git_write.requires, ['control_output', 'receipt']);
  const command = operations.find(tool => tool.name === 'command')!;
  assert.match(command.description!, /sandbox\/permission/);
  assert.match(operations.find(tool => tool.name === 'process')!.description!, /非 Codex sandbox/);
  assert.ok(!command.inputSchema.required?.includes('requestId'));
  assert.equal(operations.find(tool => tool.name === 'codex_account')!.annotations?.readOnlyHint, true);
  assert.equal((await call('fs', { action: 'writeFile', params: {} })).result.state, 'completed');
  assert.equal((await call('fs', { action: 'readFile', params: {} })).response.isError, true);
  assert.equal((await call('fs', { action: 'exec', params: {} })).response.isError, true);
});

test('every domain action maps to the exact native RPC without adding, dropping or normalizing params', async () => {
  const expected: Record<string, Record<string, string>> = {
    fs: Object.fromEntries(['writeFile', 'createDirectory', 'remove', 'copy', 'watch', 'unwatch'].map(action => [action, `fs/${action}`])),
    command: { exec: 'command/exec', write: 'command/exec/write', terminate: 'command/exec/terminate', resize: 'command/exec/resize' },
    process: { spawn: 'process/spawn', writeStdin: 'process/writeStdin', kill: 'process/kill', resizePty: 'process/resizePty' },
    mcp: { list: 'mcpServerStatus/list', 'resource/read': 'mcpServer/resource/read', 'tool/call': 'mcpServer/tool/call', 'oauth/login': 'mcpServer/oauth/login', 'event/stream/start': 'mcpServer/event/stream/start', 'event/stream/stop': 'mcpServer/event/stream/stop' },
    codex_thread: { search: 'thread/search', fork: 'thread/fork', 'name/set': 'thread/name/set', archive: 'thread/archive', unarchive: 'thread/unarchive', compact: 'thread/compact/start', rollback: 'thread/rollback', revert: 'thread/revert', 'backgroundTerminals/list': 'thread/backgroundTerminals/list', 'backgroundTerminals/clean': 'thread/backgroundTerminals/clean', 'backgroundTerminals/terminate': 'thread/backgroundTerminals/terminate', timeline: 'thread/timeline/list' },
    codex_account: { read: 'account/read', 'usage/read': 'account/usage/read', 'rateLimits/read': 'account/rateLimits/read', 'workspaceMessages/read': 'account/workspaceMessages/read' },
  };
  for (const [domain, actions] of Object.entries(expected)) {
    assert.deepEqual(Object.keys(nativeDomains[domain as keyof typeof nativeDomains].actions).sort(), Object.keys(actions).sort());
    for (const [action, method] of Object.entries(actions)) {
      const params = { nativeFutureField: { falseValue: false, zero: 0, empty: '', nullable: null, array: [1, null] } };
      const value = await completed(domain, { action, params, requestId: randomUUID() });
      const result = value.state ? value.result : value;
      assert.equal(result.method, method);
      assert.deepEqual(value.state ? JSON.parse(await readFile(path.join(directory, `${value.requestId}.json`), 'utf8')).result.params : result.params, params);
    }
  }
});

test('typical fs, PTY, downstream MCP and file search calls preserve native fields and events without creating threads', async () => {
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['fs', 'writeFile', { path: '/tmp/native.txt', dataBase64: 'aGk=' }],
    ['fs', 'watch', { path: '/tmp/native.txt', watchId: 'watch-test' }],
    ['command', 'exec', { command: ['cat'], cwd: '/tmp', env: { LANG: null, EXAMPLE: 'yes' }, timeoutMs: 0, tty: true, size: { rows: 24, cols: 80 }, processId: 'command-test', streamStdin: true, streamStdoutStderr: true, sandboxPolicy: { type: 'readOnly' }, disableOutputCap: true }],
    ['process', 'spawn', { command: ['cat'], cwd: '/tmp', processHandle: 'process-test', timeoutMs: null, outputBytesCap: null, tty: true }],
    ['mcp', 'tool/call', { server: 'local', threadId: 'existing-thread', tool: 'inspect', arguments: { input: [1, 2] }, _meta: { progressToken: 7 } }],
  ];
  for (const [name, action, params] of cases) assert.deepEqual(JSON.parse(await readFile(path.join(directory, `${(await completed(name, { action, params, requestId: randomUUID() })).requestId}.json`), 'utf8')).result.params, params);
  const params = { query: 'ctrlmcp', roots: ['/tmp'], cancellationToken: null };
  assert.deepEqual((await call('file_search', params)).result.params, params);
  assert.equal((await call('codex_account', { action: 'workspaceMessages/read' })).result.params, null);
  const events = (await call('codex_events')).result.events;
  assert.ok(events.some((event: any) => event.method === 'fs/changed' && event.params.watchId === 'watch-test'));
  assert.ok(events.some((event: any) => event.method === 'process/exited' && event.params.processHandle === 'process-test'));
  const counts = (await completed('codex_call', { method: 'fixture/counts', requestId: randomUUID() })).result;
  assert.equal(counts['thread/start'], undefined);
  assert.equal(counts['turn/start'], undefined);
});

test('mutation receipts remain idempotent across domain and escape hatch, including pending and conflicting retries', async () => {
  const requestId = randomUUID();
  const params = { path: '/tmp/retry', dataBase64: '', delay: 200 };
  const first = await call('fs', { action: 'writeFile', params, requestId, waitMs: 0 });
  assert.equal(first.result.state, 'pending');
  const original = await completed('fs', { action: 'writeFile', params, requestId });
  const replay = await completed('codex_call', { method: 'fs/writeFile', params, requestId });
  assert.equal(replay.requestId, requestId);
  assert.deepEqual(replay.result, original.result);
  const conflict = await call('fs', { action: 'writeFile', params: { ...params, path: '/tmp/other' }, requestId });
  assert.equal(conflict.response.isError, true);
  assert.equal(conflict.result.error.code, 'REQUEST_ID_CONFLICT');
});

test('native errors retain code/message/data for both direct reads and mutation receipts; raw null/array results survive', async () => {
  const rpcError = { code: -32042, message: 'native fixture rejection', data: { retryable: false, detail: 'bad argument' } };
  const read = await call('codex_query', { method: 'project/list', params: { fail: 'bad argument' } });
  assert.equal(read.response.isError, true);
  assert.deepEqual(read.result.error.rpcError, rpcError);
  const write = await completed('process', { action: 'spawn', params: { fail: 'bad argument' }, requestId: randomUUID() });
  assert.equal(write.state, 'rejected');
  assert.deepEqual(write.result.error.rpcError, rpcError);
  assert.equal((await completed('codex_call', { method: 'fixture/null', params: null, requestId: randomUUID() })).result, null);
  assert.deepEqual((await completed('codex_call', { method: 'fixture/array', requestId: randomUUID() })).result, [null, 1, { native: true }]);
  assert.equal((await call('codex_tasks')).result.tasks.length, 0);
  assert.equal((await call('codex_capabilities')).result.version, version);
});

test('deployment fingerprints ignore tool/property ordering and runtime changes but detect every published definition change', async () => {
  const before = toolFingerprint(inventory.tools);
  const reorder = (value: any): any => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
  assert.deepEqual(toolFingerprint(reorder([...inventory.tools].reverse())), before);
  await call('codex_capabilities');
  assert.deepEqual(toolFingerprint((await client.listTools()).tools), before);
  for (const change of [
    (tools: any[]) => { tools[0].inputSchema.properties.added = { type: 'string' }; },
    (tools: any[]) => { tools[0].description += ' changed'; },
    (tools: any[]) => { tools[0].annotations.readOnlyHint = false; },
    (tools: any[]) => { tools[0].outputSchema.properties.result = { type: 'string' }; },
    (tools: any[]) => { tools.pop(); },
  ]) {
    const tools = structuredClone(inventory.tools); change(tools);
    assert.notEqual(toolFingerprint(tools).toolSchemaDigest, before.toolSchemaDigest);
  }
  assert.throws(() => toolFingerprint([inventory.tools[0], inventory.tools[0]]), /Duplicate/);
});

test('running owner retains startup package identity when the package manifest is replaced', async () => {
  const first = (await call('codex_capabilities')).result;
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '999.0.0' }));
  const second = (await call('codex_capabilities')).result;
  assert.equal(first.version, version);
  assert.equal(second.version, first.version);
  assert.equal(second.backendSession, first.backendSession);
  assert.ok(first.backendSession);
});

async function management(route: string, method = 'GET', body?: unknown) {
  const endpoint = JSON.parse(await readFile(path.join(directory, 'app/native.json'), 'utf8'));
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/api/${route}`, {
    method, headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}
test('setup clipboard preserves unrelated content on extraction failure and clears only after saving', async () => {
  const clipboard = path.join(directory, 'fixtures/clipboard.txt');
  const setup = path.join(directory, 'setup.json');
  await mkdir(path.dirname(clipboard), { recursive: true });
  await writeFile(setup, JSON.stringify({ goal: 'claude-loop', choices: { 'choose-address': 'fixed', 'choose-provider': 'other-provider' } }));
  await management('ingress', 'POST', { id: 'setup-claude-loop', controlSource: 'claude', transport: 'https', auth: 'oauth', enabled: false, config: { httpsProvider: 'cloudflare', cloudflareMode: 'named' } });
  const apply = () => management('setup/apply', 'POST', { stepId: 'address-secret', input: { source: 'clipboard' } });
  try {
    const unrelated = 'Unrelated clipboard text — keep this note.';
    await writeFile(clipboard, unrelated);
    await assert.rejects(apply, /Cloudflare Tunnel Token/);
    assert.equal(await readFile(clipboard, 'utf8'), unrelated);
    assert.equal((await management('ingress/setup-claude-loop')).config.hasCloudflareToken, false);

    const token = 'eyJ' + 'a'.repeat(80);
    await writeFile(clipboard, `cloudflared service install ${token}`);
    assert.deepEqual(await apply(), { hasCloudflareToken: true });
    assert.equal(JSON.parse(await readFile(path.join(directory, 'ingresses/setup-claude-loop/secrets.json'), 'utf8')).cloudflareToken, token);
    assert.equal(await readFile(clipboard, 'utf8'), '');
  } finally {
    await management('ingress/setup-claude-loop', 'DELETE');
    await rm(setup, { force: true });
    await rm(clipboard, { force: true });
  }
});

async function ingressRpc(ingress: any, method: string, params?: any) {
  if (method === 'tools/call') params = opCall(params.name, params.arguments);
  const response = await fetch(`http://127.0.0.1:${ingress.config.httpsPort}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${`test-${ingress.id}`.padEnd(40, 'x')}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('setup rejects a short runtime key without saving or clearing; HTTPS fallback reuses the ingress', async () => {
  const clipboard = path.join(directory, 'fixtures/clipboard.txt');
  const setup = path.join(directory, 'setup.json');
  await mkdir(path.dirname(clipboard), { recursive: true });
  await writeFile(setup, JSON.stringify({ goal: 'chatgpt-chat', choices: {} }));
  const apply = (stepId: string, input: object) => management('setup/apply', 'POST', { stepId, input });
  const poll = path.join(directory, 'poll-status.json');
  const tunnel = path.join(directory, 'tunnel-fixture');
  await writeFile(poll, '0');
  await writeFile(tunnel, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === '--version') { console.log('tunnel-client v0.0.16'); process.exit(0); }
if (process.argv[2] === 'init') process.exit(0);
const server = require('node:http').createServer((req, res) => {
  if (req.url === '/readyz') return res.end('ready');
  const code = JSON.parse(fs.readFileSync(${JSON.stringify(poll)}, 'utf8'));
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({status: code === 200 ? 'ok' : 'degraded', details: {http_status: code, ...(code === 200 ? {last_success: '2026-10-17T00:00:00Z'} : {})}}));
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(process.argv[process.argv.indexOf('--health.url-file') + 1], 'http://127.0.0.1:' + server.address().port));
`);
  await chmod(tunnel, 0o755);
  await management('ingress', 'POST', { id: 'setup-chatgpt-chat', controlSource: 'chatgpt', transport: 'openai-tunnel', auth: 'openai', enabled: false, config: { tunnelBinary: tunnel } });
  try {
    await apply('tunnel-credentials', { tunnelId: 'tunnel_fixture' });
    await writeFile(clipboard, '123456789');
    await assert.rejects(() => apply('tunnel-credentials', { source: 'clipboard' }), /OpenAI runtime key/);
    assert.equal(await readFile(clipboard, 'utf8'), '123456789');
    assert.equal((await management('ingress/setup-chatgpt-chat')).config.hasApiKey, false);
    await writeFile(clipboard, 'sk-' + 'a'.repeat(40));
    assert.deepEqual(await apply('tunnel-credentials', { source: 'clipboard' }), { hasApiKey: true });
    assert.equal(await readFile(clipboard, 'utf8'), '');
    await management('ingress/setup-chatgpt-chat', 'PUT', { enabled: true });
    await management('ingress/setup-chatgpt-chat/start', 'POST', {});
    // /readyz deliberately returns 200 throughout; it is not authentication evidence.
    let observed: any;
    for (let attempt = 0; attempt < 50; attempt++) {
      observed = await management('ingress/setup-chatgpt-chat');
      if (observed.controlPlane?.state === 'unknown') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(observed.controlPlane.state, 'unknown');
    assert.notEqual(observed.state, 'ready');
    for (const code of [401, 403]) {
      await writeFile(poll, JSON.stringify(code));
      observed = await management('ingress/setup-chatgpt-chat');
      assert.equal(observed.state, 'error');
      assert.equal(observed.controlPlane.state, 'rejected');
      assert.ok(observed.diagnostics.findings.some((f: any) => f.code === 'RUNTIME_KEY_REJECTED'));
      await assert.rejects(() => apply('tunnel-credentials', { source: 'clipboard' }), /OpenAI runtime key/);
    }
    await writeFile(poll, '200');
    observed = await management('ingress/setup-chatgpt-chat');
    assert.equal(observed.state, 'ready');
    assert.equal(observed.controlPlane.state, 'authenticated');
    await apply('chatgpt-fallback', { reason: 'platform-denied' });
    assert.equal(JSON.parse(await readFile(setup, 'utf8')).choices['chatgpt-blocked'], 'platform-denied');
    await apply('chatgpt-fallback', { option: 'https-oauth' });
    await apply('chatgpt-fallback', { option: 'https-oauth' });
    const entries = await management('ingress');
    const fallback = entries.filter((i: any) => i.id === 'setup-chatgpt-chat');
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0].controlSource, 'chatgpt');
    assert.equal(fallback[0].transport, 'https');
    assert.equal(fallback[0].auth, 'oauth');
    assert.equal(fallback[0].running, false);
  } finally {
    await management('ingress/setup-chatgpt-chat', 'DELETE').catch(() => {});
    await rm(setup, { force: true });
    await rm(clipboard, { force: true });
  }
});

test('tool presets use the full registry, preserve exact allowlists and close only necessary read dependencies', async () => {
  const config: ToolCatalog = await management('tool-catalog');
  assert.deepEqual(config.tools.filter(tool => tool.available !== false).map(tool => tool.name), operations.map(tool => tool.name));
  assert.deepEqual(Object.keys(catalog.toolExposure.tools).sort(), config.tools.map(tool => tool.name).sort());
  for (const tool of config.tools) {
    assert.ok(config.groups.some(group => group.id === tool.group));
    for (const dependency of tool.requires) assert.ok(config.tools.some(tool => tool.name === dependency));
  }
  const readOnly = presetPolicy('readOnly', config) as { allowlist: string[] };
  const common = presetPolicy('common', config) as { allowlist: string[] };
  for (const forbidden of ['git_write', 'edit', 'write', 'receipt', 'fs', 'command', 'process', 'mcp', 'codex_call', 'codex_thread', 'codex_query', 'codex_account', ...['agent', 'codex'].flatMap(prefix => ['create', 'send', 'interrupt', 'respond'].map(action => `${prefix}_${action}`))]) {
    assert.ok(!readOnly.allowlist.includes(forbidden), forbidden);
  }
  assert.ok(!common.allowlist.includes('git_write'));
  for (const dependency of ['git_write', 'receipt', 'control_output']) assert.ok(normalizeSelection(['git_write'], config).includes(dependency));
  // Read-only closure must not silently pull in any entry excluded from this preset.
  assert.deepEqual(new Set(readOnly.allowlist), new Set(config.tools.filter(tool => tool.presets.includes('readOnly')).map(tool => tool.name)));
  for (const prefix of ['agent', 'codex']) {
    for (const action of ['create', 'send', 'interrupt', 'respond', 'read', 'wait', 'pending', 'tasks']) assert.ok(common.allowlist.includes(`${prefix}_${action}`));
    const selection = normalizeSelection([`${prefix}_send`, `${prefix}_send`], config);
    for (const name of [`${prefix}_send`, 'receipt', `${prefix}_read`, `${prefix}_wait`, 'control_output', 'connector_verify']) assert.ok(selection.includes(name));
    assert.deepEqual(normalizeSelection(selection, config), selection);
    assert.ok(!selection.includes(`${prefix}_respond`), 'optional write response must not be auto-enabled');
  }
  assert.equal(identifyPolicy(undefined, config), 'common');
  assert.equal(identifyPolicy('all', config), 'all');
  for (const mode of ['common', 'readOnly'] as const) {
    const policy = presetPolicy(mode, config) as { allowlist: string[] };
    assert.equal(identifyPolicy({ allowlist: [...policy.allowlist].reverse().concat(policy.allowlist[0]) }, config), mode);
  }
  const legacy = { allowlist: ['read'] };
  assert.equal(identifyPolicy(legacy, config), 'custom');
  assert.deepEqual(legacy, { allowlist: ['read'] });
  const future = structuredClone(config);
  future.tools.push({ name: 'future_read', description: '', via: 'query', group: 'project', presets: ['readOnly'], requires: ['control_output'] });
  assert.equal(identifyPolicy(readOnly, future), 'custom');
  assert.ok(!readOnly.allowlist.includes('future_read'));
});

test('real HTTP ingresses isolate discovery and direct execution; policy PUT preserves identity, metadata and peer availability', async () => {
  const config: ToolCatalog = await management('tool-catalog');
  const a = await management('ingress', 'POST', { id: 'policy-all', name: 'Policy all', toolPolicy: 'all', controlSource: 'custom', transport: 'https', auth: 'bearer', bearerToken: 'test-policy-all'.padEnd(40, 'x'), config: { httpsProvider: 'custom', httpsUrl: 'https://policy-all.example/mcp' } });
  const b = await management('ingress', 'POST', { id: 'policy-read', name: 'Policy read', controlSource: 'custom', transport: 'https', auth: 'bearer', bearerToken: 'test-policy-read'.padEnd(40, 'x'), toolPolicy: presetPolicy('readOnly', config), config: { httpsProvider: 'custom', httpsUrl: 'https://policy-read.example/mcp' } });
  try {
    assert.equal(a.toolPolicy, 'all');
    await management(`ingress/${a.id}/start`, 'POST');
    await management(`ingress/${b.id}/start`, 'POST');
    const list = async (i: any) => (await ingressRpc(i, 'tools/call', {name:'guide',arguments:{}})).result.structuredContent.result.ops.map((op: any) => op.op);
    assert.deepEqual(await list(a), config.tools.filter(tool => tool.available !== false).map(tool => tool.name));
    assert.deepEqual(await list(b), config.tools.filter(tool => (b.toolPolicy.allowlist.includes(tool.name) || ['notification_ack', 'notify_status'].includes(tool.name)) && tool.available !== false).map(tool => tool.name));
    assert.deepEqual((await management('tool-catalog')).tools, config.tools, 'management inventory remains unfiltered');
    for (const name of config.tools.filter(tool => !b.toolPolicy.allowlist.includes(tool.name) && !['notification_ack', 'notify_status'].includes(tool.name)).map(tool => tool.name)) {
      assert.equal((await ingressRpc(b, 'tools/call', { name, arguments: { action: 'approve', requestId: randomUUID() } })).result.structuredContent.result.error.code, 'OP_UNAVAILABLE', name);
    }
    const args = { requestId: randomUUID(), method: 'fixture/counts', params: {} };
    const blocked = await ingressRpc(b, 'tools/call', { name: 'codex_call', arguments: args });
    assert.equal(blocked.result.isError, true);
    assert.equal(blocked.result.structuredContent.result.error.code, 'OP_UNAVAILABLE');
    const missingReceipt = await ingressRpc(a, 'tools/call', { name: 'receipt', arguments: { requestId: args.requestId } });
    assert.equal(missingReceipt.result.structuredContent.result.state, 'not-found', 'blocked mutation did not create a receipt');
    const allowed = await ingressRpc(a, 'tools/call', { name: 'codex_call', arguments: args });
    assert.equal(allowed.result.isError, false);
    // A restricted real read succeeds, not merely schema validation or list filtering.
    const read = await ingressRpc(b, 'tools/call', { name: 'read', arguments: { project: directory, path: 'app-server.mjs' } });
    assert.equal(read.result.isError, false, JSON.stringify(read));
    const verifyFile = path.join(directory, 'ingresses', b.id, 'verification.json');
    const code = JSON.parse(await readFile(verifyFile, 'utf8')).code;
    const verified = await ingressRpc(b, 'tools/call', { name: 'connector_verify', arguments: { code } });
    assert.equal(verified.result.isError, false, JSON.stringify(verified));
    const identity = await readFile(verifyFile, 'utf8');
    const secrets = await readFile(path.join(directory, 'ingresses', b.id, 'secrets.json'), 'utf8');
    for (const policy of [presetPolicy('common', config), { allowlist: normalizeSelection(['agent_send'], config) }, 'all'] as ToolPolicy[]) {
      await management(`ingress/${b.id}/stop`, 'POST');
      const saved = await management(`ingress/${b.id}`, 'PUT', { toolPolicy: policy });
      assert.deepEqual(saved.toolPolicy, policy);
      assert.equal(saved.name, b.name);
      assert.equal(saved.controlSource, b.controlSource);
      assert.equal(saved.auth, b.auth);
      assert.deepEqual(saved.config, b.config);
      assert.equal(await readFile(verifyFile, 'utf8'), identity);
      assert.equal(await readFile(path.join(directory, 'ingresses', b.id, 'secrets.json'), 'utf8'), secrets);
      assert.deepEqual((await management(`ingress/${b.id}`)).toolPolicy, policy);
      await management(`ingress/${b.id}/start`, 'POST');
      assert.equal(await readFile(verifyFile, 'utf8'), identity);
      assert.deepEqual(await list(b), config.tools.filter(tool => (policy === 'all' || policy.allowlist.includes(tool.name) || ['notification_ack', 'notify_status'].includes(tool.name)) && tool.available !== false).map(tool => tool.name));
      assert.deepEqual(await list(a), config.tools.filter(tool => tool.available !== false).map(tool => tool.name), 'other ingress stays online and unchanged');
    }
    await management(`ingress/${b.id}/stop`, 'POST');
    await management(`ingress/${b.id}`, 'PUT', { toolPolicy: { allowlist: [] } });
    await management(`ingress/${b.id}/start`, 'POST');
    assert.deepEqual(await list(b), ['guide', 'notification_ack', 'notify_status']);
    for (const name of ['connector_verify', 'codex_wait', 'agent_wait']) assert.equal((await ingressRpc(b, 'tools/call', { name, arguments: {} })).result.structuredContent.result.error.code, 'OP_UNAVAILABLE');
  } finally {
    await management(`ingress/${a.id}`, 'DELETE');
    await management(`ingress/${b.id}`, 'DELETE');
  }
});

// Simulate only the tunnel provider's loopback readiness API; ingress commit and
// persistence still run through the compiled production Service implementation.
test('managed draft commits the selected policy instead of publishing all tools', { skip: process.platform !== 'darwin' }, async () => {
  const dependency = path.join(directory, 'dependencies/cloudflare', `darwin-${process.arch === 'arm64' ? 'arm64' : 'amd64'}`);
  await mkdir(dependency, { recursive: true });
  const binary = path.join(dependency, 'cloudflared');
  const script = `#!/usr/bin/env node
const http = require('node:http');
const endpoint = process.argv[process.argv.indexOf('--metrics') + 1];
http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.url === '/quicktunnel' ? {hostname:'policy-draft.trycloudflare.com'} : {})); }).listen(Number(endpoint.split(':')[1]), '127.0.0.1');
`;
  await writeFile(binary, script);
  await chmod(binary, 0o700);
  await writeFile(path.join(dependency, 'installed.json'), JSON.stringify({sha256:createHash('sha256').update(script).digest('hex')}));
  const config: ToolCatalog = await management('tool-catalog');
  for (const policy of [presetPolicy('readOnly', config), {allowlist:normalizeSelection(['agent_send'], config)}]) {
    let draft = await management('ingress-drafts', 'POST', {config:{httpsProvider:'cloudflare',cloudflareMode:'quick',proxyMode:'direct'}});
    let committed = false;
    try {
      const deadline = Date.now() + 10000;
      while (!draft.url) {
        assert.ok(Date.now() < deadline, 'local tunnel fixture becomes ready');
        await new Promise(resolve => setTimeout(resolve, 50));
        draft = await management(`ingress-drafts/${draft.id}`);
      }
      assert.deepEqual(draft.toolPolicy, {allowlist:[]});
      const saved = await management(`ingress-drafts/${draft.id}/commit`, 'POST', { name:'Policy draft',controlSource:'custom',auth:'bearer',toolPolicy:policy,url:draft.url });
      committed = true;
      assert.deepEqual(saved.toolPolicy, policy);
      assert.deepEqual((await management(`ingress/${saved.id}`)).toolPolicy, policy);
      const disk = JSON.parse(await readFile(path.join(directory, 'ingresses', saved.id, 'config.json'), 'utf8'));
      assert.deepEqual(disk.toolPolicy, policy);
    } finally {
      await management(`${committed ? 'ingress' : 'ingress-drafts'}/${draft.id}`, 'DELETE');
    }
  }
});


test('Git writes use durable receipts, isolated identity and safe local workflows', async () => {
  const project = path.join(directory, 'git-write');
  await mkdir(project);
  const git = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } }).trim();
  git('init', '-b', 'main');
  await writeFile(path.join(project, 'file.txt'), 'initial\n');
  const write = (operation: string, args: Record<string, unknown> = {}) => completed('git_write', { project, operation, requestId: randomUUID(), ...args });
  const success = async (operation: string, args: Record<string, unknown> = {}) => {
    const receipt = await write(operation, args);
    assert.equal(receipt.state, 'completed', JSON.stringify(receipt));
    return receipt;
  };
  assert.equal((await call('git_write', { project, operation: 'add', all: true })).result.state, 'completed');
  assert.equal((await call('git_write', { project, operation: 'add', all: true, requestId: 'invalid' })).response.isError, true);
  for (const args of [{}, { paths: [] }, { all: true, paths: ['file.txt'] }, { paths: ['../outside'] }, { paths: [project] }]) assert.notEqual((await write('add', args)).state, 'completed');
  await success('add', { paths: ['file.txt'] });
  await success('unstage', { all: true });
  assert.equal(git('ls-files'), '');
  assert.equal(await readFile(path.join(project, 'file.txt'), 'utf8'), 'initial\n');
  await success('add', { all: true });
  const requestId = randomUUID();
  const message = 'feat: first commit\n\nA multiline message';
  await success('commit', { requestId, message });
  assert.equal(git('log', '-1', '--format=%an <%ae>'), 'Global Fixture <fixture@example.invalid>');
  assert.equal(git('log', '-1', '--format=%B'), message);
  const replay = await success('commit', { message, requestId });
  assert.equal((await call('receipt', { requestId })).result.requestId, replay.requestId);
  assert.equal(git('rev-list', '--count', 'HEAD'), '1');
  assert.equal((await call('git_write', { project, operation: 'commit', requestId, message: 'different' })).response.isError, true);
  for (const operation of ['reset', 'clean', 'push', 'rebase']) assert.equal((await call('git_write', { project, operation, requestId: randomUUID() })).response.isError, true);
  assert.notEqual((await write('commit', { message: '   ' })).state, 'completed');
  assert.equal((await call('git_write', { project, operation: 'commit', message: 'no amend', amend: true, requestId: randomUUID() })).response.isError, true);
  assert.notEqual((await write('branch', { branch: '-D' })).state, 'completed');
  await success('branch', { branch: 'topic' });
  await success('switch', { branch: 'topic' });
  await success('switch', { branch: 'other', create: true });
  assert.equal(git('branch', '--show-current'), 'other');
  await writeFile(path.join(project, 'file.txt'), 'changed\n');
  await success('add', { all: true });
  await success('unstage', { paths: ['file.txt'] });
  assert.equal(git('diff', '--cached'), '');
  await success('stash_push', { message: 'work in progress' });
  assert.equal(await readFile(path.join(project, 'file.txt'), 'utf8'), 'initial\n');
  await success('stash_pop');
  assert.equal(await readFile(path.join(project, 'file.txt'), 'utf8'), 'changed\n');
  assert.equal(git('stash', 'list'), '');
  // Local identity wins; executable hooks and attribute filters must not run.
  git('config', 'user.name', 'Local Fixture');
  git('config', 'user.email', 'local@example.invalid');
  git('config', 'filter.block.clean', 'exit 91');
  git('config', 'filter.block.smudge', 'exit 92');
  git('config', 'filter.block.required', 'true');
  await writeFile(path.join(project, '.gitattributes'), '*.txt filter=block\n');
  await writeFile(path.join(project, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 93\n');
  await chmod(path.join(project, '.git/hooks/pre-commit'), 0o755);
  await success('add', { all: true });
  await success('commit', { message: 'local identity' });
  assert.equal(git('log', '-1', '--format=%an <%ae>'), 'Local Fixture <local@example.invalid>');
  git('config', '--remove-section', 'filter.block');
  assert.ok(!(await call('git', { project, operation: 'status' })).response.isError);
  git('config', 'user.email', '');
  const missingIdentity = await write('commit', { message: 'missing identity' });
  assert.equal(missingIdentity.state, 'failed');
  assert.match(JSON.stringify(missingIdentity.result), /configure user.email/);
  git('config', 'user.email', 'local@example.invalid');
  // Literal pathspecs must not treat wildcard-looking names as patterns.
  if (process.platform !== 'win32') {
    await writeFile(path.join(project, '*.txt'), 'literal\n');
    await writeFile(path.join(project, 'not-staged.txt'), 'other\n');
    await success('add', { paths: ['*.txt'] });
    assert.equal(git('diff', '--cached', '--name-only'), '*.txt');
    await success('commit', { message: 'literal path' });
  }
  // Stash conflicts preserve the stash; replay must not attempt pop again.
  await writeFile(path.join(project, 'file.txt'), 'stashed version\n');
  await success('stash_push');
  await writeFile(path.join(project, 'file.txt'), 'committed version\n');
  await success('add', { paths: ['file.txt'] });
  await success('commit', { message: 'conflicting version' });
  git('config', 'merge.block.driver', 'exit 94');
  const blockedMerge = await write('stash_pop');
  assert.equal(blockedMerge.state, 'failed');
  assert.match(JSON.stringify(blockedMerge.result), /external merge drivers/);
  assert.equal(git('ls-files', '--unmerged'), '');
  git('config', '--remove-section', 'merge.block');
  const popId = randomUUID();
  const conflict = await write('stash_pop', { requestId: popId });
  assert.equal(conflict.state, 'failed');
  assert.ok(git('stash', 'list'));
  assert.ok(git('ls-files', '--unmerged'));
  assert.equal((await write('stash_pop', { requestId: popId })).requestId, popId);
});


test('latest items pin the newest turn and preserve explicit turn and native cursor semantics', async () => {
  const threadId = 'image-pagination';
  const old = (await call('codex_items', {threadId})).result;
  assert.equal(old.items[0].itemId, 'old-first');
  assert.equal(old.turnId, undefined);
  const first = (await call('codex_items', {threadId, latest:true})).result;
  assert.equal(first.turnId, 'turn-latest');
  assert.equal(first.items[0].itemId, 'latest-last');
  assert.ok(first.nextCursor);
  const next = (await call('codex_items', {threadId, latest:true, turnId:first.turnId, cursor:first.nextCursor})).result;
  assert.equal(next.items[0].itemId, 'latest-first');
  assert.equal(next.nextCursor, null);
  const explicit = (await call('codex_items', {threadId, latest:true, turnId:'turn-old'})).result;
  assert.equal(explicit.items[0].itemId, 'old-first');
  const legacyNext = (await call('codex_items', {threadId, cursor:old.nextCursor})).result;
  assert.equal(legacyNext.items[0].itemId, 'latest-first');
  assert.equal((await call('codex_items', {threadId,latest:true,cursor:first.nextCursor})).response.isError, true);
  const empty = (await call('codex_items', {threadId:'empty-images',latest:true})).result;
  assert.deepEqual(empty.items, []);
  assert.equal(empty.nextCursor, null);
  assert.equal(empty.turnId, null);
});

test('creation starts its first turn without legacy history reads, cleans definite failures and retains uncertain submissions', async () => {
  const create = async (model: string) => completed('codex_create', {
    project: directory, prompt: 'ping', thread: { model }, requestId: randomUUID(), waitMs: 1000,
  });
  const accepted = await create('fixture-dispatch');
  assert.equal(accepted.state, 'completed');
  assert.ok(accepted.threadId && accepted.turnId);
  // Exercise the real background waiter against paginated history, including
  // a requested older turn on the second page.
  await mkdir(path.join(directory, 'execution'), {recursive:true});
  await writeFile(path.join(directory, 'execution', accepted.threadId+'.json'), JSON.stringify({owner:'connector'}));
  const nextReceipt = await completed('codex_call', {method:'turn/start',params:{threadId:accepted.threadId,input:[]},requestId:randomUUID()});
  assert.equal(nextReceipt.state, 'completed');
  const latest = (await call('codex_wait', {threadId:accepted.threadId,timeoutMs:1000})).result;
  assert.equal(latest.state, 'completed');
  assert.equal(latest.turnId, nextReceipt.turnId);
  const earlier = (await call('codex_wait', {threadId:accepted.threadId,turnId:accepted.turnId,timeoutMs:1000})).result;
  assert.equal(earlier.state, 'completed');
  assert.equal(earlier.turnId, accepted.turnId);
  assert.equal(earlier.finalResponse.text, 'pong');
  const rejected = await create('fixture-dispatch-reject');
  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.cleanup.archived, true);
  assert.equal(rejected.failureStage, 'turn-submitting');
  const uncertain = await create('fixture-dispatch-uncertain');
  assert.equal(uncertain.state, 'unconfirmed');
  assert.equal(uncertain.cleanup, undefined);
  const saved = JSON.parse(await readFile(path.join(directory, 'dispatch-fixture.json'), 'utf8'));
  assert.equal(saved[accepted.threadId].turns.length, 2);
  if (process.platform !== 'linux') assert.ok(saved[accepted.threadId].metadataReads > 0);
  assert.equal(saved[rejected.threadId].archived, true);
  assert.equal(saved[uncertain.threadId].turns.length, 1);
  assert.equal(saved[uncertain.threadId].archived, false);
});

async function eventually<T>(read: () => Promise<T>, accept: (value:T)=>boolean, timeout=40000): Promise<T> {
  const deadline=Date.now()+timeout;let value:T;
  do {value=await read();if(accept(value))return value;await new Promise(r=>setTimeout(r,100));}while(Date.now()<deadline);
  assert.fail('Timed out: '+JSON.stringify(value));
}
async function dispatchFixture(model: string) {
  await writeFile(path.join(directory,'task-settings.json'),JSON.stringify({autoOpenCodex:false,codexRetryMaxAttempts:3,codexRetryInitialSeconds:1}));
  const r=await completed('codex_create',{project:directory,prompt:'harmless fixture',thread:{model},purpose:'self-test',requestId:randomUUID(),waitMs:1000});assert.equal(r.state,'completed');return r;
}
const fixtureRows = async () => JSON.parse(await readFile(path.join(directory,'dispatch-fixture.json'),'utf8'));

test('respond tokens preserve legacy responses, bind thread and reject reuse', async () => {
  const created=await dispatchFixture('fixture-dispatch-question');
  const pending=await eventually(async()=>(await call('codex_pending',{threadId:created.threadId})).result,v=>v.requests?.length>0);
  const request=pending.requests.find((r:any)=>r.params.threadId===created.threadId);
  assert.equal(request.respondToken.length,22);
  await completed('codex_call',{method:'fixture/finish-turn',params:{threadId:created.threadId},requestId:randomUUID()});
  const queued=await completed('codex_send',{threadId:created.threadId,prompt:'after answer',sendMode:'queue',purpose:'self-test',requestId:randomUUID()});
  await eventually(async()=>(await call('codex_queue',{queueId:queued.queueId})).result,v=>v.items[0]?.reason==='waiting-input');
  assert.equal((await fixtureRows())[created.threadId].turns.length,1);
  const wrong=await completed('codex_respond',{respondToken:request.respondToken,threadId:randomUUID(),result:{answers:{q:{answers:['4']}}},requestId:randomUUID()});assert.equal(wrong.state,'failed');
  const answered=await completed('codex_respond',{respondToken:request.respondToken,result:{answers:{q:{answers:['4']}}},requestId:randomUUID()});assert.equal(answered.state,'completed');
  assert.equal((await fixtureRows())[created.threadId].answer.answers.q.answers[0],'4');
  const again=await completed('codex_respond',{respondToken:request.respondToken,result:{answers:{}},requestId:randomUUID()});assert.equal(again.state,'failed');
  await eventually(fixtureRows,v=>v[created.threadId].turns.length===2);
  const legacy=await dispatchFixture('fixture-dispatch-question');
  const raw=await eventually(async()=>(await call('codex_pending',{threadId:legacy.threadId})).result,v=>v.requests?.length>0);
  const q=raw.requests.find((r:any)=>r.params.threadId===legacy.threadId);
  assert.equal((await completed('codex_respond',{backendSession:raw.backendSession,id:q.responseId,result:{answers:{q:{answers:['4']}}},requestId:randomUUID()})).state,'completed');
});

test('FIFO queue never steers, pauses on failures, supports cancellation/resume and stores durable state', async () => {
  const created=await dispatchFixture('fixture-dispatch-queue');
  const steered=await completed('codex_send',{threadId:created.threadId,prompt:'steer',requestId:randomUUID()});assert.equal(steered.dispatchMode,'steered');assert.equal(steered.turnId,created.turnId);
  const enqueue=async(prompt:string)=>completed('codex_send',{threadId:created.threadId,prompt,sendMode:'queue',purpose:'self-test',requestId:randomUUID()});
  const a=await enqueue('first'),b=await enqueue('cancel-me'),c=await enqueue('third');assert.equal(a.dispatchMode,'queued');assert.ok(a.queueId);
  await new Promise(r=>setTimeout(r,1200));assert.equal((await fixtureRows())[created.threadId].turns.length,1);
  await client.close();await connectFixture();
  const restored=(await call('codex_queue',{threadId:created.threadId})).result;assert.equal(restored.total,3);assert.ok(restored.items.every((r:any)=>r.state==='queued'));
  assert.equal((await call('codex_queue_control',{threadId:created.threadId,queueId:b.queueId,action:'cancel'})).result.changed,1);
  await completed('codex_call',{method:'fixture/finish-turn',params:{threadId:created.threadId},requestId:randomUUID()});
  await eventually(fixtureRows,v=>v[created.threadId].turns.length===2);
  assert.equal((await fixtureRows())[created.threadId].turns[1].input[0].text,'first');
  await completed('codex_call',{method:'fixture/finish-turn',params:{threadId:created.threadId,status:'failed'},requestId:randomUUID()});
  const query=async()=>(await call('codex_queue',{threadId:created.threadId})).result;
  await eventually(query,v=>v.items.find((r:any)=>r.queueId===c.queueId)?.state==='blocked');
  assert.equal((await call('codex_queue_control',{threadId:created.threadId,action:'resume'})).result.changed,1);
  await eventually(fixtureRows,v=>v[created.threadId].turns.length===3);
  const rows=await fixtureRows();assert.equal(rows[created.threadId].turns[2].input[0].text,'third');assert.equal(rows[created.threadId].steers,1);
  const saved=JSON.parse(await readFile(path.join(directory,'send-queue',a.queueId+'.json'),'utf8'));assert.equal(saved.args.prompt,'first');assert.ok(saved.dispatchRequestId);
  await completed('codex_call',{method:'fixture/finish-turn',params:{threadId:created.threadId},requestId:randomUUID()});
});

test('capacity failures retry same model without replaying input, suppress intermediate failure and stop after budget or side effects', async () => {
  const created=await dispatchFixture('fixture-dispatch-overload');
  await eventually(fixtureRows,v=>v[created.threadId].turns.length===3);
  let rows=await fixtureRows();assert.equal(rows[created.threadId].turns[2].status,'completed');
  assert.ok(rows[created.threadId].turns.slice(1).every((t:any)=>t.model==='fixture-dispatch-overload'&&t.input[0].text.includes('从中断处继续')&&!t.input[0].text.includes('harmless fixture')));
  const bindings=async(thread:string)=>{const {readdir}=await import('node:fs/promises');return Promise.all((await readdir(path.join(directory,'notifications'))).filter(f=>f.endsWith('.json')).map(async f=>JSON.parse(await readFile(path.join(directory,'notifications',f),'utf8')))).then(bs=>bs.filter(b=>b.threadId===thread));};
  let bs=await bindings(created.threadId);assert.ok(bs.every(b=>b.target===null));assert.ok(bs.every(b=>b.deliveries.every((d:any)=>d.taskState!=='failed')));
  const exhausted=await dispatchFixture('fixture-dispatch-overload-exhausted');
  bs=await eventually(()=>bindings(exhausted.threadId),bs=>bs.some(b=>b.terminal&&b.retry?.status==='exhausted'));
  rows=await fixtureRows();assert.equal(rows[exhausted.threadId].turns.length,4);assert.equal(bs.flatMap(b=>b.deliveries).filter(d=>d.taskState==='failed').length,1);assert.ok(bs.some(b=>b.retry.attempts===3));
  const unsafe=await dispatchFixture('fixture-dispatch-overload-side-effect');
  await eventually(()=>bindings(unsafe.threadId),bs=>bs.some(b=>b.terminal&&b.retry?.status==='skipped'));
  assert.equal((await fixtureRows())[unsafe.threadId].turns.length,1);
});


test('task overview defaults to compact live evidence and full view retains preview and cursor', async()=>{
  const compact=(await call('codex_tasks',{searchTerm:'fixture-overview'})).result;
  assert.equal(compact.view,'compact');assert.equal(compact.nextCursor,'native-cursor');
  assert.equal(compact.tasks[0].status,'running');assert.equal(compact.tasks[0].title,'Live');
  assert.equal(compact.tasks[0].model,'fixture-model');assert.equal(compact.tasks[0].currentTurn.turnId,'current-turn');
  assert.equal(compact.tasks[1].status,'unconfirmed');assert.match(compact.tasks[1].statusReason,/no live owner/);
  assert.equal(compact.tasks[2].status,'unconfirmed');assert.match(compact.tasks[2].statusReason,/owner unavailable/);assert.equal(compact.tasks[2].currentTurn.turnId,'current-turn');assert.equal(compact.tasks[2].currentTurn.source,'persisted-history');
  assert.ok(compact.tasks.every((t:any)=>!('preview' in t)));assert.ok(JSON.stringify(compact.tasks).length<2000);
  const paged=(await call('codex_tasks',{searchTerm:'fixture-overview',view:'full'})).result;
  assert.ok(paged.outputId);let text=paged.text,offset=paged.nextOffset;
  while(offset!==null){const page=(await call('control_output',{outputId:paged.outputId,offset,length:30000})).result;text+=page.text;offset=page.nextOffset;}
  const full=JSON.parse(text);
  assert.equal(full.tasks[0].preview.length,77000);assert.ok(full.tasks[0].configuration);assert.equal(full.nextCursor,'native-cursor');
});

test('completed notification freezes bounded Git changes with attribution and full-query pagination',async()=>{
  const repo=path.join(directory,'notification-repo');await mkdir(repo);
  const git=(...args:string[])=>execFileSync('git',['-c','commit.gpgSign=false','-c','user.name=ARC Fixture','-c','user.email=fixture@example.invalid',...args],{cwd:repo,encoding:'utf8'});
  git('init','--quiet');git('commit','--quiet','--allow-empty','-m','chore: initial');
  const r=await completed('codex_create',{project:repo,prompt:'harmless fixture',thread:{model:'fixture-dispatch-queue'},purpose:'self-test',requestId:randomUUID()});assert.equal(r.state,'completed');
  for(let i=0;i<6;i++){await writeFile(path.join(repo,'sample.txt'),'line\n'.repeat(i+1));git('add','sample.txt');git('commit','--quiet','-m','feat: '+String(i)+' '+ 'title'.repeat(30));}
  // Finish directly, then read immediately: codex_wait can publish completion
  // before the background observer and must freeze the same Git snapshot.
  const fixture=await fixtureRows();fixture[r.threadId].turns.at(-1).status='completed';
  await writeFile(path.join(directory,'dispatch-fixture.json'),JSON.stringify(fixture));
  const waited=(await call('codex_wait',{threadId:r.threadId,turnId:r.turnId,timeoutMs:1000})).result;
  assert.equal(waited.state,'completed');
  const {readdir}=await import('node:fs/promises');
  const load=async()=>Promise.all((await readdir(path.join(directory,'notifications'))).filter(f=>f.endsWith('.json')).map(async f=>JSON.parse(await readFile(path.join(directory,'notifications',f),'utf8'))));
  const bs=await eventually(load,bs=>bs.some(b=>b.threadId===r.threadId&&b.deliveries.some((d:any)=>d.changes)));
  const d=bs.find(b=>b.threadId===r.threadId).deliveries.find((d:any)=>d.taskState==='completed');
  assert.equal(d.changes.commitCount,6);assert.equal(d.changes.commits.length,5);assert.equal(d.changes.truncated,true);
  assert.equal(d.changes.summary.files,1);assert.equal(d.changes.summary.added,6);assert.equal(d.changes.fallback,false);
  assert.match(d.changes.attribution,/other tasks/);assert.ok(d.changes.commits.every((c:any)=>c.title.length<=120));
  await writeFile(path.join(repo,'sample.txt'),'changed after observation');
  const reread=(await load()).find(b=>b.threadId===r.threadId).deliveries.find((d:any)=>d.taskState==='completed');assert.deepEqual(reread.changes,d.changes);
  const full=(await call('codex_changes',{threadId:r.threadId,turnId:r.turnId,limit:100})).result;assert.equal(full.commits.length,6);
});
