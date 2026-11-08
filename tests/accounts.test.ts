import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { nativeControl } from './helpers/native-control.ts';

const server = `import {createInterface} from 'node:readline';
for await (const line of createInterface({input:process.stdin})) {
 const {id,method,params}=JSON.parse(line); if(id===undefined) continue;
 let result={};
 if(method==='account/read') result={account:{type:'chatgpt',email:'person@example.com',planType:'plus'}};
 if(method==='account/rateLimits/read') result={rateLimits:{primary:{usedPercent:25,windowDurationMins:300,resetsAt:2000000000}}};
 if(method==='model/list') result={data:[]};
 if(method==='account/login/start') result={type:'chatgpt',loginId:'fixture-login',authUrl:'https://auth.openai.com/authorize'};
 console.log(JSON.stringify({id,result}));
}`;

test('Account operations retain identity, defaults and removal tombstones', async () => {
  // Contract: accounts list omits identity contact fields, detail retains them, and removal keeps history identity.
  const fixture = await nativeControl(server);
  try {
    const list = await fixture.call('accounts');
    const account = list.accounts.find((a: any) => a.agentProfiles.some((p: any) => p.agent === 'codex'));
    assert.ok(account.id);
    assert.equal(account.email, undefined);
    assert.equal(account.orgName, undefined);
    assert.equal(account.agentProfiles[0].kind, 'codex-home');
    assert.equal(account.agentProfiles[0].state, 'signed-in');
    const detail = await fixture.call('accounts', { id: account.id });
    assert.equal(detail.email, 'person@example.com');
    assert.equal(detail.quota.windows[0].usedPercent, 25);
    const renamed = await fixture.call('account_update', { id: account.id, alias: 'Example account', defaultFor: 'codex' });
    assert.equal(renamed.alias, 'Example account');
    assert.equal(renamed.agentProfiles.filter((p: any) => p.default).length, 1);
    assert.equal((await fixture.api(`accounts/${account.id}`)).alias, 'Example account');
    const cleared = await fixture.call('account_update', { id: account.id, defaultFor: 'codex', default: false });
    assert.ok(cleared.agentProfiles.every((p: any) => !p.default));
    await fixture.restart();
    const refreshed = await fixture.call('accounts', { id: account.id });
    assert.ok(refreshed.agentProfiles.every((p: any) => !p.default));
    const noDefault = await fixture.call('codex_create', { prompt: 'Example task', notify: null });
    assert.equal(noDefault.error.code, 'ACCOUNT_DEFAULT_MISSING');
    const missingAgent = await fixture.call('account_update', { id: account.id, default: false });
    assert.equal(missingAgent.error.code, 'ACCOUNT_DEFAULT_AGENT_REQUIRED');
    await fixture.api('accounts/update', { id: account.id, defaultFor: 'codex', default: true });
    assert.ok((await fixture.call('accounts', { id: account.id })).agentProfiles.some((p: any) => p.default));
    const self = await fixture.call('whoami');
    assert.equal(self.id, null);
    assert.equal(self.authority, 'local');
    assert.equal(self.identityResolution.state, 'not-applicable');
    assert.ok(self.sourceId);
    assert.ok(!(await fixture.api('source')).sources.some((source: any) => source.id === self.sourceId));
    assert.ok(!(await fixture.call('accounts')).accounts.some((row: any) => row.sources.includes(self.sourceId)));
    await assert.rejects(fixture.shell(`arc cli source disconnect ${self.sourceId}`), (error: any) => {
      const result = JSON.parse(error.stdout);
      assert.equal(error.code, 1);
      assert.equal(result.error.code, 'LOCAL_SOURCE_PROTECTED');
      assert.equal(result.next.op, null);
      assert.ok(result.next.hint);
      return true;
    });
    assert.equal((await fixture.call('whoami')).sourceId, self.sourceId);
    await fixture.api('task-settings', { enabled: true }, 'PUT');
    const requestId = randomUUID();
    const dispatchArgs = { account: 'Example account', prompt: 'Example task', notify: null, requestId };
    const receipt = await fixture.call('codex_create', dispatchArgs);
    assert.equal(receipt.state, 'awaiting-approval');
    assert.equal(receipt.agentAccountId, account.id);
    assert.equal(receipt.origin.accountId, undefined);
    assert.equal(receipt.origin.sourceId, self.sourceId);
    const removed = await fixture.call('account_remove', { id: account.id, running: 'finish' });
    assert.ok(removed.removedAt);
    assert.equal(removed.health.state, 'removed');
    assert.equal((await fixture.call('accounts')).accounts.some((a: any) => a.id === account.id), false);
    assert.equal((await fixture.call('accounts', { id: account.id })).email, 'person@example.com');
    const replay = await fixture.call('codex_create', dispatchArgs);
    assert.equal(replay.agentAccountId, account.id);
    assert.equal(replay.agentAccountRemoved, true);
    const rejected = await fixture.call('codex_create', { ...dispatchArgs, requestId: randomUUID(), account: account.id });
    assert.ok(rejected.error);
    await fixture.restart();
    assert.equal((await fixture.call('accounts', { id: account.id })).health.state, 'removed');
    assert.equal((await fixture.call('accounts')).accounts.some((a: any) => a.id === account.id), false);
  } finally { await fixture.close(); }
});

test('Isolated Codex credentials retain task accounts and explicit refresh ownership', async () => {
  // Regression: adding a Codex account replaced the system login; native subagents without thread/started also fell back to the default account.
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const hooks = await mkdtemp(path.join(tmpdir(), 'arc-refresh-'));
  const hook = path.join(hooks, 'refresh.mjs');
  await writeFile(hook, `import fs from 'node:fs'; const request=JSON.parse(fs.readFileSync(0,'utf8')); console.log(JSON.stringify({accessToken:process.argv[2],chatgptAccountId:request.previousAccountId,chatgptPlanType:'prolite'}));`);
  const script = `import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs'; import path from 'node:path';
const home=process.env.CODEX_HOME; let account=fs.existsSync(path.join(home,'auth.json'))?JSON.parse(fs.readFileSync(path.join(home,'auth.json'),'utf8')).tokens.access_token:'native-default';
fs.mkdirSync(path.join(home,'sessions'),{recursive:true});
const file=path.join(home,'fixture-tasks.json');
const tasks=()=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
const save=rows=>fs.writeFileSync(file,JSON.stringify(rows));
const reply=(id,result)=>console.log(JSON.stringify({id,result}));
let refreshTurn;
for await(const line of createInterface({input:process.stdin})) {
 const {id,method,params,result:response}=JSON.parse(line);
 if(!method) {if(id==='refresh'&&refreshTurn){account=response.accessToken; reply(refreshTurn.id,{turn:refreshTurn.turn});refreshTurn=null;} continue;}
 if(id===undefined)continue;
 let result={};const rows=tasks(); const row=rows[params?.threadId];
 if(method==='account/read') result={account:{type:'chatgpt',accountId:'workspace-'+account,email:account+'@example.test',planType:'pro'}};
 if(method==='account/login/start') {
  if(params.type==='chatgpt') {account='oauth';fs.writeFileSync(path.join(home,'auth.json'),JSON.stringify({tokens:{access_token:account,refresh_token:'native-owned',account_id:'workspace-oauth'}}));result={type:'chatgpt',loginId:'oauth-login'};setTimeout(()=>console.log(JSON.stringify({method:'account/login/completed',params:{loginId:'oauth-login',success:true}})),10);}
  else {account=params.accessToken; result={type:params.type};}
 }
 if(method==='account/rateLimits/read')result={rateLimits:{primary:{usedPercent:0,windowDurationMins:10080}}};
 if(method==='model/list')result={data:[{id:'fixture-model',model:'fixture-model',supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low'}]};
 if(method==='thread/start'){const row={id:randomUUID(),cwd:params.cwd??home,updatedAt:Date.now(),status:{type:'idle'},turns:[]};rows[row.id]=row;save(rows);result={thread:row};}
 if(method==='thread/read'){if(!row){console.log(JSON.stringify({id,error:{code:-32000,message:'wrong profile'}}));continue;}result={thread:row};}
 if(method==='thread/loaded/list')result={data:Object.keys(rows)};
 if(method==='thread/turns/list')result={data:[...row.turns].reverse(),nextCursor:null};
 if(method==='thread/list')result={data:Object.values(rows).filter(r=>!!r.archived===!!params.archived).sort((a,b)=>b.updatedAt-a.updatedAt),nextCursor:null};
 if(method==='turn/start'){
  const turn={id:randomUUID(),status:'completed',items:[{id:randomUUID(),type:'agentMessage',text:account}]};
  if(params.input?.some(i=>i.text==='spawn')) {
   const childId=randomUUID(),childTurn=randomUUID(),at=new Date().toISOString();
   const records=[
    {type:'session_meta',timestamp:at,payload:{id:childId,cwd:row.cwd,agent_nickname:'Fixture subagent',source:{subagent:{thread_spawn:{parent_thread_id:row.id}}}}},
    {type:'event_msg',timestamp:at,payload:{type:'task_started',turn_id:childTurn}},
    {type:'response_item',timestamp:at,payload:{type:'function_call',call_id:randomUUID(),name:'exec_command',arguments:'{}'}}
   ];
   fs.writeFileSync(path.join(home,'sessions','rollout-'+childId+'.jsonl'),records.map(r=>JSON.stringify(r)).join('\\n')+'\\n');
   rows[childId]={id:childId,cwd:row.cwd,updatedAt:Date.now(),status:{type:'active'},turns:[{id:childTurn,status:'inProgress',items:[]}]};
   turn.items[0].text=childId;
  }
  row.turns.push(turn);save(rows);result={turn};
  if(params.input?.some(i=>i.text==='refresh')){refreshTurn={id,turn};console.log(JSON.stringify({id:'refresh',method:'account/chatgptAuthTokens/refresh',params:{reason:'unauthorized',previousAccountId:'workspace-'+account}}));continue;}
 }
 if(method==='thread/archive'){row.archived=true;save(rows);}
 reply(id,result);
}`;
  const fixture = await nativeControl(script);
  try {
    const initial = (await fixture.call('accounts', { agent: 'codex' })).accounts[0];
    const inputs = ['alpha', 'beta'].map(id => ({ auth: { tokens: { access_token: id, account_id: `workspace-${id}`, refresh_token: 'manager-owned-secret' } }, refreshOwner: 'external', refreshCommand: { program: process.execPath, args: [hook, id] } }));
    const imported = [];
    for (const input of inputs) {
      const result = await fixture.call('account_import', input);
      assert.equal(result.state, 'completed', JSON.stringify(result));
      assert.ok(!JSON.stringify(result).includes('manager-owned-secret'));
      imported.push(result);
    }
    assert.equal((await fixture.call('account_import', inputs[0])).profileId, imported[0].profileId);
    const accounts = (await fixture.call('accounts', { agent: 'codex' })).accounts;
    assert.equal(accounts.length, 3);
    assert.equal(accounts.find((a: any) => a.agentProfiles.some((p: any) => p.default)).id, initial.id);
    const created = [];
    for (const account of imported) {
      const r = await fixture.completed('codex_create', { account: account.accountId, prompt: 'profile task', model: 'fixture-model', effort: 'low', title: 'Profile task' });
      assert.equal(r.state, 'completed', JSON.stringify(r));
      assert.equal(r.executionOwner, 'connector');
      assert.equal(r.agentAccountId, account.accountId);
      created.push(r);
    }
    const thread = created[0].threadId;
    const waited = await fixture.call('codex_wait', { threadId: thread, turnId: created[0].turnId, until: 'terminal', timeoutMs: 1000 });
    assert.equal(waited.conditionMet, true, JSON.stringify(waited));
    assert.equal(waited.state, 'completed');
    const sent = await fixture.completed('codex_send', { threadId: thread, prompt: 'refresh', model: 'fixture-model', effort: 'low' });
    assert.equal(sent.state, 'completed', JSON.stringify(sent));
    assert.equal(sent.agentAccountId, imported[0].accountId);
    const mismatch = await fixture.call('codex_send', { threadId: thread, account: imported[1].accountId, prompt: 'must not switch' });
    assert.equal(mismatch.error.code, 'CODEX_THREAD_ACCOUNT_MISMATCH', JSON.stringify(mismatch));
    await fixture.restart();
    const resumed = await fixture.completed('codex_send', { threadId: thread, prompt: 'continue', model: 'fixture-model', effort: 'low' });
    assert.equal(resumed.state, 'completed', JSON.stringify(resumed));
    assert.equal(resumed.agentAccountId, imported[0].accountId);
    const page = await fixture.call('codex_tasks', { enrich: false });
    assert.ok(created.every(r => page.tasks.some((t: any) => t.threadId === r.threadId)));
    assert.equal((await fixture.call('account_reauth', { id: imported[0].accountId, agent: 'codex' })).refreshOwner, 'external');
    const native = await fixture.call('account_import', { auth: { tokens: { access_token: 'gamma', refresh_token: 'native-owned', account_id: 'workspace-gamma' } }, refreshOwner: 'codex' });
    assert.equal(native.refreshOwner, 'codex');
    const accessOnly = await fixture.call('account_import', { auth: { tokens: { access_token: 'delta', account_id: 'workspace-delta' } }, refreshOwner: 'none' });
    assert.equal(accessOnly.refreshOwner, 'none');
    const oauth = await fixture.call('account_add', { kind: 'codex', browserId: 'fixture-unused' });
    assert.equal(oauth.state, 'waiting');
    let login;
    for(let i=0;i<20;i++) {login=(await fixture.call('accounts')).login;if(login?.state==='completed')break;await new Promise(r=>setTimeout(r,20));}
    assert.equal(login?.state, 'completed');
    assert.notEqual(login.accountId, initial.id);
    const current = (await fixture.call('accounts', { agent: 'codex' })).accounts;
    assert.equal(current.find((a: any) => a.agentProfiles.some((p: any) => p.default)).id, initial.id);
    const children: Array<{ id: string; parentId: string; accountId: string }> = [];
    for (const [index, parent] of created.entries()) {
      await fixture.completed('codex_send', { threadId: parent.threadId, prompt: 'spawn', model: 'fixture-model', effort: 'low' });
      const read = await fixture.call('codex_query', { method: 'thread/read', params: { threadId: parent.threadId, includeTurns: true } });
      children.push({ id: read.thread.turns.at(-1).items[0].text, parentId: parent.threadId, accountId: imported[index].accountId });
    }
    const deadline = Date.now() + 6000;
    let activity;
    do {
      activity = await fixture.api('agents/activity');
      if (children.every(child => activity.agents.codex?.sessions.some((s: any) => s.id === child.id))) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    for (const child of children) {
      const session = activity.agents.codex?.sessions.find((s: any) => s.id === child.id);
      assert.ok(session, JSON.stringify(activity));
      assert.equal(session.agentAccountId, child.accountId);
      assert.equal(session.parentSessionId, child.parentId);
      assert.equal(session.relationKind, 'subagent');
      const native = await fixture.call('codex_query', { method: 'thread/read', params: { threadId: child.id, includeTurns: false } });
      assert.equal(native.thread.id, child.id, JSON.stringify(native));
    }
    await fixture.restart();
    for (const child of children) {
      const native = await fixture.call('codex_query', { method: 'thread/read', params: { threadId: child.id, includeTurns: false } });
      assert.equal(native.thread.id, child.id, JSON.stringify(native));
    }
    assert.equal((await fixture.completed('codex_archive', { threadId: thread })).state, 'completed');
  } finally { await fixture.close(); await rm(hooks, { recursive: true, force: true }); }
});

test('Codex profiles inherit approval policy and reload shared setup before dispatch', async () => {
  // Regression: spare Codex homes requested approval on every command and missed shared setup; interrupted resume erased the profile binding.
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const primary = await mkdtemp(path.join(tmpdir(), 'arc-codex-primary-'));
  const config = (effort: string) => `approval_policy = "never"\nsandbox_mode = "danger-full-access"\nmodel_reasoning_effort = "${effort}"\n[mcp_servers.example]\nurl = "https://example.test/mcp"\n[features]\nmulti_agent = true\n`;
  await writeFile(path.join(primary, 'config.toml'), config('low'));
  await writeFile(path.join(primary, 'AGENTS.md'), 'Shared instruction fixture');
  await mkdir(path.join(primary, 'skills', 'example-skill'), { recursive: true });
  await writeFile(path.join(primary, 'skills', 'example-skill', 'SKILL.md'), 'Example shared skill');
  const script = `import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto'; import fs from 'node:fs'; import path from 'node:path';
const home=process.env.CODEX_HOME; fs.mkdirSync(home,{recursive:true});
const config=fs.existsSync(path.join(home,'config.toml'))?fs.readFileSync(path.join(home,'config.toml'),'utf8'):'';
const policy=/^approval_policy\\s*=\\s*"([^"]+)"/m.exec(config)?.[1];
const effort=/^model_reasoning_effort\\s*=\\s*"([^"]+)"/m.exec(config)?.[1];
const setup={policy,effort,instructions:fs.existsSync(path.join(home,'AGENTS.md'))?fs.readFileSync(path.join(home,'AGENTS.md'),'utf8'):null,skills:fs.existsSync(path.join(home,'skills'))?fs.readdirSync(path.join(home,'skills')).filter(name=>name==='example-skill'):[],mcp:config.includes('[mcp_servers.example]')};
const auth=fs.existsSync(path.join(home,'auth.json'))?JSON.parse(fs.readFileSync(path.join(home,'auth.json'),'utf8')):null;
const account=auth?.tokens?.account_id??'primary'; const file=path.join(home,'fixture-tasks.json');
const tasks=()=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{}; const save=rows=>fs.writeFileSync(file,JSON.stringify(rows));
for await(const line of createInterface({input:process.stdin})) {
 const {id,method,params}=JSON.parse(line);if(id===undefined)continue;let result={};const rows=tasks();const row=rows[params?.threadId];
 if(method==='account/read')result={account:{type:'chatgpt',accountId:account,email:account+'@example.test',planType:'pro'}};
 if(method==='account/rateLimits/read')result={rateLimits:{primary:{usedPercent:0,windowDurationMins:300}}};
 if(method==='model/list')result={data:[{id:'fixture-model',model:'fixture-model',supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low'}]};
 if(method==='thread/start'){const created={id:randomUUID(),cwd:home,updatedAt:Date.now(),status:{type:'idle'},turns:[]};rows[created.id]=created;save(rows);result={thread:created};}
 if(method==='thread/read')result={thread:row};
 if(method==='thread/turns/list')result={data:[...row.turns].reverse(),nextCursor:null};
 if(method==='thread/loaded/list')result={data:Object.keys(rows)};
 if(method==='thread/list')result={data:Object.values(rows),nextCursor:null};
 if(method==='turn/start'){
  if(policy!=='never'){console.log(JSON.stringify({id,error:{code:-32000,message:'Command approval required by missing shared policy'}}));continue;}
  const active=params.input?.some(i=>i.text==='hold'); const turn={id:randomUUID(),status:active?'inProgress':'completed',items:[{id:randomUUID(),type:'agentMessage',text:JSON.stringify(setup)}]};
  row.status={type:active?'active':'idle'};row.turns.push(turn);save(rows);result={turn};
 }
 if(method==='turn/interrupt'){row.status={type:'idle'};row.turns.at(-1).status='interrupted';save(rows);}
 console.log(JSON.stringify({id,result}));
}`;
  const fixture = await nativeControl(script, { CODEX_HOME: primary });
  try {
    const primaryAccount = (await fixture.call('accounts', { agent: 'codex' })).accounts.find((account: any) => account.agentProfiles.some((profile: any) => profile.profileId === 'codex-home'));
    const imported = [];
    for (const name of ['alpha', 'beta']) {
      const result = await fixture.call('account_import', { auth: { tokens: { access_token: name, refresh_token: 'fixture-refresh', account_id: name } }, refreshOwner: 'codex' });
      assert.equal(result.state, 'completed', JSON.stringify(result));
      imported.push(result);
    }
    const dispatch = async (account: any, prompt = 'inspect') => {
      const receipt = await fixture.completed('codex_create', { account: account.accountId, prompt, model: 'fixture-model' });
      assert.equal(receipt.state, 'completed', JSON.stringify(receipt));
      const read = await fixture.call('codex_query', { method: 'thread/read', params: { threadId: receipt.threadId, includeTurns: true } });
      return { receipt, setup: JSON.parse(read.thread.turns.at(-1).items[0].text) };
    };
    for (const account of imported) {
      assert.deepEqual((await dispatch(account)).setup, { policy: 'never', effort: 'low', instructions: 'Shared instruction fixture', skills: ['example-skill'], mcp: true });
      const detail = await fixture.call('accounts', { id: account.accountId });
      const parity = detail.agentProfiles.find((profile: any) => profile.profileId === account.profileId).parity;
      assert.equal(parity.state, 'synced');
      assert.ok(parity.lastSyncAt);
    }
    const allAccounts = [{ accountId: primaryAccount.id }, ...imported];
    assert.equal((await dispatch(allAccounts[0])).setup.effort, 'low');
    await writeFile(path.join(primary, 'config.toml'), config('medium'));
    for (const account of allAccounts) assert.equal((await dispatch(account)).setup.effort, 'medium');
    const held = await dispatch(imported[0], 'hold');
    await writeFile(path.join(primary, 'config.toml'), config('high'));
    const blocked = await fixture.completed('codex_create', { account: imported[0].accountId, prompt: 'inspect', model: 'fixture-model' });
    assert.equal(blocked.error.code, 'CODEX_PROFILE_PARITY_BUSY', JSON.stringify(blocked));
    assert.equal((await fixture.completed('codex_interrupt', { threadId: held.receipt.threadId, turnId: held.receipt.turnId })).state, 'completed');
    const resumed = await fixture.completed('codex_resume', { threadId: held.receipt.threadId, turnId: held.receipt.turnId });
    assert.equal(resumed.state, 'completed', JSON.stringify(resumed));
    const resumedThread = await fixture.call('codex_query', { method: 'thread/read', params: { threadId: held.receipt.threadId, includeTurns: true } });
    assert.equal(JSON.parse(resumedThread.thread.turns.at(-1).items[0].text).effort, 'high');
    const continuation = await fixture.completed('codex_send', { threadId: held.receipt.threadId, account: imported[0].accountId, prompt: 'inspect', model: 'fixture-model' });
    assert.equal(continuation.state, 'completed', JSON.stringify(continuation));
    assert.equal(continuation.agentAccountId, imported[0].accountId);
    assert.equal((await dispatch(imported[0])).setup.effort, 'high');
    await fixture.restart(async state => {
      for (const account of imported) await writeFile(path.join(state, 'accounts/codex/profiles', account.profileId, 'home/config.toml'), 'approval_policy = "on-request"\n');
    });
    for (const account of imported) {
      const detail = await fixture.call('accounts', { id: account.accountId });
      assert.equal(detail.agentProfiles.find((profile: any) => profile.profileId === account.profileId).parity.state, 'synced');
      assert.equal((await dispatch(account)).setup.policy, 'never');
    }
    await writeFile(path.join(primary, 'config.toml'), 'approval_policy = "fixture-secret-without-closing-quote\n');
    const failed = await fixture.completed('codex_create', { account: imported[0].accountId, prompt: 'inspect', model: 'fixture-model' });
    assert.equal(failed.error.code, 'CODEX_PROFILE_PARITY_FAILED', JSON.stringify(failed));
    assert.equal(failed.threadId, undefined);
    assert.equal(failed.next.op, 'guide');
    assert.deepEqual(failed.next.args, { op: 'accounts' });
    assert.ok(!JSON.stringify(failed).includes('fixture-secret-without-closing-quote'));
  } finally { await fixture.close(); await rm(primary, { recursive: true, force: true }); }
});
