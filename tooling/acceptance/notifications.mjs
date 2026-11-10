// Isolated MCP acceptance: no real Agent, account, notification target or unit-test hooks.
import { requireMainCheckout } from '../coding-lane.mjs';
requireMainCheckout();
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, chmod, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const repo=fileURLToPath(new URL('../../',import.meta.url));
const out=path.resolve(process.argv[2]??path.join(repo,'output/acceptance/notifications'));
const dir=await mkdtemp(path.join(tmpdir(),'arc-notification-self-test-'));
const report={purpose:'self-test',checks:[],evidenceGaps:['Real Claude cloud receipt and acknowledgement require the target conversation.'],defects:[]};
let client;
const save=async(name,value)=>{await mkdir(out,{recursive:true});await writeFile(path.join(out,name+'.json'),JSON.stringify(value,null,2)+'\n');};
const put=async(name,value)=>{const file=path.join(dir,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value));};
const read=async name=>JSON.parse(await readFile(path.join(dir,name),'utf8'));
const check=(name,value)=>{assert.ok(value,name);report.checks.push(name);};
const catalog=JSON.parse(await readFile(path.join(repo,'native/src/catalog.json'),'utf8'));
const fixture=path.join(repo,'target/debug/contract-fixture');
const env={...process.env,HOME:path.join(dir,'home'),USERPROFILE:path.join(dir,'home'),XDG_CONFIG_HOME:path.join(dir,'home'),PATH:path.join(dir,'bin')+path.delimiter+process.env.PATH,ARC_STATE_DIR:dir,ARC_FIXTURE_BINARY:process.execPath,ARC_FIXTURE_SCRIPT:path.join(dir,'codex.mjs')};
async function connect(){client=new Client({name:'notification-self-test',version:'1'});await client.connect(new StdioClientTransport({command:fixture,env,stderr:'pipe'}));}
async function call(op,args={},expectError=false){
 const name=op==='guide'?'guide':catalog.ops.find(o=>o.name===op).annotations.readOnlyHint?'query':'act';
 const r=await client.callTool({name,arguments:name==='guide'?args:{op,args}});
 assert.equal(Boolean(r.isError),expectError,op+': '+JSON.stringify(r));
 return r.structuredContent.result;
}
async function dispatch(op='codex_create',args={}){
 let r=await call(op,{...(op==='codex_create'?{project:dir}:{}),prompt:'Reply SELF_TEST_OK without tools.',model:'fixture-notify',effort:'high',purpose:'self-test',notify:{channel:'claude-session',target:'session_selftest'},requestId:randomUUID(),waitMs:1000,...args});
 while(['reserved','executing'].includes(r.state)){await new Promise(r=>setTimeout(r,50));r=await call('receipt',{requestId:r.requestId});}
 assert.equal(r.state,'completed',JSON.stringify(r));return r;
}
const status=async()=>{const s=await call('notify_status',{target:'session_selftest'});return s.targets.find(t=>t.target==='session_selftest');};
async function received(){const text=await readFile(path.join(dir,'delivered.txt'),'utf8');return {target:'session_selftest',code:text.match(/◎ ping · (\S+)/)[1]};}
try{
 await mkdir(env.HOME,{recursive:true});await mkdir(path.join(dir,'bin'));
 await put('ingresses/index.json',['default']);
 await put('ingresses/default/config.json',{id:'default',name:'Self-test',controlSource:'claude',transport:'openai-tunnel',auth:'openai',enabled:true,toolPolicy:'all',config:{}});
 await put('ingresses/default/secrets.json',{});
 await put('task-settings.json',{autoOpenCodex:false,notificationBucketCapacity:100});
 await put('dispatch-policy.json',{});
 await writeFile(path.join(dir,'bin/claude'),`#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);if(a.includes('--version')){console.log('fixture');process.exit(0);}if(fs.existsSync(process.env.ARC_STATE_DIR+'/fail-send'))process.exit(1);fs.writeFileSync(process.env.ARC_STATE_DIR+'/delivered.txt',a[1]);console.log(JSON.stringify({ok:true,session_id:a[a.indexOf('--cloud')+1]}));\n`);await chmod(path.join(dir,'bin/claude'),0o755);
 // Durable native fixture is shared by the independent seed reader and turn owner.
 await writeFile(path.join(dir,'acp.mjs'),`import {createInterface} from 'node:readline';const emit=v=>console.log(JSON.stringify(v));for await(const l of createInterface({input:process.stdin})){const {id,method}=JSON.parse(l);if(id===undefined)continue;let result={};if(method==='initialize')result={protocolVersion:1,agentCapabilities:{}};if(method==='session/new')result={sessionId:'self-test-session'};if(method==='session/prompt'){emit({jsonrpc:'2.0',method:'session/update',params:{sessionId:'self-test-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'SELF_TEST_OK'}}}});result={stopReason:'end_turn'};}emit({jsonrpc:'2.0',id,result});}`);
 await put('agents/manifests.json',[{id:'notification-fixture',command:process.execPath,args:[path.join(dir,'acp.mjs')],versionArgs:[],protocol:'acp-v1'}]);
 await writeFile(env.ARC_FIXTURE_SCRIPT,`
import {createInterface} from 'node:readline';import fs from 'node:fs';import {randomUUID} from 'node:crypto';
const file=process.env.ARC_STATE_DIR+'/native-tasks.json';const emit=(id,result)=>console.log(JSON.stringify({id,result}));
for await(const line of createInterface({input:process.stdin})){
 const {id,method,params:p={}}=JSON.parse(line);if(id===undefined)continue;
 const rows=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{};let result={};
 if(method==='initialize')result={userAgent:'fixture'};
 if(['model/list','project/list','thread/list'].includes(method))result={data:[],nextCursor:null};
 if(method==='thread/start'){const thread={id:randomUUID(),cwd:p.cwd,path:process.env.ARC_STATE_DIR+'/seed-'+randomUUID()+'.jsonl'};fs.writeFileSync(thread.path,'{}');rows[thread.id]={thread,turns:[]};result={thread,model:p.model};}
 const r=rows[p.threadId];
 if(r){
  if(method==='thread/name/set')r.thread.name=p.name;
  if(method==='thread/read')result={thread:{...r.thread,status:{type:'idle'}}};
  if(method==='turn/start'){const turn={id:randomUUID(),status:'completed',items:[{id:randomUUID(),type:'agentMessage',status:'completed',text:'SELF_TEST_OK'}]};r.turns.push(turn);result={turn};}
  if(method==='thread/turns/list')result={data:r.turns,nextCursor:null};
  if(method==='thread/items/list')result={data:[],nextCursor:null};
 }
 fs.writeFileSync(file,JSON.stringify(rows));emit(id,result);
}
`);
 // Historical samples are synthetic records, not dispatched self-test work.
 const historyThread=randomUUID();
 for(const duration of [60000,180000,240000]){const id=randomUUID();await put(`dispatches/${historyThread}/${id}.json`,{requestId:id,threadId:historyThread,turnId:randomUUID(),agent:'codex',purpose:'task',dispatchMode:'new-turn',submittedAt:new Date().toISOString(),model:'fixture-notify',effort:'high',options:{},terminal:{state:'completed',observedDurationMs:duration}});}
 execFileSync('cargo',['build','--locked','--quiet','-p','contract-fixture'],{cwd:repo,stdio:'inherit'});
 await connect();
 const g=await call('guide');await save('claude-guide',g);
 check('Claude loop omits foreign source text and limits',!JSON.stringify(g).match(/ChatGPT|Work|540000|1800000|600 seconds|180 seconds/));
 for(const [op,choices] of [['tree','raw|review'],['read','raw|review'],['search','raw|review|full']])check(op+' view schema signature',g.ops.find(o=>o.op===op).signature.includes('view?:'+choices));
 check('nonempty query schema signature',g.ops.find(o=>o.op==='search').signature.includes('query(≥1 char)'));
 for(const op of ['codex_wait','agent_wait','inbox_wait'])check(op+' guide cap',(await call('guide',{op})).inputSchema.properties.timeoutMs.maximum===170000);
 const all=await call('dispatch_policy',{all:true}),compact=await call('dispatch_policy');
 check('default agents installed and enabled',compact.agents.every(a=>a.availability.startsWith('available')));
 check('all includes disabled or absent agents',all.agents.length>compact.agents.length);
 report.policyCharacters={all:JSON.stringify(all).length,default:JSON.stringify(compact).length};
 let r=await dispatch();await save('unverified-receipt',r);
 let t=await status();await save('new-target-status',t);
 check('new target unverified',t.reachability==='unverified');
 check('unverified dispatch gives wait and median revisit',r.next.op==='codex_wait'&&r.next.args.threadId===r.threadId&&r.next.args.turnId===r.turnId&&r.next.args.until==='terminal'&&r.next.revisitAfterMinutes===3&&!r.next.hint.includes('You may end'));
 await call('notify_control',{action:'verify',target:'session_selftest'});
 const ack=await received();check('send alone remains unverified',(await status()).reachability==='unverified');
 await call('notification_ack',{...ack,code:'wrong'},true);
 await call('notification_ack',ack);check('received code verifies target',(await status()).reachability==='verified');
 await call('notification_ack',ack,true);
 await client.close();await connect();check('verification survives restart',(await status()).reachability==='verified');
 r=await dispatch();await save('verified-receipt',r);check('verified dispatch may wait for notification',r.next.hint.includes('You may end'));check('receipt read retains verified branch',(await call('receipt',{requestId:r.requestId})).next.hint.includes('You may end'));
 r=await dispatch('codex_send',{threadId:r.threadId,notify:null});check('unbound dispatch gives wait',r.next.op==='codex_wait');check('receipt read retains unbound follow-up',(await call('receipt',{requestId:r.requestId})).next.op==='codex_wait');
 r=await dispatch('codex_create',{model:'no-history',notify:null});check('no matching sample omits minutes',r.next.op==='codex_wait'&&r.next.revisitAfterMinutes===undefined);
 // Clock boundary fixture: set only the isolated persisted challenge deadline.
 await call('notify_control',{action:'verify',target:'session_selftest'});
 const state=await read('notifications/subscriptions/state.json');state.targets.find(t=>t.target==='session_selftest').reachability.expiresAt=1;await put('notifications/subscriptions/state.json',state);
 t=await status();check('expired handshake failed',t.reachability==='failed'&&t.reason==='handshake-timeout');
 check('timeout persisted',(await read('notifications/subscriptions/state.json')).targets.find(t=>t.target==='session_selftest').reachability.state==='failed');
 await writeFile(path.join(dir,'fail-send'),'1');await call('notify_control',{action:'verify',target:'session_selftest'});t=await status();check('known send failure failed',t.reachability==='failed'&&t.reason==='handshake-delivery-failed');
 r=await dispatch();check('failed target dispatch follows up',r.next.op==='codex_wait'&&r.next.revisitAfterMinutes===3);
 await rm(path.join(dir,'fail-send'));await call('notify_control',{action:'verify',target:'session_selftest'});await call('notification_ack',await received());check('fresh handshake recovers failed target',(await status()).reachability==='verified');
 await writeFile(path.join(dir,'fail-send'),'1');
 const failedDelivery=await dispatch();await call('codex_wait',{threadId:failedDelivery.threadId,turnId:failedDelivery.turnId,timeoutMs:1000});
 const failureDeadline=Date.now()+10000;do{t=await status();if(t.reason==='delivery-failed')break;await new Promise(r=>setTimeout(r,100));}while(Date.now()<failureDeadline);
 check('ordinary delivery failure invalidates verified target',t.reachability==='failed'&&t.reason==='delivery-failed');
 await rm(path.join(dir,'fail-send'));await call('notify_control',{action:'verify',target:'session_selftest'});await call('notification_ack',await received());
 // All four dispatch ops receive the same reachability-based continuation.
 for(const verified of [true,false]){
  if(!verified)await call('notify_control',{action:'verify',target:'session_selftest'});
  let a=await call('agent_create',{agent:'notification-fixture',cwd:dir,prompt:'Reply SELF_TEST_OK.',purpose:'self-test',notify:{channel:'claude-session',target:'session_selftest'},requestId:randomUUID()});
  for(const op of ['agent_create','agent_send']){
   if(op==='agent_send')a=await call(op,{agent:'notification-fixture',taskId:a.taskId,prompt:'Reply SELF_TEST_OK again.',purpose:'self-test',notify:{channel:'claude-session',target:'session_selftest'},requestId:randomUUID()});
   while(['reserved','executing'].includes(a.state)){await new Promise(r=>setTimeout(r,50));a=await call('receipt',{requestId:a.requestId});}
   check(op+' '+(verified?'verified':'unverified')+' follow-up',verified?a.next?.hint.includes('You may end'):a.next?.op==='agent_wait'&&a.next.args.taskId===a.taskId&&a.next.args.agent==='notification-fixture');
   await call('agent_wait',{agent:'notification-fixture',taskId:a.taskId,turnId:a.turnId,until:'terminal',timeoutMs:1000});
  }
 }
 report.guideContentCharacters=g.content.length;
 await save('report',report);console.log(JSON.stringify(report,null,2));
}catch(e){report.defects.push(e.message);await save('report',report);throw e;}
finally{await client?.close();await rm(dir,{recursive:true,force:true});execFileSync(process.execPath,['tooling/prune-build-cache.mjs'],{cwd:repo,stdio:'inherit'});}
