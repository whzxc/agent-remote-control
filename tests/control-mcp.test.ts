import {assertNextCalls} from './helpers/continuations.ts';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { identifyPolicy, normalizeSelection, presetPolicy, type ToolCatalog, type ToolPolicy } from '../ui/toolPolicy.ts';
import { buildVersion } from '../tooling/version.mjs';
import { toolFingerprint } from '../tooling/catalog.mjs';
const catalog = JSON.parse(await readFile(new URL('../native/src/catalog.json', import.meta.url), 'utf8'));
const version = buildVersion();

let directory: string;
let stateDir: string;
let endpoint: { port: number; token: string };
let client: Client;
let fixtureCommand: string;
let fixtureEnv: Record<string,string>;
async function connectFixture() {
  client = new Client({name:"agent-remote-control-test",version:"1"});
  await client.connect(new StdioClientTransport({command:fixtureCommand,env:fixtureEnv,stderr:"inherit"}));
  endpoint = JSON.parse(await readFile(path.join(stateDir, "app/native.json"), "utf8"));
}
let inventory: Awaited<ReturnType<Client['listTools']>>;
let operations: typeof inventory.tools;
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'agent-remote-control-test-'));
  stateDir = path.join(directory, 'arc-state');
  // Explicit all policy exercises the entire registered tool surface.
  await mkdir(path.join(stateDir, 'ingresses/default'), { recursive: true });
  await writeFile(path.join(stateDir, 'ingresses/index.json'), JSON.stringify(['default']));
  await writeFile(path.join(stateDir, 'ingresses/default/config.json'), JSON.stringify({ id: 'default', name: 'ChatGPT', controlSource: 'chatgpt', transport: 'openai-tunnel', auth: 'openai', enabled: true, toolPolicy: 'all', config: {} }));
  await writeFile(path.join(stateDir, 'ingresses/default/secrets.json'), JSON.stringify({apiKey:'',cloudflareToken:'',ngrokAuthtoken:''}));
  const home = path.join(directory, 'home');
  await mkdir(home);
  await writeFile(path.join(home, '.gitconfig'), '[user]\nname = Global Fixture\nemail = fixture@example.invalid\n[commit]\ngpgSign = true\n');
  const fixture = path.join(directory, 'app-server.mjs');
  await writeFile(fixture, `
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const fixtureState = process.env.ARC_FIXTURE_DATA + '/dispatch-fixture.json';
const saveFixture = saved => {
  const temporary = fixtureState + '.tmp';
  writeFileSync(temporary, JSON.stringify(saved));
  renameSync(temporary, fixtureState);
};
const counts = new Map();
let sizeRevision=0;
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params, result } = JSON.parse(line);
  if (!method && result) {
    const saved = JSON.parse(readFileSync(fixtureState,'utf8'));
    const row = Object.values(saved).find(r=>r.pendingId===id);
    if(row){row.answer=result;row.turns.at(-1).status='completed';delete row.pendingId;saveFixture(saved);}
    continue;
  }
  if (id === undefined) continue;
  const calls = (counts.get(method) || 0) + 1; counts.set(method, calls);
  const reply = () => {
    if (params?.fail) return emit({ id, error: { code: -32042, message: 'native fixture rejection', data: { retryable: false, detail: params.fail } } });
    if (method === 'initialize') return emit({ id, result: { userAgent: 'fixture' } });
    if (method === 'fixture/change-size-item') {sizeRevision++;return emit({id,result:{revision:sizeRevision}});}
    if (method === 'fixture/counts') return emit({ id, result: Object.fromEntries(counts) });
    if (method === 'fixture/null') return emit({ id, result: null });
    if (method === 'fixture/array') return emit({ id, result: [null, 1, { native: true }] });
    const saved = existsSync(fixtureState) ? JSON.parse(readFileSync(fixtureState, 'utf8')) : {};
    if (method === 'fixture/external-review') {
      const threadId=params.threadId,turnId=randomUUID();
      const configuration=params.known===false?{}:{model:'fixture-external-model',effort:'high',serviceTier:'priority'};
      saved[threadId]={thread:{...saved[threadId].thread,...configuration},model:'fixture-dispatch-external',externalReview:true,turns:[{id:turnId,status:'completed',items:[]},{id:randomUUID(),status:'inProgress',items:[]}],metadataReads:0};
      saveFixture(saved);return emit({id,result:{threadId,turnId,activeTurnId:saved[threadId].turns.at(-1).id}});
    }
    if (method === 'thread/list' && params.searchTerm === 'fixture-external-review') return emit({id,result:{data:Object.values(saved).filter(r=>r.externalReview).map(r=>({...r.thread,status:{type:'active'}})),nextCursor:null}});
    if (method === 'thread/start' && params.model?.startsWith('fixture-dispatch')) {
      const thread = {id:randomUUID(),cwd:params.cwd,path:params.model.includes('lazy-seed')?null:process.env.ARC_FIXTURE_DATA+'/seed-'+randomUUID()+'.jsonl'};
      if(thread.path)writeFileSync(thread.path, '{}');
      saved[thread.id] = {thread,model:params.model,turns:[],metadataReads:0,archived:false,creator:process.pid};
      saveFixture(saved);
      return emit({id,result:{thread,model:params.model}});
    }
    if (saved[params?.threadId]) {
      const row = saved[params.threadId];
      if (row.model.includes('unmaterialized') && !row.turns.length && ['thread/turns/list','thread/archive'].includes(method)) {
        row.prematureReads=(row.prematureReads||0)+1;saveFixture(saved);
        return emit({id,error:{code:-32600,message:'thread '+params.threadId+' is not materialized yet; '+method+' is unavailable before first user message'}});
      }
      if (method === 'thread/name/set') {
        row.named=true;row.thread.name=params.name;saveFixture(saved);return emit({id,result:{}});
      }
      if (method === 'thread/unsubscribe') {
        row.unsubscribed=true;saveFixture(saved);return emit({id,result:{}});
      }
      if (method === 'thread/read') {
        if(row.model.includes('lazy-seed') && !row.named)return emit({id,error:{code:-32000,message:'seed not durable until named'}});
        if(row.model.includes('lazy-seed'))row.independentReader=process.pid!==row.creator;
        if (params.includeTurns && row.model.includes('question')) return emit({id,result:{thread:{...row.thread,turns:row.turns,status:{type:row.turns.at(-1)?.status==='inProgress'?'active':'idle'}}}});
        if (params.includeTurns) return emit({id,error:{code:-32601,message:'list_turns is not supported yet'}});
        row.metadataReads++;
        saveFixture(saved);
        return emit({id,result:{thread:{...row.thread,status:{type:row.turns.at(-1)?.status==='inProgress'?'active':'idle'}}}});
      }
      if (method === 'turn/start') {
        if (row.model === 'fixture-dispatch-reject' || row.model === 'fixture-dispatch-unmaterialized-reject') return emit({id,error:{code:-32602,message:'invalid turn configuration'}});
        const overload=row.model.includes('overload') && (row.model.includes('exhausted') || row.model.includes('side-effect') || row.turns.length<2);
        row.turns.push({id:randomUUID(),status:overload?'failed':(row.model.includes('queue')||(row.model.includes('question')&&row.turns.length===0))?'inProgress':'completed',error:overload?{codexErrorInfo:'serverOverloaded',message:'Selected model is at capacity'}:null,items:overload?(row.model.includes('side-effect')?[{type:'commandExecution',status:'completed'}]:[]):[{id:randomUUID(),type:'agentMessage',status:'completed',text:'pong'}],input:params.input,model:params.model||row.model,effort:params.effort});
        saveFixture(saved);
        if(row.model==='fixture-dispatch-question-terminal')emit({method:'turn/started',params:{threadId:params.threadId,turn:row.turns.at(-1)}});
        if(row.model.includes('queue'))emit({method:'item/completed',params:{threadId:params.threadId,turnId:row.turns.at(-1).id,item:row.turns.at(-1).items[0]}});
        if(row.model.includes('question')&&row.turns.length===1) {row.pendingId='question:'+params.threadId;saveFixture(saved);emit({id:row.pendingId,method:'item/tool/requestUserInput',params:{threadId:params.threadId,turnId:row.turns.at(-1).id,questions:[{id:'q',question:'2+2?',options:[]}]}});}
        if (row.model === 'fixture-dispatch-uncertain') return process.exit(0);
        return emit({id,result:{turn:row.turns.at(-1)}});
      }
      if (method === 'turn/steer') { row.turns.at(-1).input.push(...params.input);saveFixture(saved);return emit({id,result:{turnId:row.turns.at(-1).id}}); }
      if (method === 'turn/interrupt') { if(row.turns.at(-1)?.id!==params.turnId)return emit({id,error:{code:-32600,message:'stale turn'}}); row.turns.at(-1).status='interrupted';saveFixture(saved);return emit({id,result:{}}); }
      if (method === 'fixture/finish-turn') { row.turns.at(-1).status=params.status||'completed';saveFixture(saved);return emit({id,result:{}}); }
      if (method === 'fixture/finish-with-pending') {
        row.turns.at(-1).status='completed';saveFixture(saved);
        emit({method:'turn/completed',params:{threadId:params.threadId,turn:row.turns.at(-1)}});
        return emit({id,result:{}});
      }
      if (method === 'fixture/update-turn') {
        Object.assign(row.turns.find(turn=>turn.id===params.turnId),params.patch);
        saveFixture(saved);return emit({id,result:{}});
      }
      if (method === 'thread/turns/list') {
        const rows = [...row.turns];
        if(params.sortDirection === 'desc') rows.reverse();
        const offset = Number(params.cursor || 0);
        return emit({id,result:{data:rows.slice(offset,offset+1),nextCursor:offset+1<rows.length?String(offset+1):null}});
      }
      if (method === 'thread/archive') {
        if(row.model.includes('archive-busy')) return emit({id,error:{code:-32600,message:'thread '+params.threadId+' already has an active writer'}});
        row.archived=true;saveFixture(saved);
        return emit({id,result:{}});
      }
    }
    if(params?.threadId==='review-outcomes') {
      const items=[
        {type:'agentMessage',phase:'commentary',text:'Working'},
        {type:'fileChange',status:'completed',changes:[{path:'src/example.rs',kind:{type:'update'},diff:'--- a/src/example.rs\\n+++ b/src/example.rs\\n@@ -1 +1 @@\\n-old\\n+new'}]},
        {type:'fileChange',status:'completed',changes:[{path:'src/example.rs',kind:{type:'update'},diff:'@@ -1 +1,3 @@\\n unchanged\\n+one\\n+two'}]},
        {type:'fileChange',status:'failed',changes:[{path:'rejected.rs',diff:'@@ -0,0 +1 @@\\n+no'}]},
        {type:'commandExecution',command:'cat README.md',exitCode:0,status:'completed',aggregatedOutput:'PRIVATE_COMMAND_OUTPUT'.repeat(100)},
        {type:'commandExecution',command:'npm run check',commandActions:[{type:'unknown',command:"npm run check && node --test --test-name-pattern='review|full' checks.test.ts > check.log 2>&1"}],exitCode:1,status:'completed',aggregatedOutput:'PRIVATE_COMMAND_OUTPUT'.repeat(100)+'\\ntest result: FAILED. 2 passed; 1 failed; 0 ignored\\n'},
        {type:'commandExecution',command:'cargo check',commandActions:[{type:'unknown',command:"cat <<'EOF'\\nnpm test --not-executed\\nEOF\\ncargo check"}],exitCode:0,status:'completed',aggregatedOutput:''},
        {type:'agentMessage',phase:'final_answer',text:'Complete final response. '.repeat(100)},
        {type:'agentMessage',phase:'commentary',text:'After final commentary'}
      ];
      if(method==='thread/read')return emit({id,result:{thread:{id:params.threadId,cwd:'/fixture',status:{type:'idle'}}}});
      if(method==='thread/turns/list')return emit({id,result:{data:[{id:'review-turn',status:'completed',items}],nextCursor:'history-cursor'}});
    }
    if (params?.threadId === 'response-size') {
      const thread={id:'response-size',name:'Response size fixture',cwd:'/fixture/response-size',status:{type:'idle'},model:'fixture-model'};
      const items=[{id:'user',type:'userMessage',content:[{type:'text',text:'Inspect this change and explain the result. '.repeat(3)}]},...Array.from({length:8},(_,i)=>({id:'reason-'+i,type:'reasoning',summary:[],content:[]})),{id:'command',type:'commandExecution',command:'git diff --stat',exitCode:0,aggregatedOutput:' src/example.rs | 4 ++--\\n'.repeat(12),status:'completed'},{id:'change',type:'fileChange',status:'completed',changes:[{path:'src/example.rs',kind:{type:'update'},diff:'@@ -1 +1 @@\\n-old\\n+new'}]},{id:'agent',type:'agentMessage',text:'The change is complete and the checks passed. '.repeat(9)+(sizeRevision?'Changed':'')}];
      const turns=Array.from({length:6},(_,i)=>({id:'size-turn-'+i,status:'completed',items}));
      if(method==='thread/read')return emit({id,result:{thread}});
      if(method==='thread/turns/list') {
        const rows=params.sortDirection==='desc'?[...turns].reverse():turns;
        const offset=Number(params.cursor||0),end=offset+(params.limit||6);
        return emit({id,result:{data:rows.slice(offset,end),nextCursor:end<rows.length?String(end):null}});
      }
      if(method==='thread/items/list') {
        if ('knownItemKeys' in params || 'includeItemKeys' in params) return emit({id,error:{message:'ARC parameters leaked'}});
        const rows=params.sortDirection==='desc'?[...items].reverse():items;
        const offset=Number(params.cursor||0),end=offset+(params.limit||1);
        return emit({id,result:{data:rows.slice(offset,end).map(item=>({turnId:params.turnId||'size-turn-0',item})),nextCursor:end<rows.length?String(end):null}});
      }
    }
    if (params?.threadId === 'image-pagination' || params?.threadId === 'empty-images') {
      if (method === 'thread/turns/list') return emit({id,result:{data:params.threadId === 'empty-images' ? [] : [{id:'turn-latest',items:[]}],nextCursor:null}});
      if (method === 'thread/items/list') {
        if ('view' in params || 'latest' in params || 'includeImages' in params || 'maxImages' in params) return emit({id,error:{message:'connector parameters leaked'}});
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
    if (method === 'project/list' && existsSync(process.env.ARC_FIXTURE_DATA+'/projects-fixture.json')) return emit({id,result:{data:JSON.parse(readFileSync(process.env.ARC_FIXTURE_DATA+'/projects-fixture.json','utf8')),nextCursor:null}});
    if (method === 'model/list' || method === 'thread/list' || method === 'project/list') return emit({ id, result: { data: [], nextCursor: null } });
    if (method === 'command/exec' && params.command?.at(-1)==='fixture-failed-command') return emit({id,result:{stdout:'',stderr:'failed check',exitCode:7}});
    if (method === 'command/exec' && params.command?.at(-1)==='fixture-budget') return emit({id,result:{stdout:'é'.repeat(40),stderr:'err'.repeat(20),exitCode:0}});
    if (method === 'command/exec' && params.command?.at(-1)==='fixture-cwd') return emit({id,result:{stdout:params.cwd,stderr:'',exitCode:0}});
    if (method === 'command/exec' && params.command?.at(-1)==='fixture-origin') return emit({id,result:{stdout:JSON.stringify(params.env),stderr:'',exitCode:0}});
    if (method === 'process/spawn') {
      emit({ method: 'process/outputDelta', params: { processHandle: params.processHandle, stream: 'stdout', deltaBase64: 'b2s=' } });
      emit({ method: 'process/exited', params: { processHandle: params.processHandle, exitCode: 0 } });
    }
    if (method === 'fs/watch') emit({ method: 'fs/changed', params: { watchId: params.watchId, paths: [params.path] } });
    emit({ id, result: { method, params, echoedParams: params } });
  };
  if (method==='command/exec' && params.command?.at(-1)==='fixture-delayed') setTimeout(() => params.timeoutMs === 2000 ? reply() : emit({id,error:{code:-32602,message:'process timeout changed'}}),100);
  else if (params?.delay) setTimeout(reply, params.delay); else reply();
}
`);
  const acpFixture = path.join(directory, 'tracking-acp.mjs');
  await writeFile(acpFixture, `
import { createInterface } from 'node:readline';
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
const update = value => emit({jsonrpc:'2.0',method:'session/update',params:{sessionId:'example-session',update:value}});
let promptId;
for await (const line of createInterface({input:process.stdin})) {
  const r=JSON.parse(line);
  if(r.method==='initialize')emit({jsonrpc:'2.0',id:r.id,result:{protocolVersion:1,agentCapabilities:{}}});
  else if(r.method==='session/new')emit({jsonrpc:'2.0',id:r.id,result:{sessionId:'example-session'}});
  else if(r.method==='session/prompt') {
    promptId=r.id;
    const prompt=r.params.prompt.map(item=>item.text??'').join('');
    if(prompt.startsWith('fixture-final-text:')) {
      const text=Array.from(prompt.slice('fixture-final-text:'.length));
      for(let offset=0;offset<text.length;offset+=8192) update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:text.slice(offset,offset+8192).join('')}});
      emit({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}});
      continue;
    }
    update({sessionUpdate:'tool_call',toolCallId:'example-command',title:'Bash',kind:'other',status:'in_progress',rawInput:{command:'printf example',api_key:'fixture-secret-value'}});
    emit({jsonrpc:'2.0',id:'example-permission',method:'session/request_permission',params:{toolCall:{toolCallId:'example-command'},options:[{optionId:'allow',kind:'allow_once',name:'Allow'}]}});
  } else if(r.id==='example-permission') {
    update({sessionUpdate:'tool_call_update',toolCallId:'example-command',status:'completed',rawOutput:{exitCode:0},content:[{type:'content',content:{type:'text',text:'example'}}]});
    update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'All '}});
    update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'done'}});
    emit({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}});
  }
}
`);
  await mkdir(path.join(stateDir,'agents'),{recursive:true});
  await writeFile(path.join(stateDir,'agents/manifests.json'),JSON.stringify([{id:'tracking-example',command:process.execPath,args:[acpFixture],versionArgs:[],protocol:'acp-v1'}]));
  for (const name of ['fixtures', 'dependencies']) {
    await mkdir(path.join(directory, name), { recursive: true });
    await symlink(path.join(directory, name), path.join(stateDir, name), process.platform === 'win32' ? 'junction' : 'dir');
  }
  const target = process.env.CARGO_TARGET_DIR || fileURLToPath(new URL('../target', import.meta.url));
  execFileSync('cargo', ['build', '--locked', '--quiet', '-p', 'contract-fixture', '--target-dir', target], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit',
  });
  fixtureCommand=path.join(target, 'debug', 'contract-fixture' + (process.platform === 'win32' ? '.exe' : ''));
  fixtureEnv={ ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, ARC_STATE_DIR: stateDir, ARC_FIXTURE_DATA: directory, ARC_FIXTURE_SCRIPT: fixture, ARC_FIXTURE_BINARY: process.execPath } as Record<string,string>;
  await connectFixture();
  await management('task-settings', 'PUT', {autoOpenCodex:false});
  inventory = await client.listTools();
  const index = ((await client.callTool({name:'query',arguments:{op:'guide',args:{view:'full'}}})).structuredContent as {result:any}).result.ops;
  operations = await Promise.all(index.map(async ({op}: {op: string}) => {
    const detail = (await call('guide', {op})).result;
    return {...catalog.ops.find((item: any) => item.name === op), inputSchema: detail.inputSchema, description: detail.description};
  }));
});
after(async () => { await client?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

function opCall(name: string, args: Record<string, unknown> = {}) {
  if (name === 'guide') return { name, arguments: args };
  if (['codex_create','codex_send','agent_create','agent_send'].includes(name)) args = {purpose:'self-test', ...args};
  const spec = catalog.ops.find((op: any) => op.name === name);
  const via = spec.annotations.readOnlyHint ? 'query' : 'act';
  const {requestId, ...rest} = args;
  return {name: via, arguments: {op: name, args: via === 'act' && requestId !== undefined ? rest : args, ...(via === 'act' && requestId !== undefined ? {requestId} : {})}};
}
async function call(name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool(opCall(name, args));
  assertNextCalls(response.structuredContent);
  return { response, result: (response.structuredContent as { result: any } | undefined)?.result };
}
async function completed(name: string, args: Record<string, unknown>) {
  let { result } = await call(name, args);
  const deadline = Date.now() + 15000;
  while (['pending', 'reserved', 'executing', 'submitting', 'thread-submitting', 'thread-created', 'turn-submitting'].includes(result.state)) {
    assert.ok(Date.now() < deadline, 'receipt completed before deadline');
    await new Promise(resolve => setTimeout(resolve, 20));
    result = (await call('receipt', { requestId: args.requestId })).result;
  }
  return result;
}

test('MCP lists frozen tools and guide exposes existing ops and native domains with valid object schemas', async () => {
  // Contract: MCP lists frozen tools and guide exposes existing ops and native domains with valid object schemas.
  assert.deepEqual(inventory.tools.map(tool => tool.name), ['guide', 'query', 'act']);
  const status = await call('notify_status');
  assert.equal(status.response.isError, false);
  assert.equal(status.result.arcInbox, undefined);
  for (const row of (await call('guide', {topic:'review'})).result.ops) assert.match(row.signature, new RegExp('^'+row.op+'\\('));
  for (const tool of operations) {
    assert.equal(tool.inputSchema.type, 'object');
    new AjvJsonSchemaValidator().getValidator(tool.inputSchema);
  }
  const waitSchema = operations.find(tool => tool.name === 'codex_wait')!.inputSchema;
  assert.equal((waitSchema.properties!.timeoutMs as { maximum: number }).maximum, 1800000);
  const validateWait = new AjvJsonSchemaValidator().getValidator(waitSchema);
  assert.equal(validateWait({ threadId: 'fixture', timeoutMs: 1800000 }).valid, true);
  for (const timeoutMs of [1800001, 1830000]) {
    assert.equal(validateWait({ threadId: 'fixture', timeoutMs }).valid, false);
    const rejected = await call('codex_wait', { threadId: 'fixture', timeoutMs });
    assert.equal(rejected.response.isError, true);
  }
  const inboxSchema = operations.find(tool => tool.name === 'inbox_wait')!.inputSchema;
  const validateInbox = new AjvJsonSchemaValidator().getValidator(inboxSchema);
  assert.equal(validateInbox({timeoutMs:1800000}).valid,true);
  for(const timeoutMs of [-1,1800001])assert.equal(validateInbox({timeoutMs}).valid,false);
  const immediateInbox=await call('inbox_wait',{timeoutMs:0});
  assert.equal(immediateInbox.response.isError,false);
  assert.ok(['events','timeout'].includes(immediateInbox.result.state));
  const agentWaitSchema = operations.find(tool => tool.name === 'agent_wait')!.inputSchema;
  const validateAgentWait = new AjvJsonSchemaValidator().getValidator(agentWaitSchema);
  assert.equal(validateAgentWait({agent:'tracking-example',taskId:'fixture',timeoutMs:1800000}).valid,true);
  assert.equal(validateAgentWait({agent:'tracking-example',taskId:'fixture',timeoutMs:1800001}).valid,false);
  for (const name of ['read', 'codex_read', 'codex_items']) {
    const exposed = operations.find(tool => tool.name === name)!;
    const params = name === 'read' ? ['maxEdge', 'quality'] : ['includeImages', 'maxImages'];
    for (const key of params) assert.ok(exposed.inputSchema.properties?.[key]);
  }
  assert.ok(operations.find(tool => tool.name === 'codex_items')!.inputSchema.properties?.latest);
  const agents = (await management('agents')).agents;
  assert.ok(agents.some((agent: {agent: string}) => agent.agent === 'codex'));
  assert.equal(agents.find((agent: {agent: string}) => agent.agent === 'tracking-example').integration, 'custom');
  for (const agent of agents.filter((agent: { protocol: string }) => agent.protocol === 'acp-v1')) {
    assert.equal(agent.descriptor.protocol, 'acp-v1');
    if (agent.agent==='tracking-example') assert.equal(agent.integration,'custom');
    else assert.ok(['native', 'adapter'].includes(agent.integration));
  }
  const gitWrite = operations.find(tool => tool.name === 'git_write')!;
  assert.equal(gitWrite.annotations?.readOnlyHint, false);
  assert.equal(operations.find(tool => tool.name === 'git')!.annotations?.readOnlyHint, true);
  assert.deepEqual(catalog.toolExposure.tools.git_write.presets, []);
  assert.deepEqual(catalog.toolExposure.tools.git_write.requires, ['control_output', 'receipt']);
  const command = operations.find(tool => tool.name === 'command')!;
  assert.ok(!command.inputSchema.required?.includes('requestId'));
  assert.equal(operations.find(tool => tool.name === 'codex_account')!.annotations?.readOnlyHint, true);
  assert.equal((await call('fs', { action: 'writeFile', params: {} })).result.state, 'completed');
  assert.equal((await call('fs', { action: 'readFile', params: {} })).response.isError, true);
  assert.equal((await call('fs', { action: 'exec', params: {} })).response.isError, true);
});

function assertNativeInputPreserved(actual: any, expected: Record<string, unknown>) {
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'env' && value && typeof value === 'object') {
      for (const [variable, setting] of Object.entries(value)) assert.deepEqual(actual.env[variable], setting);
    } else assert.deepEqual(actual[key], value);
  }
}

test('native pass-through domain actions preserve RPC payloads', async () => {
  // Contract: native pass-through actions preserve their observable RPC method and caller-supplied fields.
  const expected: Record<string, Record<string, string>> = {
    fs: Object.fromEntries(['writeFile', 'createDirectory', 'remove', 'copy', 'watch', 'unwatch'].map(action => [action, `fs/${action}`])),
    command: { exec: 'command/exec', write: 'command/exec/write', terminate: 'command/exec/terminate', resize: 'command/exec/resize' },
    process: { spawn: 'process/spawn', writeStdin: 'process/writeStdin', kill: 'process/kill', resizePty: 'process/resizePty' },
    mcp: { list: 'mcpServerStatus/list', 'resource/read': 'mcpServer/resource/read', 'tool/call': 'mcpServer/tool/call', 'oauth/login': 'mcpServer/oauth/login', 'event/stream/start': 'mcpServer/event/stream/start', 'event/stream/stop': 'mcpServer/event/stream/stop' },
    codex_thread: { search: 'thread/search', fork: 'thread/fork', 'name/set': 'thread/name/set', archive: 'thread/archive', unarchive: 'thread/unarchive', compact: 'thread/compact/start', rollback: 'thread/rollback', revert: 'thread/revert', 'backgroundTerminals/list': 'thread/backgroundTerminals/list', 'backgroundTerminals/clean': 'thread/backgroundTerminals/clean', 'backgroundTerminals/terminate': 'thread/backgroundTerminals/terminate', timeline: 'thread/timeline/list' },
    codex_account: { read: 'account/read', 'usage/read': 'account/usage/read', 'rateLimits/read': 'account/rateLimits/read', 'workspaceMessages/read': 'account/workspaceMessages/read' },
  };
  for (const [domain, actions] of Object.entries(expected)) {
    for (const [action, method] of Object.entries(actions)) {
      const params = { nativeFutureField: { falseValue: false, zero: 0, empty: '', nullable: null, array: [1, null] } };
      const value = await completed(domain, { action, params, requestId: randomUUID() });
      const result = value.state ? value.result : value;
      assert.equal(result.method, method);
      assertNativeInputPreserved(value.state ? result.echoedParams : result.params, params);
    }
  }
});

test('typical fs, PTY, downstream MCP and file search calls preserve native fields and events without creating threads', async () => {
  // Contract: typical fs, PTY, downstream MCP and file search calls preserve native fields and events without creating threads.
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['fs', 'writeFile', { path: '/tmp/native.txt', dataBase64: 'aGk=' }],
    ['fs', 'watch', { path: '/tmp/native.txt', watchId: 'watch-test' }],
    ['command', 'exec', { command: ['cat'], cwd: '/tmp', env: { LANG: null, EXAMPLE: 'yes' }, timeoutMs: 0, tty: true, size: { rows: 24, cols: 80 }, processId: 'command-test', streamStdin: true, streamStdoutStderr: true, sandboxPolicy: { type: 'readOnly' }, disableOutputCap: true }],
    ['process', 'spawn', { command: ['cat'], cwd: '/tmp', processHandle: 'process-test', timeoutMs: null, outputBytesCap: null, tty: true }],
    ['mcp', 'tool/call', { server: 'local', threadId: 'existing-thread', tool: 'inspect', arguments: { input: [1, 2] }, _meta: { progressToken: 7 } }],
  ];
  for (const [name, action, params] of cases) assertNativeInputPreserved((await completed(name, { action, params, requestId: randomUUID() })).result.echoedParams, params);
  const params = { query: 'ctrlmcp', roots: ['/tmp'], cancellationToken: null };
  assert.deepEqual((await call('file_search', params)).result.params, params);
  assert.equal((await call('codex_account', { action: 'workspaceMessages/read' })).result.params, null);
  const events = (await call('codex_events')).result.events;
  assert.ok(events.some((event: any) => event.method === 'fs/changed' && event.params.watchId === 'watch-test'));
  assert.ok(events.some((event: any) => event.method === 'process/exited' && event.params.processHandle === 'process-test'));

});

test('mutation receipts remain idempotent across domain and escape hatch, including pending and conflicting retries', async () => {
  // Contract: mutation receipts remain idempotent across domain and escape hatch, including pending and conflicting retries.
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
  // Contract: native errors retain code/message/data for both direct reads and mutation receipts; raw null/array results survive.
  const rpcError = { code: -32042, message: 'native fixture rejection', data: { retryable: false, detail: 'bad argument' } };
  const read = await call('codex_query', { method: 'project/list', params: { fail: 'bad argument' } });
  assert.equal(read.response.isError, true);
  assert.equal(read.result.error.message, rpcError.message);
  assert.deepEqual(read.result.error.rpcError, {code:rpcError.code,data:rpcError.data});
  const write = await completed('process', { action: 'spawn', params: { fail: 'bad argument' }, requestId: randomUUID() });
  assert.equal(write.state, 'rejected');
  assert.equal(write.error.message, rpcError.message);
  assert.deepEqual(write.error.rpcError, {code:rpcError.code,data:rpcError.data});
  assert.equal((await completed('codex_call', { method: 'fixture/null', params: null, requestId: randomUUID() })).result, null);
  assert.deepEqual((await completed('codex_call', { method: 'fixture/array', requestId: randomUUID() })).result, [null, 1, { native: true }]);
  assert.equal((await call('codex_tasks')).result.tasks.length, 0);
  assert.equal((await call('codex_capabilities')).result.version, version);
});

test('deployment fingerprints ignore tool/property ordering and runtime changes but detect every published definition change', async () => {
  // Property: canonical fingerprints ignore ordering and change with published definitions.
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

async function management(route: string, method = 'GET', body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/api/${route}`, {
    method, headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result;
}
test('setup clipboard preserves unrelated content on extraction failure and clears only after saving', async () => {
  // Regression: d983ff5; setup clipboard preserves unrelated content on extraction failure and clears only after saving.
  const clipboard = path.join(directory, 'fixtures/clipboard.txt');
  await mkdir(path.dirname(clipboard), { recursive: true });
  await management('setup/apply', 'POST', { stepId: 'choose-goal', input: { option: 'claude-loop' } });
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
    assert.equal((await management('ingress/setup-claude-loop')).config.hasCloudflareToken, true);
    assert.equal(await readFile(clipboard, 'utf8'), '');
  } finally {
    await management('ingress/setup-claude-loop', 'DELETE');
    await management('setup/reset', 'DELETE');
    await rm(clipboard, { force: true });
  }
});

async function ingressRpc(ingress: any, method: string, params?: any) {
  if (method === 'tools/call' && !['query','act'].includes(params.name)) params = opCall(params.name, params.arguments);
  const response = await fetch(`http://127.0.0.1:${ingress.config.httpsPort}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${`test-${ingress.id}`.padEnd(40, 'x')}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('setup rejects a short runtime key without saving or clearing; HTTPS fallback reuses the ingress', async () => {
  // Regression: 3f0c5ea; setup rejects a short runtime key without saving or clearing; HTTPS fallback reuses the ingress.
  const clipboard = path.join(directory, 'fixtures/clipboard.txt');
  await mkdir(path.dirname(clipboard), { recursive: true });
  await management('setup/apply', 'POST', { stepId: 'choose-goal', input: { option: 'chatgpt-chat' } });
  const apply = (stepId: string, input: object) => management('setup/apply', 'POST', { stepId, input });
  const poll = path.join(directory, 'poll-status.json');
  const tunnel = path.join(directory, 'tunnel-fixture');
  await writeFile(poll, '0');
  await writeFile(tunnel, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === '--version') { console.log('tunnel-client v0.0.16'); process.exit(0); }
if (process.argv[2] === 'init') process.exit(0);
if (process.argv[process.argv.indexOf('--mcp.connection-max-ttl') + 1] !== '31m') process.exit(42);
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
    await management('setup/reset', 'DELETE');
    await rm(clipboard, { force: true });
  }
});

test('tool presets use the full registry, preserve exact allowlists and close only necessary read dependencies', async () => {
  // Property: policy normalization preserves selected operations and closes only their required dependencies.
  const config: ToolCatalog = await management('tool-catalog');
  assert.deepEqual(config.tools.filter(tool => tool.available !== false).map(tool => tool.name), operations.map(tool => tool.name));
  assert.deepEqual(Object.keys(catalog.toolExposure.tools).sort(), config.tools.map(tool => tool.name).sort());
  for (const tool of config.tools) {
    assert.ok(config.groups.some(group => group.id === tool.group));
    for (const dependency of tool.requires) assert.ok(config.tools.some(tool => tool.name === dependency));
  }
  const readOnly = presetPolicy('readOnly', config) as { allowlist: string[] };
  const common = presetPolicy('common', config) as { allowlist: string[] };
  for (const forbidden of ['git_write', 'edit', 'write', 'receipt', 'fs', 'command', 'process', 'mcp', 'codex_call', 'codex_thread', 'codex_query', 'codex_account', 'codex_resume', ...['agent', 'codex'].flatMap(prefix => ['create', 'send', 'interrupt', 'respond'].map(action => `${prefix}_${action}`))]) {
    assert.ok(!readOnly.allowlist.includes(forbidden), forbidden);
  }
  assert.ok(!common.allowlist.includes('git_write'));
  assert.ok(common.allowlist.includes('codex_resume'));
  for (const name of ['codex_resume', 'codex_read', 'codex_wait', 'receipt', 'control_output']) assert.ok(normalizeSelection(['codex_resume'], config).includes(name));
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

test('update presets expose status to readers and scheduling only to common policies', async () => {
  // Regression: 03ec3af omitted update operations from exposure metadata, hiding them from default ingress policies.
  const config: ToolCatalog = await management('tool-catalog');
  const readOnly = presetPolicy('readOnly', config) as { allowlist: string[] };
  const common = presetPolicy('common', config) as { allowlist: string[] };
  assert.ok(readOnly.allowlist.includes('update_status'));
  assert.ok(!readOnly.allowlist.includes('update_request'));
  for (const name of ['update_status', 'update_request']) assert.ok(common.allowlist.includes(name));
  const selection = normalizeSelection(['update_request'], config);
  for (const name of ['update_request', 'update_status', 'control_output']) assert.ok(selection.includes(name));
});

test('real HTTP ingresses isolate discovery and direct execution; policy PUT preserves identity, metadata and peer availability', async () => {
  // Contract: ingress discovery and execution obey the authenticated source policy.
  const config: ToolCatalog = await management('tool-catalog');
  const a = await management('ingress', 'POST', { id: 'policy-all', name: 'Policy all', toolPolicy: 'all', controlSource: 'custom', transport: 'https', auth: 'bearer', bearerToken: 'test-policy-all'.padEnd(40, 'x'), config: { httpsProvider: 'custom', httpsUrl: 'https://policy-all.example/mcp' } });
  const b = await management('ingress', 'POST', { id: 'policy-read', name: 'Policy read', controlSource: 'custom', transport: 'https', auth: 'bearer', bearerToken: 'test-policy-read'.padEnd(40, 'x'), toolPolicy: presetPolicy('readOnly', config), config: { httpsProvider: 'custom', httpsUrl: 'https://policy-read.example/mcp' } });
  try {
    assert.equal(a.toolPolicy, 'all');
    await management(`ingress/${a.id}/start`, 'POST');
    await management(`ingress/${b.id}/start`, 'POST');
    const list = async (i: any) => (await ingressRpc(i, 'tools/call', {name:'query',arguments:{op:'guide',args:{view:'full'}}})).result.structuredContent.result.ops.map((op: any) => op.op);
    assert.deepEqual(await list(a), config.tools.filter(tool => tool.available !== false).map(tool => tool.name));
    assert.deepEqual(await list(b), config.tools.filter(tool => (b.toolPolicy.allowlist.includes(tool.name) || ['notification_ack', 'notify_status', 'inbox_wait'].includes(tool.name)) && tool.available !== false).map(tool => tool.name));
    assert.deepEqual((await management('tool-catalog')).tools, config.tools, 'management inventory remains unfiltered');
    for (const name of config.tools.filter(tool => !b.toolPolicy.allowlist.includes(tool.name) && !['notification_ack', 'notify_status', 'inbox_wait'].includes(tool.name)).map(tool => tool.name)) {
      assert.equal((await ingressRpc(b, 'tools/call', { name, arguments: { action: 'approve', requestId: randomUUID() } })).result.structuredContent.result.error.code, 'OP_UNAVAILABLE', name);
    }
    const source=(await management('source')).sources.find((source:any)=>source.ingressId===b.id);
    assert.ok(source.capabilityProfileOffer.choices.includes('remote-polling'));
    assert.equal(source.capabilityProfile,undefined);
    await management(`source/${source.id}`,'PUT',{capabilityProfile:{hostAccess:'none',waitMode:'poll'}});
    assert.deepEqual((await management(`ingress/${b.id}`)).toolPolicy,b.toolPolicy);
    assert.ok(!((await ingressRpc(b,'tools/call',{name:'query',arguments:{op:'guide',args:{}}})).result.structuredContent.result.ops).some((row:any)=>row.op==='command'));
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
    const identity = (await management(`ingress/${b.id}`)).verification;
    const verified = await ingressRpc(b, 'tools/call', { name: 'connector_verify', arguments: { code: identity.code } });
    assert.equal(verified.result.isError, false, JSON.stringify(verified));
    for (const policy of [presetPolicy('common', config), { allowlist: normalizeSelection(['agent_send'], config) }, 'all'] as ToolPolicy[]) {
      await management(`ingress/${b.id}/stop`, 'POST');
      const saved = await management(`ingress/${b.id}`, 'PUT', { toolPolicy: policy });
      assert.deepEqual(saved.toolPolicy, policy);
      assert.equal(saved.name, b.name);
      assert.equal(saved.controlSource, b.controlSource);
      assert.equal(saved.auth, b.auth);
      assert.deepEqual(saved.config, b.config);
      assert.equal((await management(`ingress/${b.id}`)).verification.code, identity.code);
      assert.deepEqual((await management(`ingress/${b.id}`)).toolPolicy, policy);
      await management(`ingress/${b.id}/start`, 'POST');
      assert.equal((await management(`ingress/${b.id}`)).verification.code, identity.code);
      assert.deepEqual(await list(b), config.tools.filter(tool => (policy === 'all' || policy.allowlist.includes(tool.name) || ['notification_ack', 'notify_status', 'inbox_wait'].includes(tool.name)) && tool.available !== false).map(tool => tool.name));
      assert.deepEqual(await list(a), config.tools.filter(tool => tool.available !== false).map(tool => tool.name), 'other ingress stays online and unchanged');
    }
    await management(`ingress/${b.id}/stop`, 'POST');
    await management(`ingress/${b.id}`, 'PUT', { toolPolicy: { allowlist: [] } });
    await management(`ingress/${b.id}/start`, 'POST');
    assert.deepEqual(await list(b), ['guide', 'inbox_wait', 'notification_ack', 'notify_status']);
    for (const name of ['connector_verify', 'codex_wait', 'agent_wait']) assert.equal((await ingressRpc(b, 'tools/call', { name, arguments: {} })).result.structuredContent.result.error.code, 'OP_UNAVAILABLE');
  } finally {
    await management(`ingress/${a.id}`, 'DELETE');
    await management(`ingress/${b.id}`, 'DELETE');
  }
});

// Simulate only the tunnel provider's loopback readiness API; ingress commit and
// persistence still run through the compiled production Service implementation.
test('managed draft commits the selected policy instead of publishing all tools', { skip: process.platform !== 'darwin' }, async () => {
  // Regression: a committed restricted draft must not expose unselected operations.
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
    } finally {
      await management(`${committed ? 'ingress' : 'ingress-drafts'}/${draft.id}`, 'DELETE');
    }
  }
});


test('Git writes use durable receipts, isolated identity and safe local workflows', async () => {
  // Regression: invalid or escaping Git paths are rejected without modifying the worktree.
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
  assert.match(missingIdentity.error.message, /configure user.email/);
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
  assert.match(blockedMerge.error.message, /external merge drivers/);
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
  // Contract: latest items pin the newest turn and preserve explicit turn and native cursor semantics.
  const threadId = 'image-pagination';
  const old = (await call('codex_items', {threadId,view:'full'})).result;
  assert.equal(old.items[0].itemId, 'old-first');
  assert.equal(old.turnId, undefined);
  const first = (await call('codex_items', {threadId, view:'full', latest:true})).result;
  assert.equal(first.turnId, 'turn-latest');
  assert.equal(first.items[0].itemId, 'latest-last');
  assert.ok(first.nextCursor);
  const next = (await call('codex_items', {threadId, view:'full', latest:true, turnId:first.turnId, cursor:first.nextCursor})).result;
  assert.equal(next.items[0].itemId, 'latest-first');
  assert.equal(next.nextCursor, null);
  const explicit = (await call('codex_items', {threadId, view:'full', latest:true, turnId:'turn-old'})).result;
  assert.equal(explicit.items[0].itemId, 'old-first');
  const legacyNext = (await call('codex_items', {threadId, view:'full', cursor:old.nextCursor})).result;
  assert.equal(legacyNext.items[0].itemId, 'latest-first');
  assert.equal((await call('codex_items', {threadId,latest:true,cursor:first.nextCursor})).response.isError, true);
  const empty = (await call('codex_items', {threadId:'empty-images',latest:true})).result;
  assert.deepEqual(empty.items, []);
  assert.equal(empty.nextCursor, null);
  assert.equal(empty.turnId, null);
});

test('creation starts its first turn without legacy history reads, cleans definite failures and retains uncertain submissions', async () => {
  // Regression: 3abadc6; creation starts its first turn without legacy history reads, cleans definite failures and retains uncertain submissions.
  const create = async (model: string) => completed('codex_create', {
    project: directory, prompt: 'ping', thread: { model }, requestId: randomUUID(), waitMs: 1000,
  });
  // Only this isolated fixture owns these settings; never change the installed app.
  const settingsBefore = await management('task-settings');
  try {
    await management('task-settings', 'PUT', {autoOpenCodex:false});
    const fresh = await create('fixture-dispatch-unmaterialized');
    assert.equal(fresh.state, 'completed', JSON.stringify(fresh));
    assert.equal(fresh.executionOwner, 'connector');
    let rows = JSON.parse(await readFile(path.join(directory, 'dispatch-fixture.json'), 'utf8'));
    assert.equal(rows[fresh.threadId].turns.length, 1);
    const rejected = await create('fixture-dispatch-unmaterialized-reject');
    assert.equal(rejected.failureStage, 'turn-submitting');
    assert.deepEqual(rejected.cleanup, {archived:false,reason:'thread-not-materialized'});
    rows = JSON.parse(await readFile(path.join(directory, 'dispatch-fixture.json'), 'utf8'));
    assert.equal(rows[rejected.threadId].turns.length, 0);
  } finally {
    await management('task-settings', 'PUT', settingsBefore);
  }
  const accepted = await create('fixture-dispatch');
  const sent = await completed('codex_send', {threadId: accepted.threadId,
    input: [{type:'text', text:'original input', text_elements:[]}], context:true, intent:'ignored', requestId:randomUUID()});
  assert.equal(sent.state, 'completed');
  const rows = await fixtureRows();
  assert.deepEqual(rows[accepted.threadId].turns[0].input, [{type:'text', text:'ping', text_elements:[]}]);
  assert.deepEqual(rows[accepted.threadId].turns[1].input, [{type:'text', text:'original input', text_elements:[]}]);
  assert.equal(accepted.state, 'completed');
  assert.ok(accepted.threadId && accepted.turnId);
  // Exercise the real background waiter against paginated history, including
  // a requested older turn on the second page.
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
  assert.equal(saved[accepted.threadId].turns.length, 3);
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
  await management('task-settings','PUT',{autoOpenCodex:false,codexRetryMaxAttempts:3,codexRetryInitialSeconds:1});
  const r=await completed('codex_create',{project:directory,prompt:'harmless fixture',thread:{model},purpose:'self-test',requestId:randomUUID(),waitMs:1000});assert.equal(r.state,'completed');return r;
}
const fixtureRows = async () => JSON.parse(await readFile(path.join(directory,'dispatch-fixture.json'),'utf8'));

test('guide exposes replay boundaries and durable writes survive concurrent retries and Core restart', async () => {
  // Regression: a lost write response must not cause a repeated edit after concurrent retry or restart.
  const guide = ((await client.callTool({name:'query',arguments:{op:'guide',args:{view:'full'}}})).structuredContent as {result:any}).result;
  assert.ok(guide.ops.every((op:any) => ['read-only','receipt','original-receipt','read-back'].includes(op.retry.mode)));
  assert.equal((await call('guide',{op:'edit'})).result.retry.mode,'receipt');
  assert.equal((await call('guide',{op:'screen'})).result.retry.automaticRetry,false);
  assert.equal((await call('guide',{op:'receipt'})).result.retry.mode,'original-receipt');
  const file = path.join(directory, 'retry-edit.txt');
  await writeFile(file, 'a');
  const requestId = randomUUID();
  const args = {path:file,edits:[{oldText:'a',newText:'aa'}],requestId};
  const results = await Promise.all([completed('edit',args),completed('edit',args)]);
  assert.ok(results.every(result => result.state === 'completed' && result.requestId === requestId));
  assert.equal(await readFile(file,'utf8'),'aa');
  // An independent writer changes the file after ARC's original operation.
  await writeFile(file,'external change');
  await client.close(); await connectFixture();
  assert.equal((await completed('edit',args)).state,'completed');
  assert.equal(await readFile(file,'utf8'),'external change');
  const conflict = await call('edit',{...args,edits:[{oldText:'external change',newText:'overwritten'}]});
  assert.equal(conflict.result.error.code,'REQUEST_ID_CONFLICT');
  assert.equal(await readFile(file,'utf8'),'external change');
});

test('HTTP ingress observations correlate failures and dropped streams without retaining content or credentials', async () => {
  // Regression: ingress failures before dispatch and disconnected waits were absent from control-call metrics.
  const id = 'observed-http';
  const token = `test-${id}`.padEnd(40,'x');
  const ingress = await management('ingress','POST',{id,name:'Observed HTTP',controlSource:'custom',transport:'https',auth:'bearer',bearerToken:token,toolPolicy:'all',config:{httpsProvider:'custom',httpsUrl:'https://observed.example/mcp'}});
  await management(`ingress/${id}/start`,'POST');
  const port = ingress.config.httpsPort;
  const url = `http://127.0.0.1:${port}/mcp`;
  const ray = '0123456789abcdef-TEST';
  try {
    const unauthorized = await fetch(url,{headers:{'CF-Ray':ray}});
    assert.equal(unauthorized.status,401); await unauthorized.text();
    const invalid = await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','CF-Ray':ray},body:'PRIVATE_BODY_CONTENT'});
    assert.equal(invalid.status,400); await invalid.text();
    const ignoredRay = 'fedcba9876543210-TEST';
    const ignoredFile = path.join(directory,'ignored-http-notification.txt');
    const ignored = await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','CF-Ray':ignoredRay},body:JSON.stringify({jsonrpc:'2.0',method:'tools/call',params:{name:'act',arguments:{op:'write',args:{path:ignoredFile,content:'PRIVATE_IGNORED_CONTENT'}}}})});
    assert.equal(ignored.status,202); await ignored.text();
    await assert.rejects(()=>readFile(ignoredFile));
    const timed = await new Promise<string>((resolve,reject) => {
      const socket = createConnection({host:'127.0.0.1',port},() => socket.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${token}\r\nAccept: application/json\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`));
      let response = '';
      socket.setTimeout(20000,() => { socket.destroy(); reject(new Error('Body timeout response missing')); });
      socket.on('data',data => response += data.toString());
      socket.on('end',() => resolve(response)); socket.on('error',reject);
    });
    assert.ok(timed.startsWith('HTTP/1.1 408'));
    const requestId = randomUUID();
    const rpc = {jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name:'act',arguments:{op:'edit',requestId,args:{path:path.join(directory,'missing-observed.txt'),edits:[{oldText:'PRIVATE_ARGUMENT_CONTENT',newText:'x'}]}}}};
    const mutation = await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','CF-Ray':ray},body:JSON.stringify(rpc)});
    await mutation.json();
    const abort = new AbortController();
    const waiting = await fetch(url,{method:'POST',signal:abort.signal,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream','CF-Ray':ray},body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name:'query',arguments:{op:'inbox_wait',args:{timeoutMs:1800000,threadIds:['PRIVATE_WAIT_TARGET']}}}})});
    await waiting.body!.getReader().read(); abort.abort();
    const read = async () => (await call('logs',{ingressId:id,grep:'Ingress',limit:2000})).result.rows.filter((r:any)=>r.ingressId===id);
    const rows:any[] = await eventually(read,rows=>rows.some((r:any)=>r.event==='response_dropped'));
    assert.ok(rows.some(row=>row.event==='response_finished' && row.httpStatus===401 && row.cfRay===ray));
    assert.ok(rows.some(row=>row.event==='response_finished' && row.httpStatus===408));
    assert.ok(rows.some(row=>row.event==='request_dispatch' && row.op==='edit' && row.requestId===requestId));
    assert.ok(rows.some(row=>row.event==='response_dropped' && row.op==='inbox_wait' && row.durationMs>=0));
    assert.equal(rows.some(row=>row.event==='request_dispatch' && row.cfRay===ignoredRay),false);
    const finished = rows.find(row=>row.event==='response_finished' && row.httpStatus===401);
    assert.ok(rows.some(row=>row.event==='request_received' && row.traceId===finished.traceId && row.connectionId===finished.connectionId));
    const correlated = (await call('logs',{ingressId:id,traceId:finished.traceId,limit:20})).result.rows;
    assert.ok(correlated.every((row:any)=>row.traceId===finished.traceId && row.ingressId===id));
    assert.ok(correlated.some((row:any)=>row.event==='request_received') && correlated.some((row:any)=>row.event==='response_finished'));
    const serialized = JSON.stringify(rows);
    for(const secret of [token,'PRIVATE_BODY_CONTENT','PRIVATE_ARGUMENT_CONTENT','PRIVATE_WAIT_TARGET','PRIVATE_IGNORED_CONTENT']) assert.equal(serialized.includes(secret),false);
    const status = await management(`ingress/${id}`);
    assert.equal(status.requests.inFlight,0);
    assert.equal(status.requests.bodyTimeouts,1);
    assert.ok(status.requests.responseDropped>=1);
  } finally { await management(`ingress/${id}`,'DELETE'); }
});

test('managed Cloudflare recovers an exited provider without status polling and stops supervision on disconnect', {skip:process.platform==='win32'}, async () => {
  // Regression: managed provider recovery depended on UI or status reads and stopped in unattended Core sessions.
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const dependency = path.join(directory,'dependencies/cloudflare',`${platform}-${process.arch==='arm64'?'arm64':'amd64'}`);
  await mkdir(dependency,{recursive:true});
  const readyAddress = path.join(directory,'provider-ready-address.txt');
  const script = `#!${process.execPath}
const http = require('node:http'), fs = require('node:fs');
const endpoint = process.argv[process.argv.indexOf('--metrics')+1];
if(process.argv[process.argv.indexOf('--protocol')+1]!=='http2')process.exit(42);
const server = http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({readyConnections:2}));});
server.listen(Number(endpoint.split(':')[1]),'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(readyAddress)},'http://'+endpoint+'/ready'));
`;
  await writeFile(path.join(dependency,'cloudflared'),script); await chmod(path.join(dependency,'cloudflared'),0o700);
  await writeFile(path.join(dependency,'installed.json'),JSON.stringify({sha256:createHash('sha256').update(script).digest('hex')}));
  const id = 'supervised-cloudflare';
  await management('ingress','POST',{id,name:'Supervised Cloudflare',controlSource:'claude',transport:'https',auth:'bearer',bearerToken:`test-${id}`.padEnd(40,'x'),toolPolicy:'all',config:{httpsProvider:'cloudflare',cloudflareMode:'named',cloudflareAuth:'token',cloudflareToken:'fixture-cloudflare-token',httpsUrl:'https://supervised.example/mcp',proxyMode:'direct'}});
  try {
    await management(`ingress/${id}/start`,'POST');
    const initial = await management(`ingress/${id}`);
    assert.equal(initial.state,'ready');
    const ready = await readFile(readyAddress,'utf8');
    process.kill(initial.health.pid,'SIGKILL');
    // Poll only the provider's own loopback endpoint. ARC receives no reads during recovery.
    await eventually(async()=>{try{return (await fetch(ready)).status;}catch{return 0;}},code=>code===200,80000);
    const recovered = await eventually(()=>management(`ingress/${id}`),row=>row.health?.state==='ready' && row.health?.pid!==initial.health.pid);
    assert.equal(recovered.health.restartCount,1);
    assert.equal(recovered.health.readyConnections,2);
    assert.ok(recovered.health.recoveredAt);
    assert.equal(recovered.tunnelError,'');
    assert.ok(recovered.lastTunnelErrorAt);
    const rows = (await call('logs',{ingressId:id,grep:'Ingress provider',limit:2000})).result.rows.filter((r:any)=>r.ingressId===id);
    assert.ok(rows.some((row:any)=>row.event==='provider_restart'));
    assert.ok(recovered.health.lastDowntimeMs >= rows.find((row:any)=>row.event==='provider_restart').downtimeMs);
    assert.ok(rows.some((row:any)=>row.event==='provider_health' && row.state==='degraded'));
    assert.ok(rows.some((row:any)=>row.event==='provider_health' && row.previousState==='degraded' && row.state==='ready'));
    await management(`ingress/${id}/stop`,'POST');
    await new Promise(resolve=>setTimeout(resolve,2500));
    assert.equal((await management(`ingress/${id}`)).state,'stopped');
    await assert.rejects(()=>fetch(ready));
  } finally { await management(`ingress/${id}`,'DELETE'); }
});

test('replacement snapshots and codex_pending agree on terminal interaction ownership and staleness', async () => {
  // Regression: a question from a terminal turn blocked replacement and its native owner differed from the settle owner.
  const created = await dispatchFixture('fixture-dispatch-question-terminal');
  const readPending = async () => (await call('codex_pending', { threadId: created.threadId })).result;
  const initial = await eventually(readPending, value => value.requests?.length > 0);
  const request = initial.requests[0];
  const before = await management('app/replace/snapshot');
  const blocker = before.interactionWork.blocking.find((item: any) => item.taskId === created.threadId);
  assert.equal(blocker.owner, request.owner);
  assert.equal(blocker.question.responseId, request.responseId);
  assert.ok(before.turns.some((turn: any) => turn.threadId === created.threadId && turn.state === 'needs-attention'));
  try {
    await completed('codex_call', { method: 'fixture/finish-with-pending', params: { threadId: created.threadId }, requestId: randomUUID() });
    const terminal = await eventually(readPending, value => value.requests?.[0]?.stale === true);
    assert.equal(terminal.requests[0].turnStatus, 'completed');
    assert.equal(terminal.requests[0].owner, request.owner);
    const after = await management('app/replace/snapshot');
    assert.equal(after.turns.some((turn: any) => turn.threadId === created.threadId), false);
    assert.equal(after.interactionWork.blocking.some((item: any) => item.taskId === created.threadId), false);
    const stale = after.interactionWork.stale.find((item: any) => item.taskId === created.threadId);
    assert.equal(stale.owner, terminal.requests[0].owner);
    assert.equal(stale.turnId, request.params.turnId);
    assert.equal(stale.question.responseId, request.responseId);
  } finally {
    await completed('codex_respond', { backendSession: initial.backendSession, id: request.responseId, result: { answers: { q: { answers: ['4'] } } }, requestId: randomUUID() });
  }
});

test('respond tokens preserve legacy responses, bind thread and reject reuse', async () => {
  // Regression: reused or wrong-thread response tokens are rejected.
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
  // Regression: queued input must survive restart and remain blocked after a failed predecessor.
  const created=await dispatchFixture('fixture-dispatch-queue');
  const steered=await completed('codex_send',{threadId:created.threadId,prompt:'steer',requestId:randomUUID()});assert.equal(steered.dispatchMode,'steered');assert.equal(steered.turnId,created.turnId);
  const activeInput = (await fixtureRows())[created.threadId].turns[0].input;
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
  const rows=await fixtureRows();assert.equal(rows[created.threadId].turns[2].input[0].text,'third');
  assert.deepEqual(rows[created.threadId].turns[0].input, activeInput, 'queued input never changes the running turn');
  await completed('codex_call',{method:'fixture/finish-turn',params:{threadId:created.threadId},requestId:randomUUID()});
});

test('local panel queues have durable sources, dispatch after completion and promote or cancel once', async () => {
  // Regression: local UI queues lacked sourceId, so dispatch and cancel silently ignored accepted messages.
  const created = await dispatchFixture('fixture-dispatch-queue');
  const local = (op: string, args: Record<string, unknown>) => management('tasks/control', 'POST', { op, args });
  const queue = async (prompt: string) => local('codex_send', { threadId: created.threadId, prompt, sendMode: 'queue', approval: 'approved', requestId: randomUUID() });
  const a = await local('codex_send', { threadId: created.threadId, prompt: 'next turn', sendMode: 'next', approval: 'approved', requestId: randomUUID() }), b = await queue('steer this'), c = await queue('cancel this');
  assert.ok(a.origin.sourceId);
  assert.equal((await local('codex_queue_control', { threadId: created.threadId, queueId: c.queueId, action: 'cancel' })).changed, 1);
  const promoted = await local('codex_queue_control', { threadId: created.threadId, queueId: b.queueId, action: 'promote' });
  assert.ok(['steering', 'steered'].includes(promoted.items[0].state));
  const query = () => local('codex_queue', { threadId: created.threadId });
  await eventually(query, r => r.items.some((row: any) => row.queueId === b.queueId && row.state === 'steered'));
  assert.equal((await fixtureRows())[created.threadId].turns.length, 1);
  assert.equal((await local('codex_queue_control', { threadId: created.threadId, queueId: b.queueId, action: 'promote' })).changed, 0);
  await completed('codex_call', { method: 'fixture/finish-turn', params: { threadId: created.threadId }, requestId: randomUUID() });
  await eventually(fixtureRows, r => r[created.threadId].turns.length === 2);
  assert.equal((await fixtureRows())[created.threadId].turns[1].input[0].text, 'next turn');
  await completed('codex_call', { method: 'fixture/finish-turn', params: { threadId: created.threadId }, requestId: randomUUID() });
  const rejected = await local('codex_send', { threadId: created.threadId, prompt: 'do not start', sendMode: 'steer', approval: 'approved', requestId: randomUUID() });
  assert.equal(rejected.state, 'failed');
  assert.equal((await fixtureRows())[created.threadId].turns.length, 2);
  const idle = await local('codex_send', { threadId: created.threadId, prompt: 'idle next', sendMode: 'next', approval: 'approved', requestId: randomUUID() });
  assert.equal(idle.dispatchMode, 'new-turn');
  await completed('codex_call', { method: 'fixture/finish-turn', params: { threadId: created.threadId }, requestId: randomUUID() });
});

test('ARC answers retain their content and answering source after reconnect', async () => {
  // Regression: reopening a locally answered question lost both its answer and answering source.
  const created = await dispatchFixture('fixture-dispatch-question');
  const pending = await eventually(async () => (await call('codex_pending', { threadId: created.threadId })).result, r => r.requests?.length > 0);
  const request = pending.requests.find((r: any) => r.params.threadId === created.threadId);
  const answer = { answers: { q: { answers: ['Retained answer'] } } };
  const result = await management('agents/respond', 'POST', { op: 'codex_respond', args: { id: request.responseId, backendSession: pending.backendSession, result: answer, requestId: randomUUID() } });
  assert.equal(result.state, 'completed');
  await client.close(); await connectFixture();
  const timeline = await management(`agents/timeline/${created.threadId}`);
  const response = timeline.entries.find((e: any) => e.response)?.response;
  assert.deepEqual(response.result, answer);
  assert.equal(response.origin.controlSource, 'ARC');
  assert.ok(response.origin.sourceId);
  const projected = (await call('task_timeline', { agent: 'codex', id: created.threadId })).result;
  assert.deepEqual(projected.entries.find((e: any) => e.response)?.response, response);
  const reviewId = randomUUID();
  const reviewed = await management('tasks/control', 'POST', { op: 'codex_review', args: { threadId: created.threadId, turnId: created.turnId, verdict: 'pass', requestId: reviewId } });
  assert.equal(reviewed.state, 'completed');
  assert.equal((await call('task_reviews', { id: created.threadId })).result.reviews[0].review.verdict, 'pass');
  assert.equal((await call('task_review_undo', { id: created.threadId, turnId: created.turnId, reviewRequestId: reviewId })).result.undone, true);
  assert.deepEqual((await call('task_reviews', { id: created.threadId })).result.reviews, []);
});

test('capacity failures retry same model without replaying input, suppress intermediate failure and stop after budget or side effects', async () => {
  // Regression: serverOverloaded retries must stop after the budget or observed side effects.
  const created=await dispatchFixture('fixture-dispatch-overload');
  await eventually(fixtureRows,v=>v[created.threadId].turns.length===3);
  let rows=await fixtureRows();assert.equal(rows[created.threadId].turns[2].status,'completed');
  assert.ok(rows[created.threadId].turns.slice(1).every((t:any)=>t.model==='fixture-dispatch-overload'&&t.input[0].text.includes('Continue from the interruption')&&!t.input[0].text.includes('harmless fixture')));
  const events = async (threadId: string) => (await call('inbox_wait', {threadIds:[threadId], timeoutMs:100})).result.events;
  const delivered = await eventually(() => events(created.threadId), rows => rows.some((r:any) => r.kind === 'completed'));
  assert.ok(delivered.every((r:any) => r.kind !== 'failed'));
  const exhausted=await dispatchFixture('fixture-dispatch-overload-exhausted');
  await eventually(() => events(exhausted.threadId), rows => rows.some((r:any) => r.kind === 'failed'));
  assert.equal((await fixtureRows())[exhausted.threadId].turns.length,4);
  const unsafe=await dispatchFixture('fixture-dispatch-overload-side-effect');
  await eventually(() => events(unsafe.threadId), rows => rows.some((r:any) => r.kind === 'failed'));
  assert.equal((await fixtureRows())[unsafe.threadId].turns.length,1);
});


test('task overview defaults to compact live evidence and full view retains preview and cursor', async()=>{
  // Regression: unloaded or unavailable owners must not appear as completed tasks.
  const compact=(await call('codex_tasks',{searchTerm:'fixture-overview'})).result;
  assert.equal(compact.view,'compact');assert.equal(compact.nextCursor,'native-cursor');
  assert.equal(compact.tasks[0].status,'running');assert.equal(compact.tasks[0].title,'Live');
  assert.equal(compact.tasks[0].model,'fixture-model');assert.equal(compact.tasks[0].currentTurn.turnId,'current-turn');
  assert.equal(compact.tasks[1].status,'unconfirmed');assert.match(compact.tasks[1].statusReason,/no live owner/);
  assert.equal(compact.tasks[2].status,'unconfirmed');assert.match(compact.tasks[2].statusReason,/owner unavailable/);assert.equal(compact.tasks[2].currentTurn.turnId,'current-turn');assert.equal(compact.tasks[2].currentTurn.source,'persisted-history');
  const paged=(await call('codex_tasks',{searchTerm:'fixture-overview',view:'full'})).result;
  assert.ok(paged.outputId);let text=paged.text,offset=paged.nextOffset;
  while(offset!==null){const page=(await call('control_output',{outputId:paged.outputId,offset,length:30000})).result;text+=page.text;offset=page.nextOffset;}
  const full=JSON.parse(text);
  assert.ok(full.tasks[0].configuration);assert.equal(full.tasks[0].preview,'x'.repeat(77000));assert.equal(full.nextCursor,'native-cursor');
});

test('Git change queries retain attribution and page through every commit',async()=>{
  // Contract: codex_changes returns complete, ordered commit pages for a task turn.
  const repo=path.join(directory,'notification-repo');await mkdir(repo);
  const git=(...args:string[])=>execFileSync('git',['-c','commit.gpgSign=false','-c','user.name=ARC Fixture','-c','user.email=fixture@example.invalid',...args],{cwd:repo,encoding:'utf8'});
  git('init','--quiet');git('commit','--quiet','--allow-empty','-m','chore: initial');
  const r=await completed('codex_create',{project:repo,prompt:'harmless fixture',thread:{model:'fixture-dispatch-queue'},purpose:'self-test',requestId:randomUUID()});assert.equal(r.state,'completed');
  for(let i=0;i<6;i++){await writeFile(path.join(repo,'sample.txt'),'line\n'.repeat(i+1));git('add','sample.txt');git('commit','--quiet','-m','feat: '+String(i));}
  await completed('codex_call',{method:'fixture/finish-turn',params:{threadId:r.threadId},requestId:randomUUID()});
  const full=(await call('codex_changes',{threadId:r.threadId,turnId:r.turnId,limit:100})).result;
  assert.equal(full.commits.length,6);assert.equal(full.summary.files,1);assert.equal(full.summary.added,6);
  const commits=[];let offset=0;
  do {
    const page=(await call('codex_changes',{threadId:r.threadId,turnId:r.turnId,limit:2,offset})).result;
    commits.push(...page.commits);offset=page.nextOffset;
  } while(offset != null);
  assert.deepEqual(commits,full.commits);
});

test('wait omits repeated nonterminal text and retains complete terminal replies', async () => {
  // Regression: dbb25cf; concurrent fixture writes killed the native reader instead of observing wait progress and deduplication.
  const created=await dispatchFixture('fixture-dispatch-queue');
  const threadId=created.threadId, turnId=created.turnId;
  const updateTurn=(patch:Record<string,unknown>)=>completed('codex_call',{method:'fixture/update-turn',params:{threadId,turnId,patch},requestId:randomUUID()});
  const items=(await fixtureRows())[threadId].turns[0].items;
  const args={threadId,turnId,timeoutMs:200,until:'terminal'};
  delete items[0].status;
  items.push({id:'streaming',type:'agentMessage',status:'inProgress',text:'unfinished sentence'});
  await updateTurn({status:'inProgress',items});
  const firstCall=await call('codex_wait',args);
  assert.equal(firstCall.response.isError,false,JSON.stringify(firstCall.result));
  const first=firstCall.result;
  assert.equal(first.state,'timeout',JSON.stringify(first));assert.equal(first.finalResponse.text,'pong');
  assert.equal(first.threadId,threadId);assert.equal(first.turnId,turnId);assert.equal(first.conditionMet,false);
  assert.ok(first.progress);
  const second=(await call('codex_wait',{...args,expectedHash:first.snapshotHash})).result;
  assert.equal(second.changed,false);assert.equal(second.finalResponse.text,undefined);
  assert.equal(second.finalResponseUnchanged,true);assert.equal(second.finalResponse.textHash,first.finalResponse.textHash);
  assert.equal(second.next.args.expectedHash,second.snapshotHash);assert.equal(second.next.args.timeoutMs,200);assert.equal(second.next.args.until,'terminal');
  const full=(await call('codex_wait',args)).result;assert.equal(full.finalResponse.text,'pong');
  items[0].id='different-message';
  items[0].status='completed';
  await updateTurn({items});
  const metadata=(await call('codex_wait',{...args,expectedHash:second.snapshotHash})).result;
  assert.equal(metadata.changed,true);assert.equal(metadata.finalResponseUnchanged,true);assert.equal(metadata.finalResponse.text,undefined);
  items.pop();
  await updateTurn({status:'completed',items});
  const terminal=(await call('codex_wait',{...args,timeoutMs:300000,expectedHash:metadata.snapshotHash})).result;
  assert.equal(terminal.state,'completed');assert.ok(terminal.finalResponse,JSON.stringify(terminal));assert.equal(terminal.finalResponse.text,'pong');
  const repeated=(await call('codex_wait',{...args,expectedHash:terminal.snapshotHash})).result;
  assert.equal(repeated.changed,false);assert.equal(repeated.finalResponse.text,'pong');assert.equal(repeated.finalResponseUnchanged,undefined);
});

async function readFinalText(summary: any, expected: string) {
  assert.equal(summary.finalResponseTruncated, true);
  const next = summary.finalResponseNext;
  assert.equal(next.via, 'query');
  assert.equal(next.op, 'control_output');
  assert.equal(next.format, 'plain-text');
  assert.equal(next.characters, expected.length);
  assert.equal(next.sha256, createHash('sha256').update(expected).digest('hex'));
  let offset: number | null = next.args.offset;
  let text = '';
  while (offset !== null) {
    const page = (await call(next.op, {...next.args, offset, length: 4093})).result;
    assert.equal(page.format, 'plain-text');
    assert.equal(page.offset, text.length);
    text += page.text;
    if (page.nextOffset !== null) assert.equal(page.nextOffset, text.length);
    offset = page.nextOffset;
  }
  assert.equal(text, expected);
}

test('final text continuation preserves long Codex messages and the selected turn', async () => {
  // Regression: long final messages required parsing task-record JSON and could drift to a newer turn.
  const task = await dispatchFixture('fixture-dispatch-completed');
  const text = '🧪报告 "quoted" \\path\n\t\u0000\r\n'.repeat(4000);
  await completed('codex_call', {method:'fixture/update-turn', params:{threadId:task.threadId, turnId:task.turnId,
    patch:{items:[{id:'final-report', type:'agentMessage', phase:'final_answer', status:'completed', text},
      {id:'commentary', type:'agentMessage', phase:'commentary', status:'completed', text:'Later commentary'}]}}, requestId:randomUUID()});
  const summaries = [];
  for (const op of ['codex_read', 'codex_wait']) {
    const summary = (await call(op, {threadId:task.threadId, turnId:task.turnId, view:'summary',
      ...(op === 'codex_wait' ? {timeoutMs:1000} : {})})).result;
    assert.equal(summary.turnId, task.turnId);
    assert.equal(summary.finalResponse, [...text].slice(0,800).join(''));
    summaries.push(summary);
  }
  await completed('codex_send', {threadId:task.threadId, prompt:'A newer turn', requestId:randomUUID(), approval:'approved', purpose:'self-test'});
  for (const summary of summaries) await readFinalText(summary, text);
  const historical = (await call('codex_read', {threadId:task.threadId, turnId:task.turnId, view:'summary'})).result;
  await readFinalText(historical, text);
  const first = (await call('control_output', {...historical.finalResponseNext.args, length:1})).result;
  assert.equal(first.text, '🧪');
  assert.equal(first.nextOffset, 2);
  const invalid = (await call('control_output', {...historical.finalResponseNext.args, offset:1})).result;
  assert.equal(invalid.error.code, 'INVALID_OUTPUT_OFFSET');
});

test('final text continuation restores ACP archives and survives task reuse', async () => {
  // Regression: ACP summaries exposed only an excerpt or a 256 KiB tail with task-record JSON as continuation.
  const agent = 'tracking-example';
  const text = '🧪报告 "quoted" \\path\n\t\u0000\r\n'.repeat(14000);
  const created = await completed('agent_create', {agent, cwd:directory, prompt:'fixture-final-text:' + text,
    title:'Final text fixture', requestId:randomUUID(), approval:'approved', purpose:'self-test'});
  const taskId = created.taskId;
  const summaries = [];
  for (const op of ['agent_wait', 'agent_read']) {
    const summary = (await call(op, {agent, taskId, view:'summary', ...(op === 'agent_wait' ? {timeoutMs:10000} : {})})).result;
    assert.equal(summary.state, 'completed');
    assert.equal(summary.finalResponse, [...text].slice(0,800).join(''));
    assert.equal(summary.arcInbox, undefined);
    summaries.push(summary);
  }
  const nextText = 'Second turn 🧩\\"\n'.repeat(20000);
  await completed('agent_send', {agent, taskId, prompt:'fixture-final-text:' + nextText,
    requestId:randomUUID(), approval:'approved', purpose:'self-test'});
  const next = (await call('agent_read', {agent, taskId, view:'summary'})).result;
  assert.notEqual(next.turnId, summaries[0].turnId);
  for (const summary of summaries) await readFinalText(summary, text);
  await readFinalText(next, nextText);
  await completed('agent_send', {agent, taskId, prompt:'fixture-final-text:Short final',
    requestId:randomUUID(), approval:'approved', purpose:'self-test'});
  const short = (await call('agent_read', {agent, taskId, view:'summary'})).result;
  assert.equal(short.finalResponse, 'Short final');
  assert.equal(short.finalResponseTruncated, false);
  assert.equal(short.finalResponseNext, undefined);
});

test('inbox_wait filters unread events before limiting, isolates ingress and cooperates with ack', async () => {
  // Contract: inbox wait filters unread events before limiting, isolates ingress and cooperates with ack, including paged output.
  const inbox = async (filters: Record<string, unknown>) => {
    const {result} = await call('inbox_wait', filters);
    if (!result.outputId) return result;
    let text = '', offset: number | null = 0;
    while (offset !== null) {
      const {result: page} = await call('control_output', {outputId:result.outputId, offset, length:8192});
      text += page.text;
      offset = page.nextOffset;
    }
    return JSON.parse(text);
  };
  await completed('notification_ack', {all:true});
  const unrelated: string[] = [];
  for (let i = 0; i < 6; i++) {
    const task = await dispatchFixture('fixture-dispatch-completed');
    await eventually(() => inbox({timeoutMs:100,threadIds:[task.threadId]}), r => r.state === 'events');
    unrelated.push(task.threadId);
  }
  const backlog = await inbox({timeoutMs:100,threadIds:unrelated});
  assert.equal(backlog.unread, unrelated.length);
  const summaryTask=await dispatchFixture('fixture-dispatch-completed');
  const finalText='🧪'.repeat(900);
  const changes=Array.from({length:60},(_,i)=>({path:`src/summary-${i}.rs`,diff:'@@ -1 +1 @@\n-old\n+new'}));
  await completed('codex_call',{method:'fixture/update-turn',params:{threadId:summaryTask.threadId,turnId:summaryTask.turnId,patch:{items:[{id:'summary-final',type:'agentMessage',phase:'final_answer',status:'completed',text:finalText},{id:'summary-files',type:'fileChange',status:'completed',changes}]}},requestId:randomUUID()});
  for(const op of ['codex_wait','codex_read']) {
    const summary=(await call(op,{threadId:summaryTask.threadId,turnId:summaryTask.turnId,view:'summary',...(op==='codex_wait'?{timeoutMs:1000}:{})})).result;
    assert.equal(summary.state,'completed');assert.equal(summary.arcInbox,undefined);assert.equal(summary.externalUserInputs,undefined);assert.equal(summary.srcConversation,undefined);
    assert.equal([...summary.finalResponse].length,800);assert.equal(summary.finalResponseTruncated,true);
    assert.equal(summary.files.length,50);assert.equal(summary.filesTruncated,true);assert.equal(summary.diffstat.files,60);assert.equal(summary.diffstat.added,60);
    assert.equal(summary.completeEvidence.args.turnId,summaryTask.turnId);
    const evidence=(await call(summary.completeEvidence.op,summary.completeEvidence.args)).result;
    assert.equal(evidence.turns[0].finalResponse,finalText);assert.equal(evidence.turns[0].files.length,60);
    assert.ok(!unrelated.some(id=>JSON.stringify(summary).includes(id)));
  }
  assert.equal((await inbox({timeoutMs:100,threadIds:unrelated})).unread,unrelated.length);

  assert.ok(backlog.events.length < backlog.unread, 'unrelated unread events exceed the response limit');
  const wanted = await dispatchFixture('fixture-dispatch-completed');
  const args = {timeoutMs:100,threadIds:[wanted.threadId],eventTypes:['completed']};
  const first = await eventually(() => inbox(args), r => r.state === 'events');
  assert.equal(first.events.length, 1);
  assert.equal(first.unread, 1);
  assert.ok(first.events.every((e:any) => e.threadId === wanted.threadId && e.kind === 'completed'));
  assert.deepEqual((await inbox(args)).events,first.events);
  const eventIds = first.events.map((e:any) => e.eventId);
  const other=await management('ingress','POST',{id:'inbox-isolation',name:'Inbox isolation',toolPolicy:'all',controlSource:'custom',transport:'https',auth:'bearer',bearerToken:'test-inbox-isolation'.padEnd(40,'x'),config:{httpsProvider:'custom',httpsUrl:'https://inbox-isolation.example/mcp'}});
  try {
    await management(`ingress/${other.id}/start`,'POST');
    const isolated=await ingressRpc(other,'tools/call',{name:'inbox_wait',arguments:args});
    assert.deepEqual(isolated.result.structuredContent.result.events,[]);
    await ingressRpc(other,'tools/call',{name:'notification_ack',arguments:{eventIds}});
    assert.deepEqual((await inbox(args)).events,first.events);
  } finally { await management(`ingress/${other.id}`,'DELETE'); }
  assert.equal((await completed('notification_ack',{eventIds})).markedRead,eventIds.length);
  const timeout=await inbox(args);
  assert.equal(timeout.state,'timeout');assert.deepEqual(timeout.events,[]);assert.deepEqual(timeout.next.args,args);
  assert.equal((await inbox({timeoutMs:100,threadIds:unrelated})).unread, unrelated.length);
  assert.equal((await inbox({timeoutMs:1,threadIds:unrelated,eventTypes:['interrupted']})).state, 'timeout');
  const late = await dispatchFixture('fixture-dispatch-queue');
  const waiting = fetch(`http://127.0.0.1:${endpoint.port}/mcp/default`, {method:'POST', headers:{Authorization:`Bearer ${endpoint.token}`,'Content-Type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0',id:'late-inbox',method:'tools/call',params:{name:'query',arguments:{op:'inbox_wait',args:{timeoutMs:15000,threadIds:[late.threadId],eventTypes:['completed']}}}})}).then(r => r.json());
  await completed('codex_call',{method:'fixture/finish-turn',params:{threadId:late.threadId},requestId:randomUUID()});
  assert.equal((await waiting).result.structuredContent.result.events[0].threadId, late.threadId);
});

test('HTTP and HTTPS ingress wait streaming keeps final result intact and releases request IDs on disconnect', async () => {
  // Contract: HTTP and HTTPS ingress wait streaming keeps final result intact and releases request IDs on disconnect.
  const ingress=await management('ingress','POST',{id:'wait-stream',name:'Wait stream',toolPolicy:'all',controlSource:'custom',transport:'https',auth:'bearer',bearerToken:'test-wait-stream'.padEnd(40,'x'),config:{httpsProvider:'custom',httpsUrl:'https://wait-stream.example/mcp'}});
  await management('ingress/wait-stream/start','POST');
  try { for(const [url,token] of [[`http://127.0.0.1:${endpoint.port}/mcp/default`,endpoint.token],[`http://127.0.0.1:${ingress.config.httpsPort}/mcp`,'test-wait-stream'.padEnd(40,'x')]]) {
  const request={jsonrpc:'2.0',id:'disconnect-self-test',method:'tools/call',params:{name:'query',arguments:{op:'inbox_wait',args:{timeoutMs:1800000,threadIds:['never-self-test']}}}};
  for(const accept of ['application/json','application/json, text/event-stream']){
    const abort=new AbortController();
    const response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:accept},body:JSON.stringify(request),signal:abort.signal});
    const chunk=await response.body!.getReader().read();assert.ok(chunk.value!.length>0);
    const text=new TextDecoder().decode(chunk.value);assert.equal(text.includes('notifications/progress'),false);
    abort.abort();
    const retry=await eventually(async()=>{
      const r=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({...request,params:{...request.params,arguments:{op:'inbox_wait',args:{timeoutMs:1,threadIds:['never-self-test']}}}})});
      return r.json();
    },v=>!v.error);
    assert.equal(retry.result.structuredContent.result.state,'timeout');
  }
  const progress=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({...request,id:'progress-self-test',params:{...request.params,_meta:{progressToken:'progress-token'},arguments:{op:'inbox_wait',args:{timeoutMs:100,threadIds:['never-self-test']}}}})});
  const frames=(await progress.text()).split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6)));
  assert.equal(frames[0].method,'notifications/progress');assert.equal(frames[0].params.progressToken,'progress-token');
  assert.equal(frames.at(-1).result.structuredContent.result.state,'timeout');
  }} finally {await management('ingress/wait-stream','DELETE');}
});

test('Claude task waits expose the source cap without delaying terminal results', async () => {
  // Contract: Claude task waits expose the source cap without delaying terminal results.
  const created=await dispatchFixture('fixture-dispatch-completed');
  await management('ingress','POST',{id:'wait-cap',name:'Wait cap',toolPolicy:'all',controlSource:'claude',transport:'https',auth:'bearer',bearerToken:'test-wait-cap'.padEnd(40,'x'),config:{httpsProvider:'custom',httpsUrl:'https://wait-cap.example/mcp'}});
  await management('ingress/wait-cap/start','POST');
  try {
    const response=await fetch(`http://127.0.0.1:${endpoint.port}/mcp/wait-cap`,{method:'POST',headers:{Authorization:`Bearer ${endpoint.token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'cap-self-test',method:'tools/call',params:{name:'query',arguments:{op:'codex_wait',args:{threadId:created.threadId,turnId:created.turnId,timeoutMs:1800000,until:'terminal'}}}})});
    const result=(await response.json()).result.structuredContent.result;
    assert.equal(result.state,'completed');assert.equal(result.finalResponse.text,'pong');
    assert.equal(result.waitLimit.capped,true);assert.equal(result.waitLimit.timeoutMs,170000);
    assert.equal(result.waitLimit.requestedTimeoutMs,1800000);assert.equal(result.waitLimit.controlSource,'claude');
  } finally {await management('ingress/wait-cap','DELETE');}
});

test('stdio bridge forwards negotiated progress, preserves final replies and cancels on EOF', async () => {
  // Contract: stdio bridge forwards negotiated progress, preserves final replies and cancels on EOF.
  const child=spawn(fixtureCommand,['stdio'],{env:{...fixtureEnv,ARC_NATIVE_PORT:String(endpoint.port),ARC_NATIVE_TOKEN:endpoint.token,ARC_INGRESS_ID:'default'},stdio:['pipe','pipe','pipe']});
  const messages:any[]=[];let pending='';
  child.stdout.on('data',chunk=>{pending+=String(chunk);let i;while((i=pending.indexOf('\n'))>=0){messages.push(JSON.parse(pending.slice(0,i)));pending=pending.slice(i+1);}});
  try {
    const request=(id:string,timeoutMs:number,progress=false)=>({jsonrpc:'2.0',id,method:'tools/call',params:{name:'query',arguments:{op:'inbox_wait',args:{timeoutMs,threadIds:['stdio-self-test']}},...(progress?{_meta:{progressToken:'stdio-token'}}:{})}});
    child.stdin.write(JSON.stringify(request('stdio-progress',100,true))+'\n');
    await eventually(async()=>messages,v=>v.some(r=>r.id==='stdio-progress'));
    assert.equal(messages.find(r=>r.method==='notifications/progress').params.progressToken,'stdio-token');
    assert.equal(messages.find(r=>r.id==='stdio-progress').result.structuredContent.result.state,'timeout');
    const before=messages.length;
    child.stdin.write(JSON.stringify(request('stdio-quiet',100))+'\n');
    await eventually(async()=>messages,v=>v.some(r=>r.id==='stdio-quiet'));
    assert.equal(messages.slice(before).filter(r=>r.method==='notifications/progress').length,0);
    child.stdin.write(JSON.stringify(request('stdio-disconnect',1800000,true))+'\n');
    await eventually(async()=>messages.length,v=>v>before+1);
    child.stdin.end();await new Promise<void>(r=>child.once('exit',()=>r()));
    const retry=await eventually(async()=>{
      const r=await fetch(`http://127.0.0.1:${endpoint.port}/mcp/default`,{method:'POST',headers:{Authorization:`Bearer ${endpoint.token}`,'Content-Type':'application/json'},body:JSON.stringify(request('stdio-disconnect',1))});return r.json();
    },v=>!v.error);
    assert.equal(retry.result.structuredContent.result.state,'timeout');
  } finally {child.kill();}
});

test('non-object MCP args report their JSON type without exposing submitted content', async () => {
  // Regression: act rejected non-object args with no received type in the validation error.
  const secret = 'private-argument-content';
  for (const [name,op] of [['query','read'],['act','write']] as const) {
    for (const [args,type] of [
      [JSON.stringify({path:secret,content:'`{ "quoted": "value" }`\n'}),'string'],
      [secret,'string'],['{broken','string'],[null,'null'],[false,'boolean'],[42,'number'],[[],'array'],
    ] as const) {
      const response=await client.callTool({name,arguments:{op,args}});
      const error=(response.structuredContent as any).result.error;
      assert.equal(response.isError,true);
      assert.equal(error.code,'INVALID_ARGUMENTS');
      assert.equal(error.field,'/args');
      assert.match(error.message,new RegExp(`received JSON type ${type}\\b`));
      assert.doesNotMatch(JSON.stringify(response),new RegExp(secret));
    }
  }
});

test('object MCP args preserve nested values, quotes and large multiline strings', async () => {
  // Regression: cloud act calls with nested notify or long quoted content failed outer args validation.
  const content='`code` {"quoted":"value"} | <tag> \'single\' (parentheses)\n'.repeat(1500);
  const file=path.join(directory,'large-args.md');
  const written=await completed('write',{path:file,content,requestId:randomUUID()});
  assert.equal(written.state,'completed');
  assert.equal(await readFile(file,'utf8'),content);
  const created=await completed('codex_create',{
    project:directory,prompt:content,thread:{model:'fixture-dispatch-completed'},
    purpose:'self-test',notify:null,requestId:randomUUID(),waitMs:1000,
  });
  assert.equal(created.state,'completed');
  assert.equal(typeof created.threadId,'string');
  const invalid=await call('codex_create',{prompt:content,notify:{channel:'claude-session',target:false}});
  assert.equal(invalid.response.isError,true);
  assert.equal(invalid.result.error.code,'INVALID_ARGUMENTS');
  assert.equal(invalid.result.error.field,'/notify/target');
  assert.match(invalid.result.error.message,/received JSON type boolean\b/);
});

test('argument errors are short, field-specific and leave unread inbox untouched', async () => {
  // Contract: argument errors are short, field-specific and leave unread inbox untouched.
  const created = await dispatchFixture('fixture-dispatch-completed');
  const wait = async () => (await call('inbox_wait',{timeoutMs:100,threadIds:[created.threadId]})).result.events;
  const unread = await eventually(wait, rows => rows.length > 0);
    for(const [name,args,field,reason] of [
      ['read',{path:'fixture',linCount:2},'/linCount',/lineCount/],
      ['codex_items',{threadId:'fixture',order:'desc'},'/order',/latest/],
      ['codex_wait',{threadId:'fixture',timeoutMs:1800001},'/timeoutMs',/1800000/],
      ['read',{path:'fixture',lineCount:'private-input'},'/lineCount',/integer/],
      ['command',{cmd:'private-command'},'/cwd',undefined],
      ['command',{cmd:'private-command',cwd:directory,action:'exec'},'/action',/combine/],
    ] as const){
      const {response,result}=await call(name,args);
      assert.equal(response.isError,true);assert.equal(result.error.code,'INVALID_ARGUMENTS');
      assert.equal(result.error.field,field);if(reason)assert.match(result.error.message,reason);
      assert.equal(result.error.inputSchema,undefined);assert.equal(result.arcInbox,undefined);
      const text=(response.content as any[])[0].text;
      assert.deepEqual(JSON.parse(text).error,result.error);assert.doesNotMatch(text,/private-input|private-command/);
      assert.equal(result.error.guide.arguments.args.op,name);
    }
    const envelope=await client.callTool({name:'query',arguments:{op:'read',args:{},extra:'private-value'}});
    assert.equal(envelope.isError,true);assert.equal((envelope.structuredContent as any).result.error.field,'/extra');
    assert.deepEqual(await wait(),unread);
});

test('Git action and read limit aliases preserve behavior and search clamps its page size', async () => {
  // Regression: 3df24a2; Git action and read limit aliases preserve behavior and search clamps its page size.
  const project=path.join(directory,'argument-aliases');await mkdir(project);
  execFileSync('git',['init',project],{stdio:'pipe'});
  await Promise.all(Array.from({length:60},(_,i)=>writeFile(path.join(project,`${i}.txt`),'needle\nsecond\nthird')));
  const canonical=(await call('read',{project,path:'0.txt',lineCount:1})).result.data;
  assert.deepEqual((await call('read',{project,path:'0.txt',limit:1})).result.data,canonical);
  assert.equal((await call('read',{project,path:'0.txt',limit:1,lineCount:2})).result.error.field,'/limit');
  assert.equal((await call('git',{project,action:'status'})).response.isError,false);
  assert.equal((await call('git',{project,action:'status',operation:'log'})).result.error.field,'/action');
  const requestId=randomUUID();
  const first=await completed('git_write',{project,action:'add',paths:['0.txt'],requestId});assert.equal(first.state,'completed');
  const replay=await completed('git_write',{project,operation:'add',paths:['0.txt'],requestId});assert.equal(replay.requestId,first.requestId);assert.equal(replay.state,'completed');
  const search=(await call('search',{project,query:'needle',limit:60})).result.data;
  assert.equal(search.results.length,50);assert.ok(search.nextOffset);
  assert.equal((await call('search',{project,query:'needle',limit:0})).result.error.field,'/limit');
});

test('cmd waitMs returns a pending receipt without changing the process timeout', async () => {
  // Regression: 3df24a2; cmd waitMs returns a pending receipt without changing the process timeout.
  const requestId=randomUUID();
  const first=await call('command',{cmd:'fixture-delayed',cwd:directory,waitMs:0,timeoutMs:2000,requestId});
  assert.equal(first.response.isError,false);assert.equal(first.result.state,'pending');
  const done=await completed('command',{cmd:'fixture-delayed',cwd:directory,waitMs:1000,timeoutMs:2000,requestId});assert.equal(done.state,'completed');

});

test('multi-root projects preserve legacy selection and resolve project cwd alternatives', async () => {
  // Regression: 68dea77; multi-root projects select a unique basename or Git root and list ambiguous candidates.
  const base=path.join(directory,'multi-root');await mkdir(base);
  const dirs=['client','plain','repo','other'];await Promise.all(dirs.map(d=>mkdir(path.join(base,d))));
  execFileSync('git',['init',path.join(base,'repo')],{stdio:'pipe'});
  await mkdir(path.join(base,'repo','nested'));
  await writeFile(path.join(directory,'projects-fixture.json'),JSON.stringify([
    {id:'single',name:'one',roots:[{path:path.join(base,'plain')}]},
    {id:'named',name:'client',roots:[{path:path.join(base,'plain')},{path:path.join(base,'client')}]},
    {id:'git-root',name:'plugins',roots:[{path:path.join(base,'repo','nested')},{path:path.join(base,'repo')},{path:path.join(base,'plain')}]},
    {id:'ambiguous',name:'many',roots:[{name:'primary',path:path.join(base,'plain')},{path:path.join(base,'other')}]},
  ]));
  for(const [project,root] of [['client','client'],['plugins','repo']]) {
    const result=(await call('overview',{project,includeSource:true})).result;
    assert.equal(result.source.root,await realpath(path.join(base,root)));
  }
  const error=(await call('overview',{project:'many'})).result.error.message;
  assert.ok(error.includes(path.join(base,'plain')));assert.ok(error.includes(path.join(base,'other')));
  const cwd=path.join(directory,'multi-root','plain');
  const ambiguous=await completed('command',{cmd:'fixture',project:'many',requestId:randomUUID()});
  assert.equal(ambiguous.state,'failed');
  assert.ok(ambiguous.error.message.includes('plain'));assert.ok(ambiguous.error.message.includes('other'));
  for (const root of ['primary','plain','multi-root/plain']) {
    const args={cmd:'fixture-cwd',project:'many',root,requestId:randomUUID()};
    const result=await completed('command',args);
    assert.equal(result.state,'completed');assert.equal(result.origin,undefined);assert.equal(result.result.stdout,await realpath(cwd));
    const replay=(await call('receipt',{requestId:args.requestId,includeOrigin:true})).result;
    assert.ok(replay.origin.sourceId);assert.ok(replay.origin.ingressId);
  }
  const native=await completed('command',{action:'exec',project:'many',root:'plain',params:{command:['fixture']},requestId:randomUUID()});
  assert.equal(native.state,'completed');assert.equal(native.result.echoedParams.cwd,await realpath(cwd));
  const spawned=await completed('process',{action:'spawn',project:'many',root:'plain',params:{command:'fixture'},requestId:randomUUID()});
  assert.equal(spawned.result.echoedParams.cwd,await realpath(cwd));
  const read=(await call('tree',{project:'many',root:'plain'})).result;
  assert.equal(read.error,undefined);
  const single=await completed('command',{cmd:'fixture-cwd',project:'one',requestId:randomUUID()});
  assert.equal(single.result.stdout,await realpath(cwd));
  const agentArgs={agent:'tracking-example',project:'one',prompt:'',approval:'approved',purpose:'self-test',requestId:randomUUID()};
  const agent=await completed('agent_create',agentArgs);assert.equal(agent.state,'completed');
  const task=(await call('agent_read',{agent:'tracking-example',taskId:agent.taskId})).result;
  assert.equal(task.cwd,await realpath(cwd));assert.equal(typeof task.origin.accountId,'string');
  assert.equal((await completed('agent_create',agentArgs)).taskId,agent.taskId);
  const absolute=await completed('command',{cmd:'fixture',cwd,project:'missing',requestId:randomUUID()});
  assert.equal(absolute.state,'completed');
});

test('large non-Git tree returns a bounded first layer and a truncation marker', async () => {
  // Regression: 68dea77; large non-Git tree returns a bounded first layer and a truncation marker.
  const base=path.join(directory,'large-tree');await mkdir(base);
  await mkdir(path.join(base,'deep'));await mkdir(path.join(base,'empty'));
  for(let batch=0;batch<101;batch++)await Promise.all(Array.from({length:100},(_,i)=>writeFile(path.join(base,'deep',`${batch*100+i}`),'')));
  const tree=(await call('tree',{path:base,depth:2,includeSource:true})).result;
  assert.equal(tree.data.truncated,true);assert.equal(tree.data.depth,1);
  assert.deepEqual(tree.data.entries,['deep/','empty/']);assert.equal(tree.data.nextOffset,null);
  assert.equal(tree.data.coverage.state,'partial');
  const shallow=(await call('tree',{path:base,depth:1})).result.data;
  assert.equal(shallow.truncated,false);assert.deepEqual(shallow.entries,['deep/','empty/']);
});

test('Desktop seed is named before independent metadata read even with null rollout path', {skip:process.platform==='linux'}, async () => {
  // Regression: 019e03c; Desktop seed is named before independent metadata read even with null rollout path.
  const original=await management('task-settings');
  await management('task-settings','PUT',{autoOpenCodex:true,codexRetryMaxAttempts:0});
  try {
    const r=await completed('codex_create',{project:directory,prompt:'seed persistence regression',thread:{model:'fixture-dispatch-lazy-seed'},purpose:'self-test',approval:'bypass',requestId:randomUUID()});
    assert.equal(r.state,'completed',JSON.stringify(r));
    const row=(await fixtureRows())[r.threadId];
    assert.equal(row.thread.path,null);assert.equal(row.named,true);assert.equal(row.independentReader,true);assert.equal(row.unsubscribed,true);assert.equal(row.turns.length,1);
  } finally {await management('task-settings','PUT',original);}
});


test('item and search pagination reconstruct the complete result', async () => {
  // Contract: item and search pagination reconstruct the complete result.
  const read = (await call('codex_read',{threadId:'response-size',limit:6})).result;
  assert.equal(read.turns.length, 6);
  for (const turn of read.turns) {
    assert.equal(turn.items.length, 4);
    assert.ok(Array.isArray(turn.items[0].content));
    assert.equal(turn.items[1].command, 'git diff --stat');
    assert.equal(turn.items[1].exitCode, 0);
    assert.ok(Array.isArray(turn.items[2].changes));
  }
  const fullRead = (await call('codex_read',{threadId:'response-size',limit:6,view:'full'})).result;
  assert.ok(fullRead.turns[0].items.some((item:any) => item.type === 'reasoning'));
  const first=(await call('codex_items',{threadId:'image-pagination',latest:true,length:3,view:'full'})).result;
  const continued=(await call('codex_items',{threadId:'image-pagination',latest:true,turnId:first.turnId,view:'full',offset:first.items[0].nextOffset,expectedHash:first.items[0].textHash})).result;
  assert.equal(first.items[0].text+continued.items[0].text,'latest last');
  const compact=(await call('codex_items',{threadId:'image-pagination',latest:true})).result;
  const next=(await call('codex_items',{threadId:'image-pagination',latest:true,turnId:compact.turnId,cursor:compact.nextCursor})).result;
  assert.deepEqual([compact.items[0].text,next.items[0].text],['latest last','latest first']);
  const project=path.join(directory,'response-size');await mkdir(project);
  execFileSync('git',['init',project],{stdio:'pipe'});
  const files=Array.from({length:50},(_,i)=>`file-${String(i).padStart(2,'0')}.txt`);
  await Promise.all(files.map(file=>writeFile(path.join(project,file),'needle: matching source line\ncontext line\n')));
  const matches=[];let offset=0;
  do {
    const page=(await call('search',{project,query:'needle',limit:10,offset})).result.data;
    matches.push(...page.results.map((r:any)=>r.path));offset=page.nextOffset;
  } while(offset != null);
  assert.deepEqual(matches.sort(),files);
});

test('large Git diff is bounded and its immutable output pages retain text and file statistics', async()=>{
  // Contract: control_output pages reconstruct the original Git diff snapshot.
  const project=path.join(directory,'diff-size');await mkdir(project);
  const git=(...args:string[])=>execFileSync('git',['-C',project,...args],{encoding:'utf8'});
  git('init');await writeFile(path.join(project,'large.txt'),'before\n');await writeFile(path.join(project,'small.txt'),'before\n');
  git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgSign=false','commit','-m','fixture');
  const content=Array.from({length:1800},(_,i)=>`line ${i}: 中文 bounded diff output`).join('\n')+'\n';
  await writeFile(path.join(project,'large.txt'),content);await writeFile(path.join(project,'small.txt'),'after\n');
  const response=await call('git',{project,action:'diff',includeSource:true});
  let result=response.result;
  if(result.outputId){
    let text='',offset:number|null=0;
    while(offset!==null){const page=(await call('control_output',{outputId:result.outputId,offset,length:12000})).result;text+=page.text;offset=page.nextOffset;}
    result=JSON.parse(text);
  }
  const data=result.data;
  assert.equal(response.response.isError,false);assert.equal(data.truncated,true);
  assert.deepEqual(data.files.map((f:any)=>[f.path,f.added,f.removed]),[['large.txt',1800,1],['small.txt',1,1]]);
  assert.equal(data.coverage.state,'partial');assert.ok(data.output.outputId);
  await writeFile(path.join(project,'large.txt'),'changed after snapshot\n');
  let text='',offset:number|null=0;
  while(offset!==null){const page=(await call('control_output',{outputId:data.output.outputId,offset,length:12000})).result;text+=page.text;offset=page.nextOffset;}
  const full=JSON.parse(text);assert.ok(full.text.includes('+'+content.trimEnd().split('\n').at(-1)));assert.deepEqual(full.files,data.files);
  const narrow=(await call('git',{project,action:'diff',path:'small.txt'})).result.data;
  assert.equal(narrow.truncated,false);assert.equal(narrow.output,undefined);assert.ok(narrow.text.includes('+after'));
});

test('external terminal reviews retain provenance, replay, rework links and separate history', async()=>{
  // Regression: REVIEW_DISPATCH_NOT_FOUND prevented reviewing turns started directly in Codex Desktop.
  await management('task-settings','PUT',{autoOpenCodex:false});
  const seed=async(known=true)=>{
    const native=(await call('codex_call',{method:'thread/start',params:{model:'fixture-dispatch-external',cwd:directory},requestId:randomUUID()})).result;
    assert.equal(native.state,'completed');
    return (await call('codex_call',{method:'fixture/external-review',params:{threadId:native.threadId,known},requestId:randomUUID()})).result;
  };
  const seeded=await seed();
  assert.equal(seeded.state,'completed');
  const {threadId,turnId}=seeded,activeTurnId=seeded.result.activeTurnId;
  const requestId=randomUUID();
  const args={threadId,verdict:'rework',requestId};
  const first=(await call('codex_review',args)).result;
  assert.equal(first.state,'completed',JSON.stringify(first));
  assert.equal(first.turnId,turnId);
  const review=first.result.review;
  assert.equal(review.dispatchOrigin,'external');assert.equal(review.dispatchRequestId,null);
  assert.equal(review.model,'fixture-external-model');assert.equal(review.effort,'high');assert.equal(review.serviceTier,'priority');
  assert.equal(review.reviewer.controlSource,'chatgpt');assert.ok(review.reviewer.sourceId);
  assert.equal(review.reviewer.sessionId,null);assert.equal(review.reviewer.target,null);
  assert.ok(Date.parse(review.reviewedAt));
  const again=(await call('codex_review',args)).result;
  assert.deepEqual(again.result.review,review);
  const running=(await call('codex_review',{threadId,turnId:activeTurnId,verdict:'pass',requestId:randomUUID()})).result;
  assert.equal(running.state,'failed');assert.match(running.error.message,/REVIEW_REQUIRES_TERMINAL_TURN/);
  const missing=(await call('codex_review',{threadId,turnId:randomUUID(),verdict:'pass',requestId:randomUUID()})).result;
  assert.equal(missing.state,'failed');assert.match(missing.error.message,/REVIEW_TERMINAL_TURN_NOT_FOUND/);
  const unknown=(await call('codex_review',{threadId:randomUUID(),verdict:'pass',requestId:randomUUID()})).result;
  assert.equal(unknown.state,'failed');
  const invalid=await call('codex_review',{threadId,turnId,verdict:'invalid',requestId:randomUUID()});
  assert.equal(invalid.response.isError,true);assert.equal(invalid.result.error.code,'INVALID_ARGUMENTS');
  let history=(await call('dispatch_policy',{agent:'codex',view:'full'})).result.agents.find((a:any)=>a.agent==='codex').history;
  let group=history.groups.find((g:any)=>g.model==='fixture-external-model');
  assert.deepEqual(group.external,{reviews:1,pass:0,rework:1});assert.equal(group.dispatches,0);assert.equal(group.durationSamples,undefined);
  await call('codex_call',{method:'fixture/finish-turn',params:{threadId},requestId:randomUUID()});
  const next=(await call('codex_send',{threadId,prompt:'Revise fixture',purpose:'self-test',requestId:randomUUID()})).result;
  assert.equal(next.state,'completed',JSON.stringify(next));
  const tasks=(await call('codex_tasks',{searchTerm:'fixture-external-review',view:'full'})).result.tasks;
  assert.equal(tasks.find((t:any)=>t.threadId===threadId).dispatches.find((d:any)=>d.turnId===next.turnId).reworkOf,turnId);
  const changed=(await call('codex_review',{threadId,turnId,verdict:'pass',requestId:randomUUID()})).result;
  assert.equal(changed.state,'completed');assert.equal(changed.result.review.dispatchOrigin,'external');
  const read=(await call('codex_read',{threadId,view:'full'})).result;
  assert.equal(read.reviews.filter((r:any)=>r.turnId===turnId).length,1);
  assert.equal(read.reviews.find((r:any)=>r.turnId===turnId).review.verdict,'pass');
  history=(await call('dispatch_policy',{agent:'codex',view:'full'})).result.agents.find((a:any)=>a.agent==='codex').history;
  group=history.groups.find((g:any)=>g.model==='fixture-external-model');
  assert.deepEqual(group.external,{reviews:1,pass:1,rework:0});assert.equal(group.dispatches,0);
  const compact=(await call('dispatch_policy',{agent:'codex'})).result.agents.find((a:any)=>a.agent==='codex').history;
  assert.ok(compact.groups.some((g:string)=>/\bext[1-9]\d* pass[1-9]/.test(g)));
  const noConfig=await seed(false);
  const nullable=(await call('codex_review',{threadId:noConfig.threadId,turnId:noConfig.turnId,verdict:'pass',requestId:randomUUID()})).result;
  assert.equal(nullable.state,'completed');
  for(const key of ['model','effort','serviceTier'])assert.equal(nullable.result.review[key],null);
});


test('review receipts omit notification delivery details including replay',async()=>{
  // Contract: review receipts omit notification delivery details including replay.
  const created=await dispatchFixture('fixture-dispatch');
  const requestId=randomUUID();const args={threadId:created.threadId,turnId:created.turnId,verdict:'pass',requestId};
  const reviewed=await completed('codex_review',args);
  assert.equal(reviewed.result.review.dispatchOrigin,'arc');assert.equal(reviewed.result.review.dispatchRequestId,created.requestId);
  assert.equal(reviewed.state,'completed',JSON.stringify(reviewed));assert.equal(reviewed.notification,undefined);assert.equal(reviewed.notificationError,undefined);
  const replay=(await call('receipt',{requestId})).result;
  assert.equal(replay.state,'completed');assert.equal(replay.notification,undefined);assert.equal(replay.notificationError,undefined);
});


test('ACP task tracking keeps approvals active and projects context, SSE and incremental timeline', async () => {
  // Regression: an unresolved ACP approval must stay actionable while execution output arrives.
  const transcriptDir=path.join(directory,'home/.claude/projects/example');
  await mkdir(transcriptDir,{recursive:true});
  const transcriptIds=[randomUUID(),randomUUID()];
  for (const sessionId of transcriptIds) await writeFile(path.join(transcriptDir,sessionId+'.jsonl'),JSON.stringify({type:'assistant',sessionId,cwd:directory,timestamp:new Date().toISOString(),message:{stop_reason:null,content:[{type:'thinking',thinking:'Review example'}]}})+'\n');
  const requestId=randomUUID();
  const created=(await call('agent_create',{agent:'tracking-example',cwd:directory,prompt:'Check example',title:'Example task',requestId,approval:'approved',purpose:'self-test',waitMs:1})).result;
  assert.ok(created.taskId,JSON.stringify(created));
  const taskId=created.taskId;
  const agentInbox = await eventually(async () => (await call('inbox_wait',{timeoutMs:100,taskIds:[taskId],eventTypes:['needs-input']})).result, r => r.state === 'events');
  assert.ok(agentInbox.events.length > 0);
  assert.ok(agentInbox.events.every((event:any) => event.taskId === taskId && event.kind === 'needs-input'));
  const wait=(await call('agent_wait',{agent:'tracking-example',taskId,timeoutMs:10000})).result;
  assert.equal(wait.state,'interaction-required',JSON.stringify(wait));
  const compactWait=(await call('agent_wait',{agent:'tracking-example',taskId,timeoutMs:1000,view:'summary'})).result;
  assert.equal(compactWait.state,'interaction-required');assert.equal(compactWait.next.op,'agent_pending');
  assert.equal(compactWait.arcInbox,undefined);assert.equal(compactWait.files,null);assert.equal(compactWait.diffstat,null);


  const activity=await management('agents/activity');
  assert.ok(activity.activeAgents.includes('tracking-example'));
  const transcripts=activity.agents.claude.sessions.filter((r: any)=>transcriptIds.includes(r.id));
  assert.equal(transcripts.length,2);
  assert.ok(transcripts.every((r: any)=>r.source==='transcript'&&r.phase==='thinking'&&r.headline==='Review example'&&r.timeline===true));
  const session=activity.agents['tracking-example'].sessions[0];
  assert.equal(session.id,taskId);
  assert.equal(session.phase,'interaction');
  assert.equal(session.headline,'printf example');
  assert.equal(session.timeline,true);
  const pending=(await call('agent_pending',{agent:'tracking-example',taskId})).result;
  assert.equal(pending.requests[0].params.toolCall.command,'printf example');
  const initial=await management(`agents/timeline/${taskId}`);
  assert.equal(initial.entries[0].type,'user');
  assert.ok(initial.entries.some((r: any)=>r.type==='interaction'&&r.status==='pending'));
  assert.ok(!JSON.stringify(initial).includes('fixture-secret-value'));
  const abort=new AbortController();
  try {
    const stream=await fetch(`http://127.0.0.1:${endpoint.port}/api/agents/activity/events`,{headers:{Authorization:`Bearer ${endpoint.token}`},signal:abort.signal});
    assert.equal(stream.headers.get('Content-Type'),'text/event-stream');
    const first=await stream.body!.getReader().read();
    const snapshot=JSON.parse(new TextDecoder().decode(first.value).split('data: ')[1].trim());
    assert.equal(snapshot.agents['tracking-example'].sessions[0].phase,'interaction');
  } finally {abort.abort();}
  const responded=await completed('agent_respond',{agent:'tracking-example',taskId,interactionId:'example-permission',optionId:'allow',requestId:randomUUID()});
  assert.equal(responded.state,'completed',JSON.stringify(responded));
  const settled=(await call('agent_wait',{agent:'tracking-example',taskId,timeoutMs:10000})).result;
  assert.equal(settled.state,'completed');
  const compactAgent=(await call('agent_read',{agent:'tracking-example',taskId,view:'summary'})).result;
  assert.equal(compactAgent.state,'completed');assert.equal(compactAgent.finalResponse,'All done');
  assert.equal(compactAgent.arcInbox,undefined);assert.equal(compactAgent.dispatches,undefined);assert.equal(compactAgent.reviews,undefined);

  const repeatedWait=(await call('agent_wait',{agent:'tracking-example',taskId,timeoutMs:300000,expectedHash:settled.snapshotHash,until:'terminal'})).result;
  assert.equal(repeatedWait.changed,false);assert.equal(repeatedWait.finalResponse,settled.finalResponse);
  assert.equal(repeatedWait.finalResponseUnchanged,undefined);
  const timeline=await management(`agents/timeline/${taskId}?after=${initial.cursor}`);
  assert.equal(timeline.coverage.state,'complete');
  assert.ok(timeline.entries.some((r: any)=>r.id==='example-command'&&r.exitCode===0&&r.status==='completed'));
  const text=timeline.entries.filter((r: any)=>r.type==='text');
  assert.equal(text.length,1);assert.equal(text[0].text,'All done');
  const context=(await call('agent_context',{agent:'tracking-example',taskId})).result;
  assert.equal(context.executionEvidence,true);
  assert.equal(context.evidence[0].command,'printf example');
  assert.ok(!context.coverage.missing.includes('STRUCTURED_COMMAND_EVIDENCE_UNSUPPORTED'));
  assert.ok(!(await management('agents/activity')).activeAgents.includes('tracking-example'));
});

// Local protocol acceptance uses production OAuth and management routes, without a provider.
test('source connection switching binds consent and preserves disconnected identities', async () => {
  // Regression: cross-source switch confirmation is rejected and cancellation retains the original connection.
  const create = (id: string, auth = 'oauth') => management('ingress', 'POST', { id, name: id, controlSource: 'claude', transport: 'https', auth, ...(auth === 'bearer' ? { bearerToken: 'fixture-switch-token'.padEnd(40, 'x') } : {}), toolPolicy: 'all', config: { httpsProvider: 'custom', httpsUrl: `https://${id}.example/mcp` } });
  const a = await create('switch-old'), b = await create('switch-next'), occupied = await create('switch-occupied', 'bearer');
  const url = (i: any, route: string) => `http://127.0.0.1:${i.config.httpsPort}${route}`;
  const resource = (i: any) => `https://${i.id}.example/mcp`;
  const readSource = async (id: string) => (await management('source')).sources.find((s: any) => s.id === id);
  const authorize = async (i: any) => {
    const registration = await fetch(url(i, '/oauth/register'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://client.example/callback'], token_endpoint_auth_method: 'none' }) });
    assert.equal(registration.status, 201);
    const client = await registration.json();
    const verifier = randomUUID().replaceAll('-', '').padEnd(64, 'v');
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'https://client.example/callback', response_type: 'code', resource: resource(i), state: randomUUID(), code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
    const response = await fetch(url(i, `/oauth/authorize?${query}`), { redirect: 'manual' });
    assert.equal(response.status, 303);
    const id = new URL(response.headers.get('location')!).searchParams.get('request')!;
    const pending = (await management(`ingress/${i.id}/oauth`)).pending.find((p: any) => p.id === id);
    return { id, client, verifier, pending };
  };
  const exchange = async (i: any, request: Awaited<ReturnType<typeof authorize>>) => {
    const response = await fetch(url(i, `/oauth/continue?request=${request.id}`), { redirect: 'manual' });
    assert.equal(response.status, 303);
    const code = new URL(response.headers.get('location')!).searchParams.get('code')!;
    const token = await fetch(url(i, '/oauth/token'), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: request.verifier, client_id: request.client.client_id, redirect_uri: 'https://client.example/callback', resource: resource(i) }) });
    const result = await token.json(); assert.equal(token.status, 200, JSON.stringify(result)); return result;
  };
  const access = (i: any, token: string) => fetch(url(i, '/mcp'), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  try {
    await management(`ingress/${a.id}/start`, 'POST'); await management(`ingress/${b.id}/start`, 'POST');
    const first = await authorize(a);
    await management(`source/${first.pending.sourceId}/claim`, 'POST', { sourceId: 'new' });
    const oldTokens = await exchange(a, first), sourceId = first.pending.sourceId;
    await management(`source/${sourceId}`, 'PUT', { label: 'Retained account' });
    const original = await readSource(sourceId);
    const peer = await authorize(a);
    await management(`source/${peer.pending.sourceId}/claim`, 'POST', { sourceId: 'new' });
    const peerTokens = await exchange(a, peer);
    await assert.rejects(() => management(`source/${sourceId}/switch`, 'POST', { ingressId: occupied.id }), /CONNECTION_OCCUPIED/);
    await management(`source/${sourceId}/switch`, 'POST', { ingressId: b.id });
    const denied = await authorize(b);
    assert.equal(denied.pending.switchSourceId, sourceId);
    assert.deepEqual(denied.pending.sourceCandidates, []);
    await assert.rejects(() => management(`source/${denied.pending.sourceId}/claim`, 'POST', { sourceId: 'new' }), /INVALID_SWITCH_CLAIM/);
    await management(`ingress/${b.id}/oauth/decision`, 'POST', { id: denied.id, allow: false });
    assert.equal((await readSource(sourceId)).ingressId, a.id);
    assert.equal((await readSource(sourceId)).pendingSwitch, undefined);
    assert.equal((await access(a, oldTokens.access_token)).status, 200);
    await management(`source/${sourceId}/switch`, 'POST', { ingressId: b.id });
    const canceled = await authorize(b);
    await management(`source/${sourceId}/switch`, 'DELETE');
    await assert.rejects(() => management(`source/${canceled.pending.sourceId}/claim`, 'POST', { sourceId }), /INVALID_SWITCH_CLAIM|expired/);
    assert.equal((await readSource(sourceId)).ingressId, a.id);
    await management(`source/${sourceId}/switch`, 'POST', { ingressId: b.id });
    const next = await authorize(b);
    assert.notEqual(next.client.client_id, first.client.client_id, 're-adding registers a new DCR client');
    assert.notEqual(next.client.client_id, canceled.client.client_id);
    assert.equal(next.pending.switchSourceId, sourceId, 'the target connection claims a new client for the pending switch');
    assert.deepEqual(next.pending.sourceCandidates, []);
    assert.equal((await readSource(sourceId)).pendingSwitch.requestId, next.id);
    await management(`source/${next.pending.sourceId}/claim`, 'POST', { sourceId });
    assert.equal((await access(a, oldTokens.access_token)).status, 200, 'approval alone does not bypass PKCE');
    const newTokens = await exchange(b, next);
    const moved = await readSource(sourceId);
    for (const key of ['id', 'label', 'product', 'platform', 'createdAt', 'connectedAt']) assert.deepEqual(moved[key], original[key], key);
    assert.equal(moved.ingressId, b.id); assert.equal(moved.pendingSwitch, undefined);
    assert.equal((await access(a, oldTokens.access_token)).status, 401);
    const refresh = await fetch(url(a, '/oauth/token'), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: oldTokens.refresh_token, client_id: first.client.client_id, resource: resource(a) }) });
    assert.equal(refresh.status, 400);
    assert.equal((await access(a, peerTokens.access_token)).status, 200);
    assert.equal((await access(b, newTokens.access_token)).status, 200);
    await management(`ingress/${b.id}`, 'DELETE');
    const detached = await readSource(sourceId);
    assert.equal(detached.state, 'disconnected'); assert.equal(detached.connectionRemoved, true); assert.equal(detached.label, original.label);
    await management(`source/${sourceId}/switch`, 'POST', { ingressId: a.id });
    const reattach = await authorize(a);
    await management(`source/${reattach.pending.sourceId}/claim`, 'POST', { sourceId });
    await exchange(a, reattach);
    assert.equal((await readSource(sourceId)).ingressId, a.id);
    assert.equal((await readSource(sourceId)).connectionRemoved, undefined);
    await management(`source/${peer.pending.sourceId}/disconnect`, 'POST');
    await management(`ingress/${a.id}`, 'DELETE');
    assert.equal((await readSource(peer.pending.sourceId)).state, 'revoked');
    assert.equal((await readSource(sourceId)).state, 'disconnected');
    await client.close(); await connectFixture();
    assert.equal((await readSource(sourceId)).state, 'disconnected', 'removal survives restart');
    assert.equal((await readSource(peer.pending.sourceId)).state, 'revoked');
  } finally {
    for (const i of [a, b, occupied]) if ((await management('status')).ingresses.some((row: any) => row.id === i.id)) await management(`ingress/${i.id}`, 'DELETE');
  }
});


test('frozen guide tool redirects query-only topics to query guide', async () => {
  // Regression: guide({topic:"context"}) failed with a generic schema error whose next did not name query guide.
  const {response,result}=await call('guide',{topic:'context'});
  assert.equal(response.isError,true);
  assert.equal(result.error.code,'WRONG_TOOL');
  assert.deepEqual({via:result.next.via,op:result.next.op,args:result.next.args},{via:'query',op:'guide',args:{topic:'context'}});
});

test('guide progressively discloses every enabled op and caches projected content', async () => {
  // Contract: query guide caches the source-specific view without changing frozen tools.
  const readGuide = async (args: Record<string, unknown>) => (await client.callTool({name:'query',arguments:{op:'guide',args}})).structuredContent!.result as any;
  const compact = (await call('guide')).result;
  const full = await readGuide({view:'full'});
  assert.ok(compact.ops.length < full.ops.length);
  assert.deepEqual(full.ops.map((row:any)=>row.op), operations.map(row=>row.name));
  const cached = await readGuide({knownGuideHash:compact.guideHash});
  assert.equal(cached.unchanged,true);assert.equal(cached.content,undefined);assert.equal(cached.ops,undefined);
  assert.equal((await readGuide({view:'full',knownGuideHash:compact.guideHash})).unchanged,undefined);
  assert.equal((await readGuide({view:'full',knownGuideHash:full.guideHash})).unchanged,true);
  for (const [op,canonical,legacy] of [['git','operation','action'],['git_write','operation','action'],['read','lineCount','limit']]) {
    const detail=await readGuide({op});
    assert.ok(detail.inputSchema.properties[canonical]);assert.equal(detail.inputSchema.properties[legacy],undefined);
    assert.equal((await readGuide({op,knownGuideHash:detail.guideHash})).unchanged,true);
  }
  for(const [topic,expected] of [['coordination','coordination_session'],['src','src_conversations'],['context','context_resolve']]) {
    const detail=await readGuide({topic});
    assert.ok(detail.ops.some((row:any)=>row.op===expected));
    assert.ok(!detail.ops.some((row:any)=>row.op==='command'));
  }
  const sources=(await management('source')).sources;
  const remote=sources.find((source:any)=>source.ingressId==='default');
  const local=(args:Record<string,unknown>={})=>JSON.parse(execFileSync(fixtureCommand,['cli','control','guide','--stdin'],{env:fixtureEnv,encoding:'utf8',input:JSON.stringify(args)})).result;
  const legacy=local();
  assert.equal(legacy.profile,undefined);
  const localId=legacy.sourceId;assert.ok(localId);
  try {
    await management(`source/${localId}`,'PUT',{capabilityProfile:{hostAccess:'host',waitMode:'background-cli'}});
    const code=local();
    assert.equal(code.profile.name,'local-code');assert.equal(code.profile.transport,'cli');
    const characters=[...JSON.stringify(code)].length;
    console.log('LOCAL_CODE_LAYER1_CHARACTERS '+characters);assert.ok(characters<=2500);
    assert.ok(!code.ops.some((row:any)=>['command','notify_control','coordination_session','src_conversations'].includes(row.op)));
    assert.equal(code.arcInbox,undefined);
    assert.equal(local({knownGuideHash:code.guideHash}).unchanged,true);
    assert.deepEqual(local({view:'full'}).ops.map((row:any)=>row.op),full.ops.map((row:any)=>row.op));
    assert.ok(local({op:'command'}).inputSchema);
    await management(`source/${remote.id}`,'PUT',{product:'claude',capabilityProfile:{hostAccess:'none',waitMode:'poll'}});
    const polling=await readGuide({});
    assert.equal(polling.profile.name,'remote-polling');assert.equal(polling.profile.transport,'mcp');
    assert.ok(polling.ops.some((row:any)=>row.op==='command'));assert.ok(!polling.ops.some((row:any)=>row.op==='notify_control'));
    assert.equal((await readGuide({knownGuideHash:compact.guideHash})).unchanged,undefined);
    assert.equal((await call('codex_capabilities')).response.isError,false);
    await management(`source/${remote.id}`,'PUT',{capabilityProfile:{hostAccess:'none',waitMode:'push'}});
    assert.ok((await readGuide({})).ops.some((row:any)=>row.op==='notify_control'));
    await assert.rejects(management(`source/${remote.id}`,'PUT',{capabilityProfile:{hostAccess:'host',waitMode:'background-cli'}}),/capabilityProfile/);
    assert.equal((await readGuide({})).profile.name,'remote-push');
    await management(`source/${remote.id}`,'PUT',{capabilityProfile:null,product:remote.product});
    assert.equal((await readGuide({})).guideHash,compact.guideHash);
  } finally {
    await management(`source/${localId}`,'PUT',{capabilityProfile:null});
    await management(`source/${remote.id}`,'PUT',{capabilityProfile:null,product:remote.product});
  }
});


test('control stats report byte baselines and waste candidates without call content', async()=>{
  // Contract: CLI stats control returns content-free accounting for frozen control calls.
  const guide=(await call('guide')).result;
  await call('guide');
  await client.callTool({name:'query',arguments:{op:'guide',args:{knownGuideHash:guide.guideHash}}});
  await call('read',{path:'private-metric-payload',unsupported:true});
  await call('read',{path:'private-metric-payload',unsupported:true});
  await call('projects');
  await completed('command',{cmd:'private-metric-payload',cwd:directory,requestId:randomUUID()});
  const created=await dispatchFixture('fixture-dispatch');
  await call('codex_read',{threadId:created.threadId,statusOnly:true});
  await completed('codex_review',{threadId:created.threadId,turnId:created.turnId,verdict:'pass',requestId:randomUUID()});
  const stats=JSON.parse(execFileSync(fixtureCommand,['cli','stats','control','--since','1h'],{env:fixtureEnv,encoding:'utf8'}));
  assert.equal(stats.ok,true);const r=stats.result;
  assert.equal(r.metadataOnly,true);assert.ok(r.totals.calls>0);
  assert.ok(r.bySource.every((s:any)=>s.sourceId&&s.controlSource));
  assert.ok(r.byOp.find((s:any)=>s.op==='guide').textBytes>0);
  assert.ok(r.totals.structuredContentBytes>0);assert.ok(r.byDay.length);
  assert.ok(r.wasteCandidates.lookupThenAct>0);assert.ok(r.wasteCandidates.uncachedUnchangedReads>0);assert.ok(r.wasteCandidates.argumentErrorRetries>0);
  const task=r.tasks.find((t:any)=>t.taskId===created.threadId);
  assert.equal(task.reviewed,true);assert.ok(task.calls>=3);assert.ok(task.responseBytes>0);
  assert.equal(r.profileSequences.sessionProxy,true);
  const cohorts=r.profileSequences.cohorts;
  assert.ok(cohorts.some((c:any)=>c.profile==='local-code'&&c.transport==='cli'&&c.guideResponseBytes.median>0));
  const remoteSequence=r.profileSequences.sequences.find((s:any)=>s.sourceId===created.origin?.sourceId) ?? r.profileSequences.sequences.find((s:any)=>s.profile==='legacy'&&s.transport==='mcp'&&s.callsBeforeFirstDispatch!==null);
  assert.ok(remoteSequence);assert.equal(typeof remoteSequence.callsBeforeFirstDispatch,'number');
  assert.ok(cohorts.some((c:any)=>c.invalidArguments>0&&c.argumentErrorRetries>0));
  assert.ok(!JSON.stringify(stats).includes('private-metric-payload'));
  console.log('CONTROL_BASELINE '+JSON.stringify(r.totals));
});


test('minimal MCP text is opt-in per source and preserves structured results and errors',async()=>{
  // Contract: frozen tools retain structuredContent when a source opts into minimal text.
  const before=await call('guide');
  const sources=await management('source');
  const rows=Array.isArray(sources)?sources:sources.sources;
  const source=rows.find((s:any)=>s.ingressId==='default');assert.ok(source);
  assert.equal(source.minimalText===true,false);
  await management(`source/${source.id}`,'PUT',{minimalText:true});
  try {
    const compact=await call('guide');
    assert.deepEqual(compact.result,before.result);
    assert.ok(JSON.stringify(compact.response.content).length<JSON.stringify(before.response.content).length);
    const failed=await call('read',{unsupported:true});
    assert.equal(failed.response.isError,true);assert.equal(failed.result.error.code,'INVALID_ARGUMENTS');
    assert.ok((failed.response.content[0] as any).text.includes(failed.result.error.code));
    const local=JSON.parse(execFileSync(fixtureCommand,['cli','control','guide'],{env:fixtureEnv,encoding:'utf8'}));
    assert.equal(local.ok,true);assert.ok(local.result.content);
  } finally {await management(`source/${source.id}`,'PUT',{minimalText:false});}
  const restored=await call('guide');
  assert.deepEqual(JSON.parse((restored.response.content[0] as any).text),restored.result);
  assert.equal(restored.result.guideHash,before.result.guideHash);
});


test('compact read defaults to the latest turn and item keys avoid duplicate complete items',async()=>{
  // Regression: default history and repeated item reads duplicated already returned task content.
  const read=(await call('codex_read',{threadId:'response-size',includeItemKeys:true})).result;
  assert.equal(read.turns.length,1);assert.equal(read.turns[0].turnId,'size-turn-5');assert.ok(read.nextCursor);
  const history=(await call('codex_read',{threadId:'response-size',limit:6})).result;
  assert.equal(history.turns.length,6);
  const next=(await call('codex_read',{threadId:'response-size',cursor:read.nextCursor})).result;
  assert.equal(next.turns[0].turnId,'size-turn-4');
  const keys=read.turns[0].items.map((i:any)=>i.itemKey);assert.ok(keys.every(Boolean));
  const args={threadId:'response-size',turnId:read.turns[0].turnId,knownItemKeys:keys};
  const skipped=(await call('codex_items',args)).result;
  assert.deepEqual(skipped.items,[]);assert.equal(skipped.omittedKnownItems,1);assert.ok(skipped.nextCursor);
  const all=(await call('codex_items',{...args,limit:50})).result;
  assert.deepEqual(all.items,[]);assert.equal(all.omittedKnownItems,4);
  const other=(await call('codex_items',{...args,turnId:'size-turn-4',limit:50})).result;
  assert.equal(other.items.length,4);
  await completed('codex_call',{method:'fixture/change-size-item',params:{},requestId:randomUUID()});
  const changed=(await call('codex_items',{...args,includeItemKeys:true,limit:50})).result;
  assert.equal(changed.items.length,1);assert.ok(!keys.includes(changed.items[0].itemKey));
  const short=(await call('codex_items',{threadId:'response-size',limit:50,length:2,includeItemKeys:true})).result;
  assert.ok(short.items.filter((i:any)=>i.truncated).every((i:any)=>!i.itemKey));
  assert.equal((await call('codex_items',{...args,view:'full'})).result.error.code,'INVALID_ARGUMENTS');
});

test('command output budgets preserve complete stdout and stderr through control_output',async()=>{
  // Contract: command receipts retain exit status and expose complete paged output when budgeted.
  for(const args of [{cmd:'fixture-budget',cwd:directory},{action:'exec',params:{command:['fixture-budget'],cwd:directory}}]) {
    const receipt=await completed('command',{...args,outputBudget:33,requestId:randomUUID()});
    const r=receipt.result;assert.equal(receipt.state,'completed');assert.equal(r.exitCode,0);assert.equal(r.truncated,true);
    assert.ok(Buffer.byteLength(r.stdout)+Buffer.byteLength(r.stderr)<=33);
    let text='',offset:number|null=0;
    while(offset!==null){const page=(await call('control_output',{outputId:r.output.outputId,offset,length:20})).result;text+=page.text;offset=page.nextOffset;}
    const complete=JSON.parse(text);assert.equal(complete.stdout,'é'.repeat(40));assert.equal(complete.stderr,'err'.repeat(20));
    const replay=(await call('receipt',{requestId:receipt.requestId})).result;
    assert.equal(replay.result.output.outputId,r.output.outputId);
  }
  const legacy=await completed('command',{cmd:'fixture-budget',cwd:directory,requestId:randomUUID()});
  assert.equal(legacy.result.stdout,'é'.repeat(40));assert.equal(legacy.result.truncated,false);
  const zero=await completed('command',{cmd:'fixture-budget',cwd:directory,outputBudget:0,requestId:randomUUID()});
  assert.equal(zero.result.stdout,'');assert.equal(zero.result.stderr,'');assert.ok(zero.result.output.outputId);
});

test('command subprocesses retain source attribution and local commands clear inherited submitters',async()=>{
  // Regression: CLI replacement launched through command lost the originating control source before creating its journal.
  for(const args of [{cmd:'fixture-origin',cwd:directory},{action:'exec',params:{command:['fixture-origin'],cwd:directory,env:{CUSTOM_VARIABLE:'kept',ARC_COMMAND_SUBMITTER:'stale'}}}]) {
    const receipt=await completed('command',{...args,requestId:randomUUID()});
    assert.equal(receipt.state,'completed');
    const env=JSON.parse(receipt.result.stdout);
    const context=JSON.parse(env.ARC_COMMAND_SUBMITTER);
    const original=(await call('receipt',{requestId:receipt.requestId,includeOrigin:true})).result;
    assert.equal(context.origin.sourceId,original.origin.sourceId);
    assert.equal(context.origin.controlSource,original.origin.controlSource);
    if('params' in args)assert.equal(env.CUSTOM_VARIABLE,'kept');
  }
  const local=JSON.parse(execFileSync(fixtureCommand,['cli','control','command','--stdin'],{env:fixtureEnv,input:JSON.stringify({action:'exec',params:{command:['fixture-origin'],cwd:directory,env:{CUSTOM_VARIABLE:'kept',ARC_COMMAND_SUBMITTER:'stale'}}}),encoding:'utf8'}));
  assert.equal(local.ok,true);
  assert.equal(local.result.state,'completed');
  const env=JSON.parse(local.result.result.stdout);
  assert.equal(env.ARC_COMMAND_SUBMITTER,null);
  assert.equal(env.CUSTOM_VARIABLE,'kept');
});

test('receipt next hashes omit repeated guidance only when explicitly supplied',async()=>{
  // Contract: opt-in next caching keeps legacy receipt follow-up arguments available by default.
  const created=await dispatchFixture('fixture-dispatch');
  const first=(await call('receipt',{requestId:created.requestId})).result;
  assert.ok(first.next.hash);assert.equal(first.next.op,'codex_wait');
  const cached=(await call('receipt',{requestId:created.requestId,knownNextHash:first.next.hash})).result;
  assert.equal(cached.next.unchanged,true);assert.equal(cached.next.op,undefined);assert.equal(cached.next.hash,first.next.hash);
  const fresh=(await call('receipt',{requestId:created.requestId,knownNextHash:'outdated'})).result;
  assert.deepEqual(fresh.next,first.next);
});


test('review read returns complete outcomes without command outputs or intermediate messages',async()=>{
  // Regression: compact review returned command output while truncating the final response.
  const {result:r,response}=await call('codex_read',{threadId:'review-outcomes',view:'review',includeImages:true});
  assert.equal(response.isError,false);assert.equal(r.nextCursor,'history-cursor');assert.equal(r.arcInbox,undefined);
  const turn=r.turns[0];assert.equal(turn.recordedStatus,'completed');
  assert.equal(turn.finalResponse,'Complete final response. '.repeat(100));
  assert.deepEqual(turn.files,[{path:'src/example.rs',added:3,removed:1}]);
  assert.equal(turn.checks.length,2);assert.equal(turn.checks[0].command,"npm run check; node --test --test-name-pattern='review|full' checks.test.ts > check.log 2>&1");assert.equal(turn.checks[0].exitCode,1);
  assert.ok(turn.checks.every((c:any)=>typeof c.summary==='string'&&!c.summary.includes('\n')));
  assert.equal(turn.checks[1].command,'cargo check');assert.ok(!JSON.stringify(r).includes('PRIVATE_COMMAND_OUTPUT'));assert.ok(!JSON.stringify(r).includes('After final commentary'));
  assert.equal(turn.items,undefined);assert.equal(turn.externalUserInputs,undefined);
  const compact=(await call('codex_read',{threadId:'review-outcomes',view:'compact'})).result;
  assert.ok(compact.turns[0].items.some((i:any)=>i.output));
  const full=(await call('codex_read',{threadId:'review-outcomes',view:'full'})).result;
  assert.ok(full.turns[0].items.some((i:any)=>i.text.includes('PRIVATE_COMMAND_OUTPUT')));
});


test('historical review file counts stop at the next clean turn baseline',async()=>{
  // Regression: live workspace diffs included changes made after the reviewed turn.
  const project=path.join(directory,'review-history');await mkdir(project);
  const git=(...args:string[])=>execFileSync('git',['-C',project,...args],{stdio:'pipe'});
  const commit=(subject:string)=>{git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgSign=false','commit','-m',subject);};
  git('init');await writeFile(path.join(project,'first.txt'),'before\n');commit('test: seed history');
  const created=await completed('codex_create',{project,prompt:'harmless fixture',thread:{model:'fixture-dispatch-queue'},purpose:'self-test',notify:null,requestId:randomUUID()});
  assert.equal(created.state,'completed');
  await writeFile(path.join(project,'first.txt'),'after\n');commit('test: complete reviewed work');
  await completed('codex_call',{method:'fixture/finish-turn',params:{threadId:created.threadId},requestId:randomUUID()});
  const sent=await completed('codex_send',{threadId:created.threadId,prompt:'next harmless turn',purpose:'self-test',notify:null,requestId:randomUUID()});assert.equal(sent.state,'completed');
  await writeFile(path.join(project,'later.txt'),'later\n');commit('test: add later work');
  const latest=(await call('codex_read',{threadId:created.threadId,view:'review'})).result;
  const previous=(await call('codex_read',{threadId:created.threadId,view:'review',cursor:latest.nextCursor})).result;
  assert.equal(previous.turns[0].turnId,created.turnId);
  assert.deepEqual(previous.turns[0].files,[{path:'first.txt',added:1,removed:1}]);
  const pinned=(await call('codex_read',{threadId:created.threadId,turnId:created.turnId,view:'review'})).result;
  assert.equal(pinned.turns[0].turnId,created.turnId);assert.deepEqual(pinned.turns[0].files,previous.turns[0].files);
  const summary=(await call('codex_read',{threadId:created.threadId,turnId:created.turnId,view:'summary'})).result;
  assert.equal(summary.turnId,created.turnId);assert.deepEqual(summary.files,previous.turns[0].files);assert.deepEqual(summary.diffstat,{files:1,added:1,removed:1,unknown:0});

});

test('lane summaries retain committed paths and diffstat across CLI and MCP dispatch and workspace removal',async()=>{
  // Regression: lane task summaries missed committed files and removed lanes returned GIT_QUERY_FAILED or empty reviews.
  for(const source of ['cli','mcp']) {
    const project=path.join(directory,`summary-lane-${source}`);await mkdir(project);
    const common=path.join(directory,`summary-objects-${source}`);
    const git=(...args:string[])=>execFileSync('git',['-C',project,...args],{stdio:'pipe'});
    const commit=(subject:string)=>{git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgSign=false','commit','-m',subject);};
    git('init',`--separate-git-dir=${common}`);
    await writeFile(path.join(project,'first.txt'),'before\n');commit('test: seed lane');
    const args={project,prompt:'harmless fixture',thread:{model:'fixture-dispatch-queue'},purpose:'self-test',notify:null,requestId:randomUUID()};
    const created=source==='mcp'?await completed('codex_create',args):JSON.parse(execFileSync(fixtureCommand,['cli','control','codex_create','--stdin'],{env:fixtureEnv,input:JSON.stringify(args),encoding:'utf8'})).result;
    assert.equal(created.state,'completed');assert.ok(created.turnId);
    await writeFile(path.join(project,'first.txt'),'after\n');
    await writeFile(path.join(project,'new.txt'),'one\ntwo\n');commit('test: finish lane work');
    // The event must save evidence before any summary/changes read or notification binding.
    await completed('codex_call',{method:'fixture/finish-with-pending',params:{threadId:created.threadId},requestId:randomUUID()});
    const expected=[{path:'first.txt',added:1,removed:1},{path:'new.txt',added:2,removed:0}];
    if(source==='cli') {
      const live=JSON.parse(execFileSync(fixtureCommand,['cli','control','codex_read','--stdin'],{env:fixtureEnv,input:JSON.stringify({threadId:created.threadId,turnId:created.turnId,view:'summary'}),encoding:'utf8'})).result;
      assert.deepEqual(live.files,expected);assert.deepEqual(live.diffstat,{files:2,added:3,removed:1,unknown:0});
    }
    await writeFile(path.join(project,'later.txt'),'unrelated\n');commit('test: later unrelated work');
    await rm(project,{recursive:true});
    for(const op of ['codex_read','codex_wait']) {
      const summary=(await call(op,{threadId:created.threadId,turnId:created.turnId,view:'summary',...(op==='codex_wait'?{timeoutMs:1000}:{})})).result;
      assert.deepEqual(summary.files,expected);assert.deepEqual(summary.diffstat,{files:2,added:3,removed:1,unknown:0});
      assert.equal(summary.changeEvidence,'terminal-git-snapshot');
    }
    const changes=(await call('codex_changes',{threadId:created.threadId,turnId:created.turnId,limit:1})).result;
    assert.equal(changes.fallback,false);assert.equal(changes.commitCount,1);assert.equal(changes.summary.files,2);assert.equal(changes.summary.added,3);
    const diff=(await call('codex_changes',{threadId:created.threadId,turnId:created.turnId,path:'first.txt',length:12})).result;
    assert.ok(diff.diff.text);assert.equal(diff.diff.text.length,12);assert.ok(diff.diff.nextOffset);
    const review=(await call('codex_read',{threadId:created.threadId,turnId:created.turnId,view:'review'})).result;
    assert.deepEqual(review.turns[0].files,expected);
    await rm(common,{recursive:true});
    const missingPatch=(await call('codex_changes',{threadId:created.threadId,turnId:created.turnId,path:'first.txt'})).result;
    assert.equal(missingPatch.summary.files,2);assert.equal(missingPatch.diff,null);assert.ok(missingPatch.diffUnavailable);assert.ok(missingPatch.next.hint);
  }
});

test('terminal snapshots preserve uncommitted text and binary statistics after workspace removal',async()=>{
  // Regression: live-only lane evidence lost untracked changes when a terminal workspace was removed.
  const project=path.join(directory,'dirty-summary-lane');await mkdir(project);
  execFileSync('git',['init',project],{stdio:'pipe'});
  const created=await completed('codex_create',{project,prompt:'harmless fixture',thread:{model:'fixture-dispatch-queue'},purpose:'self-test',notify:null,requestId:randomUUID()});
  await writeFile(path.join(project,'draft.txt'),'draft\n');await writeFile(path.join(project,'asset.bin'),Buffer.from([0,255]));
  const live=(await call('codex_changes',{threadId:created.threadId,turnId:created.turnId,path:'draft.txt'})).result;
  assert.match(live.diff.text,/\+draft/);
  // Terminal polling also captures evidence when an owner does not emit an event.
  await completed('codex_call',{method:'fixture/finish-turn',params:{threadId:created.threadId},requestId:randomUUID()});
  const summary=(await call('codex_read',{threadId:created.threadId,turnId:created.turnId,view:'summary'})).result;
  assert.deepEqual(summary.diffstat,{files:2,added:1,removed:0,unknown:1});
  await rm(project,{recursive:true});
  const changes=(await call('codex_changes',{threadId:created.threadId,turnId:created.turnId,path:'draft.txt'})).result;
  assert.equal(changes.summary.files,2);assert.equal(changes.summary.binaryOrUnreadable,1);assert.equal(changes.diff,null);assert.ok(changes.next.hint);
});

test('removed lane without terminal evidence reports an explicit gap instead of an empty success',async()=>{
  // Regression: querying a removed lane without a snapshot leaked GIT_QUERY_FAILED or silently reported zero files.
  const project=path.join(directory,'missing-summary-lane');await mkdir(project);
  execFileSync('git',['init',project],{stdio:'pipe'});
  const created=await completed('codex_create',{project,prompt:'harmless fixture',thread:{model:'fixture-dispatch-queue'},purpose:'self-test',notify:null,requestId:randomUUID()});
  await rm(project,{recursive:true});
  await completed('codex_call',{method:'fixture/finish-turn',params:{threadId:created.threadId},requestId:randomUUID()});
  const changes=(await call('codex_changes',{threadId:created.threadId,turnId:created.turnId})).result;
  assert.equal(changes.files,null);assert.equal(changes.summary,null);assert.ok(changes.reason);assert.ok(changes.next.hint);assert.equal(changes.error,undefined);
  const review=(await call('codex_read',{threadId:created.threadId,turnId:created.turnId,view:'review'})).result.turns[0];
  assert.equal(review.files,null);assert.ok(review.reason);assert.ok(review.next.hint);
  const summary=(await call('codex_wait',{threadId:created.threadId,turnId:created.turnId,view:'summary',timeoutMs:1000})).result;
  assert.equal(summary.files,null);assert.equal(summary.diffstat,null);assert.match(summary.changeEvidence,/unavailable/);assert.ok(summary.changeCorrection.hint);
});

test('AX binary transfers verify bytes and reject duplicate append offsets', async () => {
  // Regression: hand-copied base64 silently corrupted host files and append retries duplicated bytes.
  const file = path.join(directory, 'binary-transfer.bin');
  const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
  const first = Buffer.from([0, 255, 128, 10]);
  const second = Buffer.from([42, 0, 1]);
  const joined = Buffer.concat([first, second]);
  const write = (params: Record<string, unknown>, requestId = randomUUID()) => completed('fs', {action:'writeFile',params:{path:file,...params},requestId});
  assert.equal((await write({dataBase64:first.toString('base64'),expectedSha256:sha(first)})).result.sha256, sha(first));
  const bad = await write({dataBase64:second.toString('base64'),append:true,offset:first.length,expectedSha256:sha(first)});
  assert.equal(bad.state, 'failed');
  assert.match(bad.error.message, /SHA256_MISMATCH/);
  assert.deepEqual(await readFile(file), first);
  const params = {dataBase64:second.toString('base64'),append:true,offset:first.length,expectedSha256:sha(joined)};
  const request = randomUUID();
  assert.equal((await write(params, request)).result.sizeBytes, joined.length);
  assert.equal((await write(params, request)).result.sizeBytes, joined.length);
  assert.equal((await write(params)).state, 'failed');
  assert.equal((await write({dataBase64:'YQ==',append:'true',offset:joined.length})).state,'failed');
  assert.equal((await write({dataBase64:'YQ==',append:false,offset:joined.length})).state,'failed');
  assert.deepEqual(await readFile(file), joined);
  const invalid = await completed('fs', {action:'fetchFile', params:{path:file,url:'http://example.invalid/file'}, requestId:randomUUID()});
  assert.equal(invalid.state, 'failed');
  assert.match(invalid.error.message, /INVALID_URL/);
  const guide = (await call('guide')).result;
  assert.ok(guide.ops.some((op: any) => op.op === 'write'));
  assert.ok(guide.ops.some((op: any) => op.op === 'fs'));
});

test('AX omitted request IDs return reusable receipts', async () => {
  // Regression: the live guide required agents to generate a UUID even though receipt owners already generate one.
  const params = {path:path.join(directory,'generated-id.bin'),dataBase64:'aGk=',append:true,offset:0};
  const first = (await call('fs',{action:'writeFile',params})).result;
  assert.match(first.requestId, /^[0-9a-f-]{36}$/);
  const replay = await completed('fs',{action:'writeFile',params,requestId:first.requestId});
  assert.equal(replay.requestId,first.requestId);
  assert.equal(replay.state,'completed');
  assert.equal(replay.result.sizeBytes,2);
  assert.deepEqual(await readFile(params.path),Buffer.from('hi'));
  const detail = (await call('guide',{op:'fs'})).result;
  assert.equal(detail.retry.serverGeneratedWhenOmitted,true);
  assert.equal(detail.retry.callerGenerated,false);
  assert.ok(!detail.inputSchema.required.includes('requestId'));
});

test('AX status revisits and wait timeouts expose bounded progress evidence', async () => {
  // Regression: statusOnly hid all progress during multi-hour tasks and wait timeouts offered no commit/check evidence.
  const reviewed = (await call('codex_read',{threadId:'review-outcomes',statusOnly:true})).result;
  assert.equal(reviewed.turns,null);
  assert.equal(reviewed.progress.latestAgentMessage,'After final commentary');
  assert.deepEqual(reviewed.progress.latestChecks.map((c:any)=>c.exitCode),[1,0]);
  assert.equal(reviewed.progress.commits,null);
  assert.ok(!JSON.stringify(reviewed.progress).includes('PRIVATE_COMMAND_OUTPUT'));
  const project = path.join(directory,'progress-project');
  await mkdir(project);
  const git = (args:string[]) => execFileSync('git',['-c','commit.gpgsign=false','-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{cwd:project,encoding:'utf8'}).trim();
  git(['init','--quiet']); git(['commit','--allow-empty','-m','baseline']);
  const task = await completed('codex_create',{project,prompt:'harmless fixture',thread:{model:'fixture-dispatch-queue'},purpose:'self-test',notify:null,requestId:randomUUID()});
  assert.equal(task.state,'completed');
  git(['commit','--allow-empty','-m','progress']);
  const commit = git(['rev-parse','HEAD']);
  const status = (await call('codex_read',{threadId:task.threadId,statusOnly:true})).result;
  assert.equal(status.progress.turnId,task.turnId);
  assert.equal(status.progress.latestAgentMessage,'pong');
  assert.equal(status.progress.commits.count,1);
  assert.equal(status.progress.commits.recent[0].sha,commit);
  assert.equal(status.progress.pendingInteractionCount,0);
  assert.ok(status.progress.elapsedMs >= 0);
  const wait = (await call('codex_wait',{threadId:task.threadId,turnId:task.turnId,timeoutMs:200})).result;
  assert.equal(wait.state,'timeout');
  assert.equal(wait.progress.latestAgentMessage,'pong');
  assert.equal(wait.progress.commits.count,1);
  await call('codex_call',{method:'fixture/finish-turn',params:{threadId:task.threadId},requestId:randomUUID()});
});

test('AX CLI explicitly targets an isolated instance without installed fallback', async () => {
  // Regression: CLI acceptance commands could not explicitly select a separate debug instance.
  const selected = JSON.parse(execFileSync(fixtureCommand,['cli','--state-dir',stateDir,'control','guide'],{env:fixtureEnv,encoding:'utf8'}));
  assert.equal(selected.ok,true);
  assert.ok(selected.result.ops.some((op:any)=>op.op==='codex_read'));
  const empty = path.join(directory,'empty-instance');
  await mkdir(empty);
  let failed: any;
  try { execFileSync(fixtureCommand,['cli','--state-dir',empty,'control','guide'],{env:fixtureEnv,encoding:'utf8',stdio:['pipe','pipe','pipe']}); }
  catch (error) { failed = JSON.parse((error as any).stdout); }
  assert.equal(failed.ok,false);
  assert.equal(failed.error.code,'APP_UNAVAILABLE');
  assert.equal((await call('guide')).response.isError,false);
});

test('AX topic guides return relevant operations and cache each view separately', async () => {
  // Regression: every topic guide repeated the entire operation catalog during long control loops.
  const guide = async (args: Record<string,unknown>) => ((await client.callTool({name:'query',arguments:{op:'guide',args}})).structuredContent as any).result;
  for (const [topic,required] of [['notify','notify_control'],['review','codex_review'],['approvals','codex_respond']]) {
    const scoped = await guide({topic});
    assert.equal(scoped.indexScope,'topic');
    assert.ok(scoped.ops.some((op:any)=>op.op===required));
    assert.ok(!scoped.ops.some((op:any)=>op.op==='fs'));
    const full = await guide({topic,view:'full'});
    assert.ok(full.ops.some((op:any)=>op.op==='fs'));
    assert.ok(full.ops.length > scoped.ops.length);
    assert.equal((await guide({topic,knownGuideHash:scoped.guideHash})).unchanged,true);
    assert.equal((await guide({topic,view:'full',knownGuideHash:scoped.guideHash})).unchanged,undefined);
    assert.equal((await guide({topic,view:'full',knownGuideHash:full.guideHash})).unchanged,true);
  }
});

test('AX unbound cloud-session verification explains binding and its next call', async () => {
  // Regression: notify_control verify returned a bare target-not-bound error with no usable recovery flow.
  const target = 'session_010000000000000000000010';
  const response = await call('notify_control',{action:'verify',target});
  assert.equal(response.response.isError,true);
  const error = response.result.error;
  assert.equal(error.code,'NOTIFICATION_TARGET_NOT_BOUND_TO_SOURCE');
  assert.deepEqual(response.result.next.args,{action:'bind',target});
  assert.equal(response.result.next.via,'act');
  assert.equal(response.result.next.op,'notify_control');
  assertNextCalls(response.result);
});

test('AX2 failed receipts report failure through MCP and CLI without losing identity', async () => {
  // Regression: a failed receipt returned CLI exit zero and ok:true while only its nested state showed failure.
  const requestId = randomUUID();
  const params = {path:path.join(directory,'bad-transfer'),dataBase64:'aGk=',expectedSha256:'0'.repeat(64)};
  const response = await call('fs',{action:'writeFile',params,requestId});
  assert.equal(response.response.isError,true);
  assert.equal(response.result.state,'failed');
  assert.equal(response.result.requestId,requestId);
  const visible=JSON.parse((response.response.content[0] as any).text);
  assert.equal(visible.requestId,requestId);assert.equal(visible.next.op,'receipt');
  assert.match(response.result.error.message,/SHA256_MISMATCH/);
  let failure: any;
  try { execFileSync(fixtureCommand,['cli','control','receipt','--stdin'],{env:fixtureEnv,input:JSON.stringify({requestId}),encoding:'utf8',stdio:['pipe','pipe','pipe']}); }
  catch (error) { failure=error; }
  assert.equal(failure.status,1);
  const envelope=JSON.parse(failure.stdout);
  assert.equal(envelope.ok,false);
  assert.equal(envelope.result.requestId,requestId);
  assert.match(envelope.error.message,/SHA256_MISMATCH/);
  assert.equal(envelope.result.error,undefined);assert.equal(envelope.result.result.error,undefined);
  assert.equal(response.result.result.error,undefined);
  const command=await completed('command',{cmd:'fixture-failed-command',cwd:directory,requestId:randomUUID()});
  assert.equal(command.error.exitCode,7);
});


test('AX2 CLI guides accept full views and subcommands expose help without execution', async () => {
  // Regression: CLI rejected query-guide view:full and treated subcommand --help as an invalid invocation.
  const cli=(args:string[],input?:unknown)=>JSON.parse(execFileSync(fixtureCommand,['cli',...args],{env:fixtureEnv,input:input?JSON.stringify(input):undefined,encoding:'utf8',stdio:['pipe','pipe','pipe']}));
  const full=cli(['control','guide','--stdin'],{view:'full'});
  assert.equal(full.ok,true);
  assert.ok(full.result.ops.some((op:any)=>op.op==='write'));
  const cached=cli(['control','guide','--stdin'],{view:'full',knownGuideHash:full.result.guideHash});
  assert.equal(cached.result.unchanged,true);
  for(const command of [['app','replace'],['app','snapshot'],['wait'],['control'],['source','update']]) {
    const help=cli([...command,'--help']);assert.equal(help.ok,true);assert.ok(help.result.commands.length>0);
  }
});


test('AX2 oversized results retain identity and can be completely continued', async () => {
  // Regression: large native responses flooded compact calls instead of yielding a bounded continuation.
  const response=await call('codex_call',{method:'fixture/large-response',params:{body:'x'.repeat(30000)},requestId:randomUUID()});
  const result=response.result;
  assert.ok(result.outputId);assert.ok(Buffer.byteLength(JSON.stringify(result))<12000);
  let text='',offset:number|null=0;
  while(offset!==null){const page=(await call('control_output',{outputId:result.outputId,offset,length:8192})).result;text+=page.text;offset=page.nextOffset;}
  assert.ok(JSON.parse(text).result.echoedParams.body.length===30000);
});


test('AX2 status reads agree with wait observations and nonterminal receipts have next steps', async () => {
  // Regression: statusOnly omitted execution state while reserved and thread-created receipts had no actionable next.
  assert.equal((await call('inbox_wait',{timeoutMs:0})).response.isError,false);
  const task=await dispatchFixture('fixture-dispatch-queue');
  const status=(await call('codex_read',{threadId:task.threadId,statusOnly:true})).result;
  assert.equal(status.state,'running');assert.equal(status.stateScope,'turn');assert.equal(status.next.op,'codex_wait');
  const wait=(await call('codex_wait',{threadId:task.threadId,turnId:task.turnId,timeoutMs:100})).result;
  assert.equal(wait.runtimeStatus,status.runtimeStatus);assert.equal(wait.recordedStatus,status.recordedStatus);
  const receipt=(await call('receipt',{requestId:task.requestId})).result;
  assert.equal(receipt.stateScope,'operation');assert.equal(receipt.state,'completed');
  const pending=await call('codex_call',{method:'fixture/slow-submission',params:{delay:300},waitMs:1,requestId:randomUUID()});
  assert.equal(pending.result.next.op,'receipt');
  const failure=await call('fs',{action:'writeFile',params:{path:path.join(directory,'stalled-failure'),dataBase64:'aGk=',expectedSha256:'0'.repeat(64)}});
  assert.equal(failure.result.next.op,'receipt');
  await completed('codex_call',{method:'fixture/finish-turn',params:{threadId:task.threadId},requestId:randomUUID()});
});


test('AX2 interrupt resolves the active turn and preserves explicit IDs and retry identity', async () => {
  // Regression: interrupt required a separate native read solely to obtain the active turnId.
  const task=await dispatchFixture('fixture-dispatch-queue');
  const args={threadId:task.threadId,requestId:randomUUID()};
  const stopped=await completed('codex_interrupt',args);
  assert.equal(stopped.state,'completed');assert.equal(stopped.turnId,task.turnId);
  const replay=await completed('codex_interrupt',args);assert.equal(replay.turnId,task.turnId);
  const idle=await call('codex_interrupt',{threadId:task.threadId});
  assert.equal(idle.response.isError,true);assert.match(idle.result.error.message,/NO_ACTIVE_TURN/);
  const other=await dispatchFixture('fixture-dispatch-queue');
  const explicit=await completed('codex_interrupt',{threadId:other.threadId,turnId:other.turnId,requestId:randomUUID()});
  assert.equal(explicit.turnId,other.turnId);
});


test('AX2 pending progress and flat answered history expose question content', async () => {
  // Regression: interaction previews only said Interaction required and answered history required nested expansion.
  const created=await dispatchFixture('fixture-dispatch-question');
  const pending=await eventually(async()=>(await call('codex_pending',{threadId:created.threadId})).result,r=>r.requests?.length>0);
  const request=pending.requests[0];assert.equal(request.questionSummary.questions[0].question,'2+2?');
  const status=(await call('codex_read',{threadId:created.threadId,statusOnly:true})).result;
  assert.equal(status.progress.pendingInteractions[0].questions[0].question,'2+2?');
  await completed('codex_respond',{id:request.responseId,backendSession:request.backendSession,result:{answers:{q:{answers:['4']}}},requestId:randomUUID()});
  const history=(await call('codex_interactions',{threadId:created.threadId})).result;
  assert.equal(history.total,1);assert.equal(history.interactions[0].questions[0].question,'2+2?');
  assert.deepEqual(history.interactions[0].response.result.answers.q.answers,['4']);
  assert.ok(history.interactions[0].response.origin.controlSource);
});


test('AX2 archive supports ended ARC threads and explains active or external writer blocks', async () => {
  // Regression: Desktop-created self-test threads had no ARC archival path and writer errors did not explain cleanup recovery.
  const task=await dispatchFixture('fixture-dispatch');
  const archived=await completed('codex_archive',{threadId:task.threadId,requestId:randomUUID()});
  assert.equal(archived.state,'completed');assert.equal(archived.result.archived,true);
  const busy=await dispatchFixture('fixture-dispatch-archive-busy');
  const blocked=await call('codex_archive',{threadId:busy.threadId});
  assert.equal(blocked.response.isError,true);assert.equal(blocked.result.error.code,'ARCHIVE_WRITER_BUSY');
  assert.equal(blocked.result.next.args.threadId,busy.threadId);
  assert.equal(blocked.result.error.nativeError,undefined);
  assert.equal(blocked.result.error.nativeCode,-32600);
  const active=await dispatchFixture('fixture-dispatch-queue');
  const rejected=await call('codex_archive',{threadId:active.threadId});
  assert.equal(rejected.result.error.code,'ARCHIVE_ACTIVE_TURN');
  await completed('codex_interrupt',{threadId:active.threadId,requestId:randomUUID()});
  assert.equal((await completed('codex_archive',{threadId:active.threadId,requestId:randomUUID()})).result.archived,true);
});


test('AX2 local follow-ups accept self-test purpose and inherit it without binding notifications', async () => {
  // Regression: UI follow-ups lost self-test purpose and could create normal dispatch samples or notification bindings.
  const created=await dispatchFixture('fixture-dispatch');
  for(const purpose of ['self-test',undefined]) {
    const sent=await management('tasks/control','POST',{op:'codex_send',args:{threadId:created.threadId,prompt:'local self-test',sendMode:'next',purpose,requestId:randomUUID()}});
    assert.equal(sent.state,'completed');assert.equal(sent.arguments.purpose,'self-test');assert.equal(sent.arguments.notify,null);
  }
});


test('AX3 release hands off an idle connector thread without closing another owner',async()=>{
  // Regression: control sources had no supported per-thread release operation before archive.
  const task=await dispatchFixture('fixture-dispatch');
  const release=await completed('codex_release',{threadId:task.threadId,requestId:randomUUID()});
  assert.equal(release.result.released,true);
  const archive=await completed('codex_archive',{threadId:task.threadId,release:true,requestId:randomUUID()});
  assert.equal(archive.result.archived,true);
});


test('AX3 cloud binding is discoverable before dispatch and repairs an unbound task', async () => {
  // Regression: cloud controls had no bound target or verification attempts and had to resubmit work to bind.
  const guide=await call('guide',{});
  assert.ok(guide.result.ops.some((o:any)=>o.op==='notify_control'));
  const target='session_010000000000000000000008';
  const bound=await call('notify_control',{action:'bind',target,verify:false});
  assert.equal(bound.result.bound,true,JSON.stringify(bound.result));assert.equal(bound.result.taskBound,false);
  const status=await call('notify_status',{target});
  assert.equal(status.result.targets[0].registered,true);assert.equal(status.result.targets[0].verificationAttempts,0);
  const created=await dispatchFixture('fixture-dispatch');
  const repaired=await call('notify_control',{action:'bind',target,threadId:created.threadId,verify:false});
  assert.equal(repaired.result.taskBound,true,JSON.stringify(repaired.result));
  const task=await call('notify_status',{threadId:created.threadId});
  assert.equal(task.result.threads[0].target,target);
  const settings=await management('task-settings');
  try {
    await management('task-settings','PUT',{notificationsEnabled:false});
    const attempted=await call('notify_control',{action:'bind',target:'session_010000000000000000000007'});
    assert.equal(attempted.response.isError,true);assert.equal(attempted.result.bound,true);
    assert.match(attempted.result.error.message,/NOTIFICATIONS_DISABLED/);
    const disabledTarget='session_010000000000000000000007';
    const disabledStatus=(await call('notify_status',{target:disabledTarget})).result.targets[0];
    assert.equal(disabledStatus.registered,true);
    assert.equal(disabledStatus.verificationAttempts,0);
    const verification=await call('notify_control',{action:'verify',target:disabledTarget,accountId:'missing-profile'});
    assert.equal(verification.response.isError,true);
    assert.match(verification.result.error.message,/NOTIFICATIONS_DISABLED/);
    const route=await call('notify_control',{action:'route',target:disabledTarget});
    assert.equal(route.response.isError,false);
    assert.equal(route.result.accountId,null);
    const unbound=await call('notify_control',{action:'verify',target:'session_010000000000000000000006'});
    assert.equal(unbound.result.error.code,'NOTIFICATION_TARGET_NOT_BOUND_TO_SOURCE');
  } finally {await management('task-settings','PUT',settings);}
});


test('Public failures provide a usable next without serialized duplicate reasons',async()=>{
  // Regression: verify failures emitted next:null and archive errors repeated serialized RPC errors.
  const target='session_010000000000000000000009';
  const saved=await management('task-settings');
  try {
    await call('notify_control',{action:'bind',target,verify:false});
    await management('task-settings','PUT',{notificationsEnabled:false});
    const failed=await call('notify_control',{action:'verify',target});
    assert.equal(failed.response.isError,true);assert.ok(failed.result.next.op);assertNextCalls(failed.result);
    const guide=await call(failed.result.next.op,failed.result.next.args);assert.equal(guide.response.isError,false);
  }finally{await management('task-settings','PUT',saved);}
});

test('app_env persists per instance, reads back and clears without exporting preferences', async () => {
  // Contract: the frozen act envelope carries instance environment set/read/clear and validates inputs.
  const preferences = await management('preferences');
  const args = { action: 'set', reducedMotion: true, colorScheme: 'dark', locale: 'zh-CN', windowWidth: 320, taskPanelWidth: 320, presence: 'present', clock: { freeze: true } };
  const set = await call('app_env', args);
  assert.equal(set.response.isError, false);
  assert.equal(set.result.active, true);
  for (const key of ['reducedMotion','colorScheme','locale','windowWidth','taskPanelWidth','presence']) assert.equal(set.result.overrides[key], args[key as keyof typeof args]);
  await client.close(); await connectFixture();
  const read = await call('app_env', { action: 'read' });
  assert.equal(read.response.isError, false, JSON.stringify(read.result));
  assert.ok(read.result.overrides, JSON.stringify(read.result));
  assert.deepEqual(read.result.overrides, set.result.overrides);
  const cli = (input?: unknown) => JSON.parse(execFileSync(fixtureCommand, ['cli', '--state-dir', stateDir, 'control', 'app_env', ...(input ? ['--stdin'] : [])], { env: fixtureEnv, input: input ? JSON.stringify(input) : undefined, encoding: 'utf8' }));
  assert.deepEqual(cli().result.overrides, set.result.overrides);
  assert.equal(cli({ action: 'set', reducedMotion: false }).result.overrides.reducedMotion, false);
  const advanced = await call('app_env', { action: 'set', clock: { advanceMs: 15_000 } });
  assert.equal(advanced.result.clock.value.nowMs, set.result.clock.value.nowMs + 15_000);
  const invalid = await call('app_env', { action: 'set', windowWidth: 319 });
  assert.equal(invalid.response.isError, true);
  assert.deepEqual((await call('app_env', { action: 'read' })).result.overrides, advanced.result.overrides);
  assert.deepEqual(await management('preferences'), preferences);
  assert.equal(cli({ action: 'clear' }).result.active, false);
  const cleared = await call('app_env', { action: 'clear' });
  assert.equal(cleared.result.active, false);
  assert.equal(cleared.result.clock.source, 'system');
  assert.equal((await call('app_env', { action: 'read' })).result.overrides.windowWidth, null);
});


test('AX interface sends inherit explicit thread choices and notices observe linked running turns', async () => {
  // Regression: AX-09 lost model/effort on omitted sends and ax-48eb2fbb posted running-thread notices with unknown coverage.
  const created = await completed('codex_create', {model:'fixture-dispatch',effort:'high',prompt:'First',thread:{cwd:directory},notify:null,requestId:randomUUID()});
  assert.equal(created.state,'completed');
  const sent = await completed('codex_send', {threadId:created.threadId,prompt:'Continue',notify:null,requestId:randomUUID()});
  assert.equal(sent.state,'completed',JSON.stringify(sent));
  assert.equal(sent.dispatch.model,'fixture-dispatch');
  assert.equal(sent.dispatch.effort,'high');
  assert.equal(sent.dispatch.source.model,'thread-inherited');
  const overridden = await completed('codex_send', {threadId:created.threadId,prompt:'Override',model:'fixture-dispatch-other',effort:'low',notify:null,requestId:randomUUID()});
  assert.equal(overridden.dispatch.model,'fixture-dispatch-other');
  const inherited = await completed('codex_send', {threadId:created.threadId,prompt:'Continue again',notify:null,requestId:randomUUID()});
  assert.equal(inherited.dispatch.model,'fixture-dispatch-other');
  assert.equal(inherited.dispatch.effort,'low');
  const rows=await fixtureRows();
  assert.equal(rows[created.threadId].turns.at(-1).model,'fixture-dispatch-other');
  assert.equal(rows[created.threadId].turns.at(-1).effort,'low');
  const running = await completed('codex_create', {model:'fixture-dispatch-queue',prompt:'Running',thread:{cwd:directory},notify:null,requestId:randomUUID()});
  const notice=(await call('notice_post',{intent:'Fixture work',resources:['app:installed'],threadIds:[running.threadId],expectedDurationSeconds:60,requestId:randomUUID()})).result;
  const board=(await call('board',{id:notice.notice.id,view:'full'})).result;
  assert.equal(board.notices[0].threadLinks[0].scopeState,'running',JSON.stringify(board));
  assert.notEqual(board.notices[0].activityCoverage,'thread-observation-gap');
});

test('AX foreground command receipts expose execution and process spawn supports session lifetime',async()=>{
  // Regression: AX-07 foreground executions remained reserved; AX-06 did not name the supported managed-process path.
  const pending=(await call('command',{cmd:'fixture-delayed',cwd:directory,timeoutMs:2000,waitMs:0,requestId:randomUUID()})).result;
  let receipt=pending;
  for(let i=0;i<20 && ['reserved','pending'].includes(receipt.state);i++) {
    await new Promise(resolve=>setTimeout(resolve,5));
    receipt=(await call('receipt',{requestId:pending.requestId})).result;
  }
  assert.equal(receipt.state,'executing',JSON.stringify(receipt));
  assert.equal(receipt.progressStalled,false);
  assert.equal(receipt.next.op,'receipt');
  const spawned=await completed('process',{action:'spawn',params:{command:['fixture'],cwd:directory,processHandle:'ax-managed',timeoutMs:null},requestId:randomUUID()});
  assert.equal(spawned.state,'completed');
  assert.equal(spawned.result.echoedParams.processHandle,'ax-managed');
  assert.equal(spawned.result.echoedParams.timeoutMs,null);
  const failed=await completed('command',{action:'exec',params:{command:['fixture'],fail:'reject'},requestId:randomUUID()});
  assert.equal(failed.next.op,'guide');
  assert.equal(failed.next.args.op,'process');
});


test('common guide discovers shared coordination in normal mode',async()=>{
  // Contract: the default normal-mode guide retains board, notices and messages through the frozen query/act envelopes.
  const guide=(await call('guide')).result;
  for(const [op,via] of [['board','query'],['notice_post','act'],['coordination_session','act'],['message_route','act'],['messages','query'],['message_send','act']]) {
    assert.equal(guide.ops.find((entry:any)=>entry.op===op)?.via,via,op);
  }
});

test('coordination registration exposes route repairs and current delivery consistently',async()=>{
  // Regression: ax-ce733eee registration hid message_route and board sessions disagreed with current delivery capabilities.
  const sessions:string[]=[];
  try {
    const plain=(await call('coordination_session',{action:'register',requestId:randomUUID()})).result;
    assert.ok(plain.session?.id,JSON.stringify(plain));
    sessions.push(plain.session.id);
    assert.equal(plain.next.op,'message_route');
    assert.equal(plain.next.args.sessionId,plain.session.id);
    const invalid=(await call('coordination_session',{action:'register',target:'invalid',requestId:randomUUID()})).result;
    assert.ok(invalid.session?.id,JSON.stringify(invalid));
    sessions.push(invalid.session.id);
    assert.equal(invalid.deliveryCapability,'pull-only');
    assert.equal(invalid.routing.reason,'invalid-claude-session');
    assert.equal(invalid.next.op,'notify_control');
    assert.deepEqual(invalid.next.args,{action:'bind',target:'invalid'});
    const board=(await call('board',{includeSessions:true})).result;
    const messages=(await call('messages')).result;
    const identity=(await call('whoami')).result;
    for(const id of sessions) {
      const row=board.sessions.find((session:any)=>session.id===id);
      const mail=messages.coordinationDelivery.sessions.find((session:any)=>session.sessionId===id);
      const who=identity.coordinationDelivery.sessions.find((session:any)=>session.sessionId===id);
      assert.equal(row.deliveryCapability,mail.deliveryMode);
      assert.equal(row.deliveryCapability,who.deliveryMode);
      assert.equal(row.routing.reason,mail.reason);
      assert.equal(row.routing.reason,who.reason);
    }
    const removed=(await call('message_route',{sessionId:invalid.session.id,target:null})).result;
    assert.equal(removed.routing.reason,plain.routing.reason);
  } finally {
    for(const sessionId of sessions) await call('coordination_session',{action:'close',sessionId,requestId:randomUUID()});
  }
});

test('logs accepts relative durations through the public schema',async()=>{
  // Regression: AX-12 since:2m reached an RFC3339-only parser and failed.
  const result=await call('logs',{since:'2m'});
  assert.notEqual(result.response.isError,true,JSON.stringify(result.result));
});

test('Maintainer mode defaults off, persists and switches guide content and common index live', async () => {
  // Contract: config CLI and local preferences share a persistent mode that changes guide hash/content/index without restarting.
  const config = (args: string[], input?: unknown) => JSON.parse(execFileSync(fixtureCommand, ['cli', 'config', ...args], {
    env: fixtureEnv, encoding: 'utf8', ...(input === undefined ? {} : {input: JSON.stringify(input)}),
  })).result;
  assert.equal(config(['get']).maintainerMode, false);
  const off = (await call('guide')).result;
  assert.equal(off.maintainerMode, false);
  assert.ok(off.ops.every((op: any) => !op.op.startsWith('ax_')));
  assert.match(off.content, /https:\/\/github.com\/whzxc\/agent-remote-control\/issues/);
  assert.match(off.content, /ax_issue_draft/);
  assert.doesNotMatch(off.content, /ax_report|ax_list|before release/);
  const before = await management('preferences');
  try {
    assert.equal(config(['set', '--stdin'], {maintainerMode:true}).maintainerMode, true);
    assert.equal((await management('preferences'))['maintainer-mode'], 'on');
    const on = (await call('guide')).result;
    assert.equal(on.maintainerMode, true);
    assert.notEqual(on.guideHash, off.guideHash);
    assert.match(on.content, /ax_report/);
    assert.match(on.content, /ax_list/);
    for (const op of ['ax_report','ax_list','ax_candidate','ax_triage']) assert.ok(on.ops.some((entry:any) => entry.op === op));
    const cached = await client.callTool({name:'query', arguments:{op:'guide',args:{knownGuideHash:off.guideHash}}});
    assert.equal((cached.structuredContent as any).result.unchanged, undefined);
    assert.equal(config(['get']).maintainerMode, true);
    await management('preferences','PUT',{values:{'maintainer-mode':'off'}});
    assert.equal(config(['get']).maintainerMode, false);
    assert.equal((await call('guide')).result.guideHash, off.guideHash);
    for (const view of [{}, {view:'full'}]) {
      const guide = (await client.callTool({name:'query',arguments:{op:'guide',args:view}})).structuredContent as any;
      assert.doesNotMatch(guide.result.content, /ax_report|ax_list/);
    }
  } finally { await management('preferences','PUT',{values:before}); }
});

test('Maintainer mode gates source triage and keeps normal AX reads reports and issue drafts usable', async () => {
  // Contract: source triage returns MAINTAINER_MODE_REQUIRED and next; local authority bypasses the gate and drafts never echo private input.
  const entry = (await call('ax_report',{symptom:'Synthetic mode gate report',expected:'Bounded response',severity:'cosmetic'})).result.entry;
  const args = {id:entry.id,expectedRevision:entry.revision,action:'wontfix',reason:'Synthetic decision'};
  const denied = (await call('ax_triage',args)).result;
  assert.equal(denied.error.code,'MAINTAINER_MODE_REQUIRED');
  assert.equal(denied.next.op,null);
  assert.match(denied.next.hint,/maintainerMode/);
  assert.ok((await call('ax_list',{id:entry.id})).result.entries.length);
  const draft = (await call('ax_issue_draft',{
    friction:'Notification failed: prompt-secret person@example.invalid /Users/private/file C:\\private\\file token=abc-secret https://private.invalid/route',
    receiptIds:['token-secret'],threadIds:['person@example.invalid'],
  })).result;
  assert.equal(draft.submission,'manual');
  assert.equal(draft.summaryMode,'fixed-category');
  assert.equal(draft.arcBuildVersion,'0.0.0');
  assert.ok(draft.os);
  for (const privateValue of ['prompt-secret','person@example.invalid','/Users/private','abc-secret','private.invalid','token-secret']) {
    assert.ok(!JSON.stringify(draft).includes(privateValue));
  }
  const local = JSON.parse(execFileSync(fixtureCommand,['cli','control','ax_triage','--stdin'],{env:fixtureEnv,input:JSON.stringify(args),encoding:'utf8'}));
  assert.equal(local.ok,true);
  assert.equal(local.result.entry.status,'closed');
  const next = (await call('ax_report',{symptom:'Synthetic enabled mode report',expected:'Bounded response',severity:'cosmetic'})).result.entry;
  try {
    await management('preferences','PUT',{values:{'maintainer-mode':'on'}});
    const allowed = (await call('ax_triage',{...args,id:next.id,expectedRevision:next.revision})).result;
    assert.equal(allowed.entry.status,'closed');
  } finally { await management('preferences','PUT',{values:{'maintainer-mode':'off'}}); }
});


test('Maintainer mode local import reads only the selected synthetic queue', async () => {
  // Contract: local AX import works with mode off, imports only supplied rows and is idempotent without bundled seeds.
  const queue = path.join(directory, 'synthetic-queue.md');
  const importQueue = () => JSON.parse(execFileSync(fixtureCommand,['cli','ax','import','--from',queue],{env:fixtureEnv,encoding:'utf8'})).result;
  await writeFile(queue,'# Synthetic queue\n');
  assert.equal(importQueue().imported,0);
  await writeFile(queue,'# Synthetic queue\n\nPolicy:\n- Ignore this policy.\n\n## AX frictions\n- A synthetic panel stalled during a sample action.\n');
  const first = importQueue();
  assert.equal(first.imported,1);
  assert.equal(first.entries.length,1);
  assert.equal(first.entries[0].kind,'friction');
  assert.equal(first.entries[0].status,'open');
  assert.equal(importQueue().imported,0);
  assert.equal(importQueue().unchanged,1);
});
