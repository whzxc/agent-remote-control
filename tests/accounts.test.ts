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

test('unchanged account reads reuse the index without account cost passes or row scans', async () => {
  // Regression: ax-28de53a4 visible Desktop account polling rescanned unchanged rows tens of times per second.
  const fixture = await nativeControl(server);
  try {
    const list = await fixture.api('accounts');
    const account = list.accounts.find((a: any) => a.agentProfiles.some((p: any) => p.agent === 'codex'));
    await fixture.api(`accounts/${account.id}`);
    const before = (await fixture.call('runtime_metrics')).cost.accounts;
    for (let n = 0; n < 6; n++) {
      assert.equal((await fixture.api(`accounts/${account.id}`)).id, account.id);
      assert.ok((await fixture.api('accounts')).accounts.some((a: any) => a.id === account.id));
      await fixture.api('agents/activity');
    }
    const after = (await fixture.call('runtime_metrics')).cost.accounts;
    for (const key of ['passes', 'rowsVisited', 'bytesParsed', 'recordsChanged']) {
      assert.equal(after[key] - before[key], 0, key);
    }
  } finally { await fixture.close(); }
});

test('account reads observe a replaced index and retain add remove default and quota changes', async () => {
  // Regression: ax-28de53a4 account index caching must expose changed records on the next UI or op read.
  const { readFile, writeFile, rename } = await import('node:fs/promises');
  const fixture = await nativeControl(server);
  try {
    let directory = '';
    await fixture.restart(async state => { directory = state; });
    const list = await fixture.api('accounts');
    const account = list.accounts.find((a: any) => a.agentProfiles.some((p: any) => p.agent === 'codex'));
    await fixture.api(`accounts/${account.id}`);
    const path = `${directory}/accounts/index.json`;
    const rows = JSON.parse(await readFile(path, 'utf8'));
    const changed = rows.find((a: any) => a.id === account.id);
    changed.alias = 'Changed fixture';
    changed.agentProfiles.forEach((p: any) => { p.default = false; });
    changed.quota = { state: 'ready', observedAt: new Date().toISOString(), windows: [{ usedPercent: 73 }] };
    const extra = { ...changed, id: 'fixture-added', identityKey: 'other:unidentified:fixture-added', agentProfiles: [] };
    rows.push(extra);
    const before = (await fixture.call('runtime_metrics')).cost.accounts;
    await writeFile(`${path}.tmp`, JSON.stringify(rows));
    await rename(`${path}.tmp`, path);
    const detail = await fixture.api(`accounts/${account.id}`);
    assert.equal(detail.alias, changed.alias);
    assert.ok(detail.agentProfiles.every((p: any) => !p.default));
    assert.equal(detail.quota.windows[0].usedPercent, 73);
    const listed = await fixture.call('accounts');
    assert.ok(listed.accounts.some((a: any) => a.id === extra.id));
    const after = (await fixture.call('runtime_metrics')).cost.accounts;
    assert.equal(after.passes - before.passes, 1);
    assert.equal(after.rowsVisited - before.rowsVisited, rows.length + 1);
    assert.equal(after.recordsChanged - before.recordsChanged, 2);
    await writeFile(path, JSON.stringify(rows.filter((a: any) => a.id !== extra.id)));
    assert.ok(!(await fixture.api('accounts')).accounts.some((a: any) => a.id === extra.id));
    const quota = await fixture.api('accounts/refresh-quota', { id: account.id });
    assert.equal(quota.quota.windows[0].usedPercent, 25);
  } finally { await fixture.close(); }
});

test('Targeted credential import refuses a different Codex identity', async () => {
  // Regression: replacing credentials from an account card could import a different provider identity.
  const fixture = await nativeControl(server);
  try {
    const login = (id: string) => ({ auth: { tokens: { access_token: 'fixture-access', account_id: id } }, refreshOwner: 'none' });
    const original = await fixture.api('accounts/import', login('workspace-original'));
    assert.equal(original.state, 'completed', JSON.stringify(original));
    const result = await fixture.api('accounts/import', { ...login('workspace-other'), accountId: original.accountId });
    assert.match(JSON.stringify(result.error), /ACCOUNT_REAUTH_IDENTITY_MISMATCH/);
    const accounts = (await fixture.api('accounts')).accounts;
    assert.ok(accounts.some((row: any) => row.id === original.accountId && row.health.state === 'ready'));
    assert.ok(!accounts.some((row: any) => row.identityKey === 'openai:id:workspace-other'));
  } finally { await fixture.close(); }
});

test('Codex credentials remain independent while sessions use the native shared home', async () => {
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
 if(method==='account/read'){if(params.refreshToken&&fs.existsSync(path.join(home,'auth.json'))){const auth=JSON.parse(fs.readFileSync(path.join(home,'auth.json'),'utf8'));auth.tokens.access_token+='-refreshed';account=auth.tokens.access_token;fs.writeFileSync(path.join(home,'auth.json'),JSON.stringify(auth));}result={account:{type:'chatgpt',accountId:'workspace-'+account,email:account+'@example.test',planType:'pro'}};}
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
  const turn={id:randomUUID(),status:'completed',items:[{id:randomUUID(),type:'agentMessage',text:account+'|'+home}]};
  if(params.input?.some(i=>i.text==='spawn')) {
   const createChild=parentId=>{
    const childId=randomUUID(),childTurn=randomUUID(),at=new Date().toISOString();
    const records=[
     {type:'session_meta',timestamp:at,payload:{id:childId,cwd:row.cwd,creator_account_id:'workspace-'+account,agent_nickname:'Fixture subagent',source:{subagent:{thread_spawn:{parent_thread_id:parentId}}}}},
     {type:'event_msg',timestamp:at,payload:{type:'task_started',turn_id:childTurn}},
     {type:'response_item',timestamp:at,payload:{type:'function_call',call_id:randomUUID(),name:'exec_command',arguments:'{}'}}
    ];
    const transcript=path.join(home,'sessions','rollout-'+childId+'.jsonl');
    fs.writeFileSync(transcript,records.map(r=>JSON.stringify(r)).join('\\n')+'\\n');
    rows[childId]={id:childId,path:transcript,cwd:row.cwd,updatedAt:Date.now(),status:{type:'idle'},turns:[{id:childTurn,status:'completed',items:[]}]};
    return childId;
   };
   const childId=createChild(row.id),grandchild=createChild(childId);
   turn.items[0].text=childId;
   turn.items.push({id:randomUUID(),type:'agentMessage',text:grandchild});
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
    await fixture.api('task-settings', { autoOpenCodex: true }, 'PUT');
    const created = [];
    for (const account of imported) {
      const r = await fixture.completed('codex_create', { account: account.accountId, prompt: 'profile task', model: 'fixture-model', effort: 'low', title: 'Profile task' });
      assert.equal(r.state, 'completed', JSON.stringify(r));
      assert.equal(r.executionOwner, 'connector');
      assert.equal(r.agentAccountId, account.accountId);
      const native = await fixture.call('codex_query', { method: 'thread/read', params: { threadId: r.threadId, includeTurns: true } });
      const [identity, nativeHome] = native.thread.turns[0].items[0].text.split('|');
      assert.equal(identity, account === imported[0] ? 'alpha' : 'beta');
      if (created.length) {
        const first = await fixture.call('codex_query', { method: 'thread/read', params: { threadId: created[0].threadId, includeTurns: true } });
        assert.equal(nativeHome, first.thread.turns[0].items[0].text.split('|')[1]);
      }
      created.push(r);
    }
    const thread = created[0].threadId;
    const blockedDesktop = await fixture.call('task_open', { agent: 'codex', id: thread });
    assert.equal(blockedDesktop.error.code, 'CODEX_PROFILE_DESKTOP_UNSUPPORTED', JSON.stringify(blockedDesktop));
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
    const nativeTask = await fixture.completed('codex_create', { account: native.accountId, prompt: 'inspect', model: 'fixture-model', effort: 'low' });
    assert.equal(nativeTask.state, 'completed', JSON.stringify(nativeTask));
    assert.equal((await fixture.completed('codex_send', { threadId: nativeTask.threadId, prompt: 'refresh', model: 'fixture-model', effort: 'low' })).state, 'completed');
    await fixture.completed('codex_send', { threadId: nativeTask.threadId, prompt: 'inspect', model: 'fixture-model', effort: 'low' });
    const nativeRead = await fixture.call('codex_query', { method: 'thread/read', params: { threadId: nativeTask.threadId, includeTurns: true } });
    assert.match(nativeRead.thread.turns.at(-1).items[0].text, /^gamma-refreshed\|/);
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
    await fixture.call('account_update', { id: imported[0].accountId, defaultFor: 'codex' });
    const secondaryDefault = await fixture.call('accounts', { id: imported[0].accountId });
    assert.equal(secondaryDefault.agentProfiles[0].role, 'secondary');
    assert.equal(secondaryDefault.agentProfiles[0].desktopDispatch, false);
    const implicit = await fixture.completed('codex_create', { prompt: 'Use the dispatch default', model: 'fixture-model', effort: 'low' });
    assert.equal(implicit.agentAccountId, imported[0].accountId);
    assert.equal(implicit.executionOwner, 'connector');
    await fixture.call('account_update', { id: initial.id, defaultFor: 'codex' });
    const children: Array<{ id: string; parentId: string; accountId: string }> = [];
    for (const [index, parent] of created.entries()) {
      await fixture.completed('codex_send', { threadId: parent.threadId, prompt: 'spawn', model: 'fixture-model', effort: 'low' });
      const read = await fixture.call('codex_query', { method: 'thread/read', params: { threadId: parent.threadId, includeTurns: true } });
      children.push({ id: read.thread.turns.at(-1).items[0].text, parentId: parent.threadId, accountId: imported[index].accountId });
      children.push({ id: read.thread.turns.at(-1).items[1].text, parentId: read.thread.turns.at(-1).items[0].text, accountId: imported[index].accountId });
      const unseenSend = await fixture.completed('codex_send', { threadId: children.at(-1)!.id, prompt: 'Continue native child before discovery', model: 'fixture-model', effort: 'low' });
      assert.equal(unseenSend.agentAccountId, imported[index].accountId);
      assert.equal(unseenSend.executionOwner, 'connector');
      const openChild = await fixture.call('task_open', { agent: 'codex', id: children.at(-2)!.id });
      assert.equal(openChild.error.code, 'CODEX_PROFILE_DESKTOP_UNSUPPORTED', JSON.stringify(openChild));
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
    const afterRestart = (await fixture.call('accounts', { agent: 'codex' })).accounts;
    assert.equal(afterRestart.find((a: any) => a.agentProfiles.some((p: any) => p.default)).id, initial.id);
    assert.equal((await fixture.completed('codex_archive', { threadId: thread })).state, 'completed');
  } finally { await fixture.close(); await rm(hooks, { recursive: true, force: true }); }
});

async function sharedCodexFixture() {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const primary = await mkdtemp(path.join(tmpdir(), 'arc-codex-primary-'));
  const config = (effort: string) => `approval_policy = "never"\nsandbox_mode = "danger-full-access"\nmodel_reasoning_effort = "${effort}"\n[mcp_servers.example]\nurl = "https://example.test/mcp"\n[features]\nmulti_agent = true\n`;
  await writeFile(path.join(primary, 'config.toml'), config('low'));
  await writeFile(path.join(primary, 'AGENTS.md'), 'Shared instruction fixture');
  await mkdir(path.join(primary, 'skills', 'example-skill'), { recursive: true });
  await writeFile(path.join(primary, 'skills', 'example-skill', 'SKILL.md'), 'Example shared skill');
  const pluginDirectory = path.join(primary, 'plugins', 'cache', 'example-plugin');
  const pluginContents = 'Example installed plugin asset';
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(path.join(pluginDirectory, 'plugin.txt'), pluginContents);
  const script = `import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto'; import fs from 'node:fs'; import path from 'node:path';
const home=process.env.CODEX_HOME; fs.mkdirSync(home,{recursive:true});
const loadSetup=()=>{
const config=fs.existsSync(path.join(home,'config.toml'))?fs.readFileSync(path.join(home,'config.toml'),'utf8'):'';
const policy=/^approval_policy\\s*=\\s*"([^"]+)"/m.exec(config)?.[1];
const effort=/^model_reasoning_effort\\s*=\\s*"([^"]+)"/m.exec(config)?.[1];
return {policy,effort,instructions:fs.existsSync(path.join(home,'AGENTS.md'))?fs.readFileSync(path.join(home,'AGENTS.md'),'utf8'):null,skills:fs.existsSync(path.join(home,'skills'))?fs.readdirSync(path.join(home,'skills')).filter(name=>name==='example-skill'):[],mcp:config.includes('[mcp_servers.example]')};
};
const auth=fs.existsSync(path.join(home,'auth.json'))?JSON.parse(fs.readFileSync(path.join(home,'auth.json'),'utf8')):null;
let account=auth?.tokens?.account_id??'primary'; const file=path.join(home,'fixture-tasks.json');
const tasks=()=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{}; const save=rows=>fs.writeFileSync(file,JSON.stringify(rows));
const activeThreads=new Set();
for await(const line of createInterface({input:process.stdin})) {
 const {id,method,params}=JSON.parse(line);if(id===undefined)continue;let result={};const rows=tasks();const row=rows[params?.threadId];
 if(method==='account/login/start') {account=params.accessToken;result={type:params.type};}
 if(method==='account/read')result={account:{type:'chatgpt',accountId:account,email:account+'@example.test',planType:'pro'}};
 if(method==='account/rateLimits/read')result={rateLimits:{primary:{usedPercent:0,windowDurationMins:300}}};
 if(method==='model/list')result={data:[{id:'fixture-model',model:'fixture-model',supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low'}]};
 if(method==='thread/start'){const created={id:randomUUID(),cwd:home,updatedAt:Date.now(),status:{type:'idle'},turns:[],setup:loadSetup()};rows[created.id]=created;save(rows);result={thread:created};}
 if(method==='thread/read')result={thread:{...row,status:row.status.type==='active'&&!activeThreads.has(row.id)?{type:'notLoaded'}:row.status}};
 if(method==='thread/turns/list')result={data:[...row.turns].reverse(),nextCursor:null};
 if(method==='thread/loaded/list')result={data:Object.keys(rows)};
 if(method==='thread/list')result={data:Object.values(rows),nextCursor:null};
 if(method==='turn/start'){
  if(row.setup.policy!=='never'){console.log(JSON.stringify({id,error:{code:-32000,message:'Command approval required by missing shared policy'}}));continue;}
  const active=params.input?.some(i=>i.text==='hold'); const turn={id:randomUUID(),status:active?'inProgress':'completed',items:[{id:randomUUID(),type:'agentMessage',text:JSON.stringify(row.setup)}]};
  if(active)activeThreads.add(row.id);else activeThreads.delete(row.id);
  row.status={type:active?'active':'idle'};row.turns.push(turn);save(rows);result={turn};
 }
 if(method==='turn/steer')result={turnId:row.turns.at(-1).id};
 if(method==='turn/interrupt'){activeThreads.delete(row.id);row.status={type:'idle'};row.turns.at(-1).status='interrupted';save(rows);}
 console.log(JSON.stringify({id,result}));
}`;
  const fixture = await nativeControl(script, { CODEX_HOME: primary });
  return { fixture, primary, config, pluginDirectory, pluginContents, writeFile, mkdir, rm };
}

test('Codex dispatch picks up shared configuration while an existing task stays active', async () => {
  // Regression: shared config change blocks dispatch while a task is active.
  const { fixture, primary, config, pluginDirectory, pluginContents, writeFile, mkdir, rm } = await sharedCodexFixture();
  const path = await import('node:path');
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
      assert.equal(parity.state, 'shared');
      assert.equal(detail.agentProfiles.find((p: any) => p.profileId === account.profileId).role, 'secondary');
    }
    const allAccounts = [{ accountId: primaryAccount.id }, ...imported];
    assert.equal((await dispatch(allAccounts[0])).setup.effort, 'low');
    await writeFile(path.join(primary, 'config.toml'), config('medium'));
    for (const account of allAccounts) assert.equal((await dispatch(account)).setup.effort, 'medium');
    const held = await dispatch(imported[0], 'hold');
    await rm(pluginDirectory, { recursive: true });
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(path.join(pluginDirectory, 'plugin.txt'), pluginContents);
    const unchanged = await fixture.call('accounts', { id: imported[0].accountId });
    assert.equal(unchanged.agentProfiles.find((profile: any) => profile.profileId === imported[0].profileId).parity.state, 'shared');
    assert.equal((await dispatch(imported[0])).setup.effort, 'medium');
    const stillActive = await fixture.call('codex_query', { method: 'thread/read', params: { threadId: held.receipt.threadId, includeTurns: false } });
    assert.equal(stillActive.thread.status.type, 'active');
    await writeFile(path.join(primary, 'config.toml'), config('high'));
    await writeFile(path.join(primary, 'AGENTS.md'), 'Updated shared instruction fixture');
    await rm(path.join(primary, 'skills', 'example-skill'), { recursive: true });
    const current = await dispatch(imported[0]);
    assert.deepEqual(current.setup, { policy: 'never', effort: 'high', instructions: 'Updated shared instruction fixture', skills: [], mcp: true });
    const active = await fixture.call('codex_query', { method: 'thread/read', params: { threadId: held.receipt.threadId, includeTurns: true } });
    assert.equal(active.thread.status.type, 'active');
    assert.equal(active.thread.turns.at(-1).id, held.receipt.turnId);
    assert.equal(active.thread.turns.at(-1).status, 'inProgress');
    const steered = await fixture.completed('codex_send', { threadId: held.receipt.threadId, sendMode: 'steer', prompt: 'Continue the held task' });
    assert.equal(steered.state, 'completed', JSON.stringify(steered));
    assert.equal((await fixture.completed('codex_interrupt', { threadId: held.receipt.threadId, turnId: held.receipt.turnId })).state, 'completed');
    const resumed = await fixture.completed('codex_resume', { threadId: held.receipt.threadId, turnId: held.receipt.turnId });
    assert.equal(resumed.state, 'completed', JSON.stringify(resumed));
    const resumedThread = await fixture.call('codex_query', { method: 'thread/read', params: { threadId: held.receipt.threadId, includeTurns: true } });
    assert.equal(resumedThread.thread.id, held.receipt.threadId);
    const continuation = await fixture.completed('codex_send', { threadId: held.receipt.threadId, account: imported[0].accountId, prompt: 'inspect', model: 'fixture-model' });
    assert.equal(continuation.state, 'completed', JSON.stringify(continuation));
    assert.equal(continuation.agentAccountId, imported[0].accountId);
    assert.equal((await dispatch(imported[0])).setup.effort, 'high');
    await fixture.restart();
    for (const account of imported) {
      const detail = await fixture.call('accounts', { id: account.accountId });
      assert.equal(detail.agentProfiles.find((profile: any) => profile.profileId === account.profileId).parity.state, 'shared');
      assert.equal((await dispatch(account)).setup.policy, 'never');
    }
  } finally { await fixture.close(); await rm(primary, { recursive: true, force: true }); }
});

test('Codex account and quota reads remain available after shared configuration changes', async () => {
  // Regression: shared config changes made active-account quota unavailable in dispatch_policy.
  const { fixture, primary, config, writeFile, rm } = await sharedCodexFixture();
  const path = await import('node:path');
  try {
    const account = await fixture.call('account_import', { auth: { tokens: { access_token: 'quota', account_id: 'quota' } }, refreshOwner: 'none' });
    assert.equal(account.state, 'completed', JSON.stringify(account));
    const held = await fixture.completed('codex_create', { account: account.accountId, prompt: 'hold', model: 'fixture-model' });
    assert.equal(held.state, 'completed', JSON.stringify(held));
    await writeFile(path.join(primary, 'config.toml'), config('high'));
    const refreshed = await fixture.api('accounts/refresh-quota', { id: account.accountId });
    assert.equal(refreshed.quota.windows[0].usedPercent, 0, JSON.stringify(refreshed.quota));
    const detail = await fixture.call('accounts', { id: account.accountId });
    assert.equal(detail.quota.windows[0].usedPercent, 0, JSON.stringify(detail.quota));
    const policy = await fixture.call('dispatch_policy', { agent: 'codex', view: 'full' });
    const selected = policy.agents.find((row: any) => row.agent === 'codex').accounts.find((row: any) => row.id === account.accountId);
    assert.equal(selected.quota.windows[0].usedPercent, 0, JSON.stringify(selected));
    const active = await fixture.call('codex_query', { method: 'thread/read', params: { threadId: held.threadId, includeTurns: false } });
    assert.equal(active.thread.status.type, 'active');
    // Fingerprint inspection can fail independently of the native account reader.
    await writeFile(path.join(primary, 'config.toml'), 'invalid = "unterminated\n');
    await fixture.restart();
    const afterRestart = await fixture.api('accounts/refresh-quota', { id: account.accountId });
    assert.equal(afterRestart.agentProfiles.find((profile: any) => profile.profileId === account.profileId).parity.state, 'error');
    assert.equal(afterRestart.quota.windows[0].usedPercent, 0, JSON.stringify(afterRestart.quota));
  } finally { await fixture.close(); await rm(primary, { recursive: true, force: true }); }
});

test('Claude credential profiles share native transcripts and retain legacy data for explicit migration', { skip: process.platform === 'win32' }, async () => {
  // Regression: credential profiles kept separate Claude projects trees inside ARC state.
  const { mkdtemp, mkdir, writeFile, readFile, realpath, unlink, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const directory = await mkdtemp(path.join(tmpdir(), 'arc-native-claude-'));
  const projects = path.join(directory, '.claude', 'projects');
  await mkdir(projects, { recursive: true });
  const retained = path.join(projects, 'retained.jsonl');
  await writeFile(retained, 'Native session data');
  const observed = path.join(directory, 'observed.jsonl');
  const cli = path.join(directory, 'claude');
  await writeFile(cli, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2),config=process.env.CLAUDE_CONFIG_DIR;
if(args[0]==='auth'&&args[1]==='login')process.exitCode=0;
else if(args[0]==='auth'&&args[1]==='status')console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',accountId:path.basename(path.dirname(config)),email:path.basename(path.dirname(config))+'@example.test',orgName:'Fixture'}));
else if(args[0]==='-p'){fs.appendFileSync(${JSON.stringify(observed)},JSON.stringify({profile:path.basename(path.dirname(config)),projects:fs.realpathSync(path.join(config,'projects'))})+'\\n');console.log(JSON.stringify({ok:true,session_id:args[3]}));}
else throw Error('Unexpected native fixture operation');
`, { mode: 0o755 });
  const fixture = await nativeControl(server, { HOME: directory, USERPROFILE: directory, PATH: directory + path.delimiter + process.env.PATH });
  try {
    const accounts = [];
    for (let i = 0; i < 2; i++) {
      await fixture.call('account_add', { kind: 'claude' });
      const deadline = Date.now() + 5000;
      let progress;
      do {
        progress = await fixture.call('accounts', { agent: 'claude' });
        if (progress.login?.state === 'completed') break;
        await new Promise(resolve => setTimeout(resolve, 20));
      } while (Date.now() < deadline);
      assert.equal(progress.login?.state, 'completed', JSON.stringify(progress));
      const account = await fixture.call('accounts', { id: progress.login.accountId });
      const sent = await fixture.call('account_notify', { id: account.id, action: 'send', target: 'session_01000000000000000000002' + (i + 1), message: 'Native session fixture' });
      assert.equal(sent.deliveryStatus, 'delivered', JSON.stringify(sent));
      accounts.push(account);
    }
    assert.notEqual(accounts[0].id, accounts[1].id);
    const observations = (await readFile(observed, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const nativeProjects = await realpath(projects);
    for (const account of accounts) assert.equal(observations.find(row => row.profile === account.agentProfiles[0].profileId).projects, nativeProjects);
    assert.equal(await readFile(retained, 'utf8'), 'Native session data');
    let legacy = '';
    await fixture.restart(async state => {
      const projects = path.join(state, 'claude-accounts', accounts[0].agentProfiles[0].profileId, 'config', 'projects');
      await unlink(projects);
      await mkdir(projects);
      legacy = path.join(projects, 'legacy.jsonl');
      await writeFile(legacy, 'Unmigrated native session');
    });
    assert.equal((await fixture.call('accounts', { id: accounts[0].id })).orgName, 'Fixture');
    const blocked = await fixture.call('account_notify', { id: accounts[0].id, action: 'send', target: 'session_010000000000000000000021', message: 'Must retain legacy history' });
    assert.equal(blocked.error.code, 'CLAUDE_SESSION_MIGRATION_REQUIRED', JSON.stringify(blocked));
    assert.equal(await readFile(legacy, 'utf8'), 'Unmigrated native session');
    assert.equal(await readFile(retained, 'utf8'), 'Native session data');
  } finally { await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});
