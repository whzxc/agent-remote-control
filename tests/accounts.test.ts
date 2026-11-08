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
  // Regression: adding a Codex account replaced the system login and sends could select a different task account.
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
 if(method==='turn/start'){const turn={id:randomUUID(),status:'completed',items:[{id:randomUUID(),type:'agentMessage',text:account}]};row.turns.push(turn);save(rows);result={turn};if(params.input?.some(i=>i.text==='refresh')){refreshTurn={id,turn};console.log(JSON.stringify({id:'refresh',method:'account/chatgptAuthTokens/refresh',params:{reason:'unauthorized',previousAccountId:'workspace-'+account}}));continue;}}
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
    assert.equal((await fixture.completed('codex_archive', { threadId: thread })).state, 'completed');
  } finally { await fixture.close(); await rm(hooks, { recursive: true, force: true }); }
});
