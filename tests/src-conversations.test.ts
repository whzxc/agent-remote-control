import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nativeControl } from './helpers/native-control.ts';

const server = `import {createInterface} from 'node:readline'; import {randomUUID} from 'node:crypto';
import {mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
mkdirSync(process.env.CODEX_HOME,{recursive:true});
const storage=process.env.CODEX_HOME+'/fixture-threads.json';
const threads=new Map(existsSync(storage)?JSON.parse(readFileSync(storage,'utf8')):[]);
for await (const line of createInterface({input:process.stdin})) {
 const {id,method,params}=JSON.parse(line); if(id===undefined)continue;
 let result={};
 if(method==='account/read')result={account:{type:'chatgpt',email:'person@example.com',planType:'plus'}};
 if(method==='account/rateLimits/read')result={rateLimits:{}};
 if(method==='model/list')result={data:[]};
 if(method==='thread/start'){const t={id:randomUUID(),cwd:params.cwd,turns:[]};threads.set(t.id,t);result={thread:t};}
 if(method==='thread/read')result={thread:{...threads.get(params.threadId),status:{type:'idle'}}};
 if(method==='thread/resume')result={thread:threads.get(params.threadId)};
 if(method==='thread/turns/list')result={data:[...threads.get(params.threadId).turns].reverse(),nextCursor:null};
 if(method==='turn/start'){const turn={id:randomUUID(),status:'completed',items:[]};threads.get(params.threadId).turns.push(turn);result={turn};}
 writeFileSync(storage,JSON.stringify([...threads]));console.log(JSON.stringify({id,result}));
}`;

test('Verified session aliases preserve Chat identity and task links through Core restart', {skip:process.platform !== 'darwin'}, async () => {
  // Regression: AX ax-8b883850 split one Chat and its verified session into separate registry records with missing taskRefs.
  const directory=await mkdtemp(path.join(tmpdir(),'arc-src-alias-'));
  const deliveries=path.join(directory,'deliveries.jsonl');
  await writeFile(path.join(directory,'claude'),`#!${process.execPath}
const {appendFileSync}=require('node:fs');
const args=process.argv.slice(2);
if(args[0]==='auth' && args[1]==='status') console.log(JSON.stringify({loggedIn:true,email:'alias@example.com',authMethod:'claude.ai',orgId:'550e8400-e29b-41d4-a716-446655440000'}));
else if(args[0]==='auth' && args[1]==='login') process.exitCode=0;
else if(args[0]==='-p') {appendFileSync(${JSON.stringify(deliveries)},JSON.stringify({target:args[3],message:args[1]})+'\\n');console.log(JSON.stringify({ok:true,session_id:args[3]}));}
else throw new Error('Unexpected fixture CLI operation');
`);
  await chmod(path.join(directory,'claude'),0o755);
  const fixture=await nativeControl(server,{ARC_FIXTURE_SNAPSHOT:'src-conversations',PATH:directory+path.delimiter+process.env.PATH,HOME:directory});
  try {
    const source='alias-source';
    await fixture.api('ingress',{id:source,name:source,controlSource:'claude',transport:'https',auth:'bearer',bearerToken:'synthetic-alias'.padEnd(40,'x'),toolPolicy:'all',config:{httpsProvider:'custom',httpsUrl:'https://fixture.example.com/mcp'}});
    await fixture.api(`ingress/${source}/start`,{});
    const login=await fixture.api('accounts/add',{kind:'claude'});
    let accounts=await fixture.api('accounts');
    const deadline=Date.now()+5000;
    while(accounts.login?.state!=='completed' && Date.now()<deadline) {
      await new Promise(resolve=>setTimeout(resolve,20));
      accounts=await fixture.api('accounts');
    }
    assert.equal(accounts.login.state,'completed',JSON.stringify(accounts.login));
    const call=(op:string,args:Record<string,unknown>={},tool:'act'|'query'='act')=>fixture.sourceCall(source,op,args,tool);
    const inventory=async()=> (await call('src_conversations',{accountId:login.accountId},'query')).accounts[0];
    const confirm=async(target:string,threadId?:string)=>{
      const bound=await call('notify_control',{action:'bind',target,accountId:login.accountId,...(threadId?{threadId}:{})});
      assert.equal(bound.verification.deliveryStatus,'delivered',JSON.stringify(bound));
      const delivered=(await readFile(deliveries,'utf8')).trim().split('\n').map(row=>JSON.parse(row)).filter(row=>row.target===target && row.message.includes('notification_ack')).at(-1);
      assert.ok(delivered);
      const challenge=JSON.parse(delivered.message.slice(delivered.message.indexOf('{'),delivered.message.lastIndexOf('}')+1));
      assert.equal((await call('notification_ack',challenge.args)).reachability,'verified');
    };
    // No active Chat: keep a separate session record, then establish the source identity.
    const standalone='session_010000000000000000000031';
    await confirm(standalone);
    assert.equal((await call('whoami',{},'query')).id,login.accountId);
    const initial=(await inventory()).conversations;
    assert.equal(initial.length,1);
    assert.equal(initial[0].kind,'cowork');
    assert.deepEqual(initial[0].aliases,[]);
    const firstSeen=initial[0].firstSeenAt;
    await fixture.api('task-settings',{autoOpenCodex:false,enabled:false},'PUT');
    const create=async(notify:unknown)=>{
      const receipt=await call('codex_create',{prompt:'Synthetic alias regression',notify,requestId:randomUUID(),waitMs:10000});
      assert.equal(receipt.state,'completed',JSON.stringify(receipt));
      return receipt.threadId as string;
    };
    const coworkTask=await create({channel:'claude-session',target:standalone});
    const chat=randomUUID(),chatUrl=`https://claude.ai/chat/${chat}`;
    await call('src_conversation_open',{accountId:login.accountId,url:chatUrl});
    const task=await create(null);
    assert.equal((await call('codex_read',{threadId:task},'query')).srcConversation.basis,'correlated');
    // A fresh handshake merges the existing session and upgrades the bound Chat task.
    await confirm(standalone,task);
    let row=(await inventory()).conversations.find((r:any)=>r.id===chat);
    assert.equal((await inventory()).conversations.length,1);
    assert.equal(row.kind,'chat'); assert.equal(row.url,chatUrl); assert.equal(row.basis,'observed');
    assert.equal(row.firstSeenAt,firstSeen);
    assert.deepEqual(row.aliases,[standalone.replace('session_','cse_')]);
    assert.deepEqual(new Set(row.taskRefs.map((r:any)=>r.id)),new Set([task,coworkTask]));
    for(const threadId of [task,coworkTask]) {
      const read=await call('codex_read',{threadId},'query');
      assert.equal(read.srcConversation.id,chat);
      assert.equal(read.srcConversation.basis,'notify-target');
    }
    // New session, one active Chat: alias immediately, without first creating Cowork.
    const alias='session_010000000000000000000032';
    await confirm(alias);
    assert.equal((await inventory()).conversations.length,1);
    const aliasedTask=await create({channel:'claude-session',target:alias});
    assert.equal((await call('codex_read',{threadId:aliasedTask},'query')).srcConversation.id,chat);
    const lateTask=await create(null);
    await call('notify_control',{action:'bind',target:alias,threadId:lateTask,accountId:login.accountId,verify:false});
    assert.equal((await call('codex_read',{threadId:lateTask},'query')).srcConversation.basis,'notify-target');
    // Two recently active Chats: no inference, including on a later registry read.
    const second=randomUUID();
    await call('src_conversation_open',{accountId:login.accountId,url:`https://claude.ai/chat/${second}`});
    const secondTask=await create(null);
    const ambiguous='session_010000000000000000000033';
    await confirm(ambiguous,secondTask);
    assert.equal((await call('codex_read',{threadId:secondTask},'query')).srcConversation.kind,'cowork');
    await fixture.restart();
    const restarted=await inventory();
    assert.equal(restarted.open,false);
    assert.equal(restarted.conversations.length,3);
    row=restarted.conversations.find((r:any)=>r.id===chat);
    assert.deepEqual(new Set(row.aliases),new Set([standalone,alias].map(t=>t.replace('session_','cse_'))));
    assert.equal(row.firstSeenAt,firstSeen);
    assert.ok(row.taskRefs.some((r:any)=>r.id===lateTask && r.basis==='notify-target'));
    assert.equal((await call('codex_read',{threadId:task},'query')).srcConversation.id,chat);
    const afterRestart=await create({channel:'claude-session',target:alias});
    assert.equal((await call('codex_read',{threadId:afterRestart},'query')).srcConversation.id,chat);
    const rebound=await call('src_conversation_bind',{accountId:login.accountId,agent:'codex',taskId:task,conversationId:alias.replace('session_','cse_')});
    assert.equal(rebound.conversation.id,chat);
    assert.equal(rebound.conversation.basis,'manual');
    await call('src_conversation_bind',{accountId:login.accountId,agent:'codex',taskId:task,conversationId:second});
    await call('notify_control',{action:'bind',target:alias,threadId:task,accountId:login.accountId,verify:false});
    const manual=(await call('codex_read',{threadId:task},'query')).srcConversation;
    assert.equal(manual.id,second); assert.equal(manual.basis,'manual');
  } finally { await fixture.close(); await rm(directory,{recursive:true,force:true}); }
});

test('Source conversation ops isolate accounts and persist bindings through restart', {skip:process.platform !== 'darwin'}, async () => {
  // Contract: src ops preserve source-account scope, task refs and manual binding through the frozen query/act surface.
  const fixture = await nativeControl(server, {ARC_FIXTURE_SNAPSHOT:'src-conversations'});
  try {
    const owners: Array<{ingressId:string; accountId:string}> = [];
    for (const id of ['src-owner-a','src-owner-b']) {
      const ingress = await fixture.api('ingress', {id,name:id,controlSource:'claude',transport:'https',auth:'bearer',bearerToken:'synthetic-fixture'.padEnd(40,'x'),toolPolicy:'all',config:{httpsProvider:'custom',httpsUrl:'https://fixture.example.com/mcp'}});
      await fixture.api(`ingress/${ingress.id}/start`, {});
      const self = await fixture.sourceCall(ingress.id,'whoami',{},'query');
      assert.ok(self.id);
      owners.push({ingressId:ingress.id,accountId:self.id});
    }
    const [a,b]=owners;
    const chat=randomUUID(), second=randomUUID();
    const chatUrl=`https://claude.ai/chat/${chat}`, secondUrl=`https://claude.ai/chat/${second}`;
    for (const op of ['src_conversations','src_chrome_profiles','src_conversation_open','src_login_import','src_login_clear','src_conversation_bind']) {
      const guide=await fixture.call('guide',{op});
      assert.equal(guide.op,op);
      assert.equal(guide.retry.mode,op==='src_conversations'||op==='src_chrome_profiles'?'read-only':'read-back');
    }
    const opened=await fixture.sourceCall(a.ingressId,'src_conversation_open',{accountId:a.accountId,url:chatUrl});
    assert.equal(opened.accountId,a.accountId);
    const denied=await fixture.sourceCall(a.ingressId,'src_conversation_open',{accountId:b.accountId});
    assert.equal(denied.error.code,'SRC_ACCOUNT_SCOPE');
    const invalid=await fixture.sourceCall(a.ingressId,'src_conversation_open',{accountId:a.accountId,url:'https://example.com/chat/'+chat});
    assert.equal(invalid.error.code,'SRC_URL_INVALID');
    await fixture.api('task-settings',{autoOpenCodex:false,enabled:false},'PUT');
    const requestId=randomUUID();
    const receipt=await fixture.sourceCall(a.ingressId,'codex_create',{prompt:'Synthetic task',notify:null,requestId,waitMs:10000});
    assert.equal(receipt.state,'completed',JSON.stringify(receipt));
    const task=receipt.threadId;
    assert.ok(task);
    const read=await fixture.sourceCall(a.ingressId,'codex_read',{threadId:task},'query');
    assert.equal(read.srcConversation.id,chat);
    assert.equal(read.srcConversation.basis,'correlated');
    let registry=await fixture.sourceCall(a.ingressId,'src_conversations',{},'query');
    assert.ok(owners.every(owner=>registry.accounts.some((row:any)=>row.accountId===owner.accountId)));
    const untouched=registry.accounts.find((row:any)=>row.accountId===b.accountId);
    assert.equal(untouched.status,'not-imported');
    assert.equal(untouched.storeId,null);
    const selected=registry.accounts.find((row:any)=>row.accountId===a.accountId);
    let store=selected.storeId;
    assert.ok(store);
    assert.equal(selected.conversations[0].taskRefs[0].id,task);
    await fixture.sourceCall(a.ingressId,'src_conversation_open',{accountId:a.accountId,url:secondUrl});
    // The authenticated Desktop channel publishes URL metadata; no native window is involved.
    await fixture.api('src-conversations/observe',{containers:[{accountId:a.accountId,storeId:store,status:'signed-in',active:true,url:secondUrl}]});
    const rebound=await fixture.sourceCall(a.ingressId,'src_conversation_bind',{accountId:a.accountId,agent:'codex',taskId:task,conversationId:second});
    assert.equal(rebound.conversation.id,second);
    assert.equal(rebound.conversation.basis,'manual');
    const peer=await fixture.sourceCall(b.ingressId,'src_conversation_bind',{accountId:b.accountId,agent:'codex',taskId:task,conversationId:null});
    assert.equal(peer.error.code,'SRC_TASK_SCOPE');
    // Receipt replay cannot recapture a different page or overwrite a manual correction.
    await fixture.sourceCall(a.ingressId,'codex_create',{prompt:'Synthetic task',notify:null,requestId,waitMs:10000});
    assert.equal((await fixture.sourceCall(a.ingressId,'codex_read',{threadId:task},'query')).srcConversation.id,second);
    await fixture.sourceCall(b.ingressId,'src_conversation_open',{accountId:b.accountId,url:chatUrl});
    await fixture.sourceCall(a.ingressId,'src_conversation_open',{accountId:a.accountId});
    const sent=await fixture.sourceCall(a.ingressId,'codex_send',{threadId:task,prompt:'Synthetic follow-up',notify:null,waitMs:10000});
    assert.equal(sent.state,'completed',JSON.stringify(sent));
    assert.equal((await fixture.sourceCall(a.ingressId,'codex_read',{threadId:task},'query')).srcConversation,null);
    await fixture.sourceCall(a.ingressId,'src_conversation_bind',{accountId:a.accountId,agent:'codex',taskId:task,conversationId:second});
    await fixture.restart();
    registry=await fixture.call('src_conversations',{accountId:a.accountId});
    assert.equal(registry.accounts[0].storeId,store);
    assert.equal(registry.accounts[0].open,false);
    assert.equal(registry.accounts[0].currentConversation,null);
    assert.equal(registry.accounts[0].conversations.find((r:any)=>r.id===second).taskRefs[0].basis,'manual');
    const cleared=await fixture.call('src_login_clear',{accountId:a.accountId});
    assert.equal(cleared.status,'not-imported');
    const kept=(await fixture.call('src_conversations',{accountId:a.accountId})).accounts[0];
    assert.equal(kept.storeId,null);
    assert.equal(kept.open,false);
    assert.equal(kept.conversations.find((r:any)=>r.id===second).taskRefs[0].basis,'manual');
    await fixture.sourceCall(a.ingressId,'src_conversation_open',{accountId:a.accountId});
    const reopened=(await fixture.call('src_conversations',{accountId:a.accountId})).accounts[0];
    assert.notEqual(reopened.storeId,store);
    store=reopened.storeId;
    const unbound=await fixture.call('src_conversation_bind',{accountId:a.accountId,agent:'codex',taskId:task,conversationId:null});
    assert.equal(unbound.conversation,null);
    const after=await fixture.call('src_conversations',{accountId:a.accountId});
    assert.ok(after.accounts[0].conversations.every((r:any)=>r.taskRefs.length===0));
    const importing=await fixture.sourceCall(a.ingressId,'src_login_import',{accountId:a.accountId,profile:'Default'});
    assert.equal(importing.status,'importing');
    assert.equal(importing.next.op,'src_conversations');
    assert.deepEqual(importing.next.args,{accountId:a.accountId});
    assert.equal((await fixture.sourceCall(a.ingressId,'src_login_import',{accountId:a.accountId,profile:'Default'})).status,'importing');
    const progress=await fixture.sourceCall(a.ingressId,'src_conversations',{accountId:a.accountId},'query');
    assert.equal(progress.accounts[0].status,'importing');
    await fixture.api('src-conversations/observe',{containers:[{accountId:a.accountId,storeId:store,status:'import-blocked',reason:'keychain-timeout',open:false}]});
    const blocked=await fixture.sourceCall(a.ingressId,'src_conversations',{accountId:a.accountId},'query');
    assert.equal(blocked.accounts[0].status,'import-blocked');
    assert.equal(blocked.accounts[0].reason,'keychain-timeout');
    assert.ok(blocked.accounts[0].hint.includes('macOS login password'));
    assert.ok(blocked.accounts[0].hint.includes('Always Allow'));
    assert.equal(blocked.accounts[0].open,false);
    await fixture.api('src-conversations/observe',{containers:[{accountId:a.accountId,storeId:store,status:'import-mismatch',detectedAccountId:b.accountId,open:false}]});
    const mismatch=(await fixture.call('src_conversations',{accountId:a.accountId})).accounts[0];
    assert.equal(mismatch.status,'import-mismatch');
    assert.equal(mismatch.detectedAccountId,b.accountId);
    await fixture.api('src-conversations/observe',{containers:[{accountId:a.accountId,storeId:store,status:'import-unverified',open:false}]});
    const unverified=(await fixture.call('src_conversations',{accountId:a.accountId})).accounts[0];
    assert.equal(unverified.status,'import-unverified');
    assert.equal(unverified.detectedAccountId,null);
  } finally {await fixture.close();}
});


test('Source inventory includes other Claude accounts before a website container exists', {skip:process.platform !== 'darwin'}, async () => {
  // Regression: src_conversations reused mutation ownership filtering and hid another known Claude SRC account.
  const fixture=await nativeControl(server,{ARC_FIXTURE_SNAPSHOT:'src-conversations'});
  try {
    const owners:Array<{source:string;account:string}>=[];
    for (const id of ['inventory-one','inventory-two']) {
      await fixture.api('ingress',{id,name:id,controlSource:'claude',transport:'https',auth:'bearer',bearerToken:'synthetic-inventory'.padEnd(40,'x'),toolPolicy:'all',config:{httpsProvider:'custom',httpsUrl:'https://fixture.example.com/mcp'}});
      await fixture.api(`ingress/${id}/start`,{});
      const who=await fixture.sourceCall(id,'whoami',{},'query');
      owners.push({source:id,account:who.id});
    }
    const listed=await fixture.sourceCall(owners[0].source,'src_conversations',{},'query');
    for (const owner of owners) {
      const row=listed.accounts.find((a:any)=>a.accountId===owner.account);
      assert.ok(row);
      assert.equal(row.status,'not-imported');
      assert.equal(row.storeId,null);
    }
    const peer=await fixture.sourceCall(owners[0].source,'src_conversations',{accountId:owners[1].account},'query');
    assert.equal(peer.accounts[0].accountId,owners[1].account);
    const denied=await fixture.sourceCall(owners[0].source,'src_login_clear',{accountId:owners[1].account});
    assert.equal(denied.error.code,'SRC_ACCOUNT_SCOPE');
  } finally {await fixture.close();}
});
