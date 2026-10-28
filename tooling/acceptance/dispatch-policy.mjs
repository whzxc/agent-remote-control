// Isolated public-contract acceptance. No real dispatch, account or notification target.
import { requireMainCheckout } from '../coding-lane.mjs';
requireMainCheckout();
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const repo=fileURLToPath(new URL('../../',import.meta.url));
const out=path.resolve(process.argv[2]??path.join(repo,'output/acceptance/dispatch-policy'));
const dir=await mkdtemp(path.join(tmpdir(),'arc-policy-self-test-'));
const report={purpose:'self-test',checks:[],defects:[]};
const check=(name,value)=>{assert.ok(value,name);report.checks.push(name);};
const put=async(name,value)=>{const p=path.join(dir,name);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,JSON.stringify(value));};
const save=async(name,value)=>{await mkdir(out,{recursive:true});await writeFile(path.join(out,name+'.json'),JSON.stringify(value,null,2)+'\n');};
const policy={criteria:'Choose based on evidence.',codex:{model:'sample-model',effort:'high',criteria:'MUST review the result.',denyModels:['denied-model']},claude:{model:'native-default',denyModels:['denied-model']},dsh:{criteria:'MUST use observed choices.'}};
let client;
async function call(op,args={}){const r=await client.callTool({name:'query',arguments:{op,args}});assert.ok(!r.isError,JSON.stringify(r));return r.structuredContent.result;}
try{
 await put('ingresses/index.json',['default']);
 await put('ingresses/default/config.json',{id:'default',name:'Self-test',controlSource:'claude',transport:'openai-tunnel',auth:'openai',enabled:true,toolPolicy:'all',config:{}});
 await put('ingresses/default/secrets.json',{});
 await put('dispatch-policy.json',policy);
 await put('agents/tasks/self-test-snapshot.json',{taskId:'self-test-snapshot',agent:'dsh',updatedAt:'2026-01-01T00:00:00Z',configurationObservedAt:'2026-01-01T00:00:00Z',metadata:{models:{currentModelId:'sample-model',availableModels:[]}}});
 await put('subscriptions/settings.json',{enabled:false,agentProviders:{claude:['opencode-go'],dsh:['opencode-go']}});
 await put('subscriptions/readings/opencode-go.json',{observedAt:'2026-01-01T00:00:00Z',rawUsage:{},accountBlocked:false,blockedPoolIds:[],windows:[{id:'weekly',poolId:'shared',label:'weekly',usedPercent:22}]});
 // Synthetic history is seeded directly. No task-purpose work is dispatched.
 const thread=randomUUID();
 async function record(model,minutes,verdict,purpose='task'){
  const id=randomUUID();await put(`dispatches/${thread}/${id}.json`,{requestId:id,threadId:thread,turnId:randomUUID(),agent:'codex',purpose,dispatchMode:'new-turn',submittedAt:new Date().toISOString(),model,effort:'high',options:{},terminal:{state:'completed',observedDurationMs:minutes*60000},...(verdict?{review:{verdict}}:{})});
 }
 for(const m of [1,3,5])await record('sample-model',m,m===1?'pass':m===3?'rework':undefined);
 for(let n=0;n<7;n++)await record('sample-model',3);
 await record('small-a',1,'pass');await record('small-b',9,'rework');await record('small-b',11);
 await record('self-test-only',100,'pass','self-test');
 const script=path.join(dir,'native.mjs');
 await writeFile(script,`import {createInterface} from 'node:readline';for await(const l of createInterface({input:process.stdin})){const {id,method}=JSON.parse(l);if(id===undefined)continue;let result={};if(method==='initialize')result={userAgent:'self-test'};if(method==='model/list')result={data:[{model:'sample-model',supportedReasoningEfforts:['low','medium','high','xhigh','max','ultra'].map(reasoningEffort=>({reasoningEffort})),serviceTiers:[{id:'priority',name:'Fast'}]},{model:'sparse-model',supportedReasoningEfforts:['low','high'].map(reasoningEffort=>({reasoningEffort}))}],nextCursor:null};if(method==='account/rateLimits/read')result={rateLimits:{limitId:'sample',primary:{usedPercent:22,windowDurationMins:10080}}};console.log(JSON.stringify({id,result}));}`);
 execFileSync('cargo',['build','--locked','--quiet','-p','contract-fixture'],{cwd:repo,stdio:'inherit'});
 client=new Client({name:'dispatch-policy-self-test',version:'1'});
 await client.connect(new StdioClientTransport({command:path.join(repo,'target/debug/contract-fixture'),env:{...process.env,HOME:path.join(dir,'home'),USERPROFILE:path.join(dir,'home'),XDG_CONFIG_HOME:path.join(dir,'home'),ARC_STATE_DIR:dir,ARC_FIXTURE_BINARY:process.execPath,ARC_FIXTURE_SCRIPT:script},stderr:'pipe'}));
 const decision=await call('dispatch_policy',{all:true}),full=await call('dispatch_policy',{all:true,view:'full'});
 await save('decision',decision);await save('full',full);
 const c=decision.agents.find(a=>a.agent==='codex'),f=full.agents.find(a=>a.agent==='codex');
 check('defaults and restrictions retained',c.defaults.model==='sample-model'&&c.defaults.effort==='high'&&c.denyModels[0]==='denied-model');
 // Regression: review of 136285a8 requires compact grouped model settings in the decision view.
 check('native model ranges preserve gaps',c.models.includes('sample-model: low-ultra, fast=priority')&&c.models.includes('sparse-model: low/high'));
 check('quota usage summary',c.quota[0].summary==='weekly 22%');
 // Regression: sparse dispatch groups must preserve their original pooled duration median and outcomes.
 check('merged median uses original duration samples',c.history.groups.some(row=>/other.*n3.*med9\.0m.*pass1 rework1 unrev1/.test(row)));
 // Regression: ten-dispatch groups must remain individually comparable in the compact decision view.
 check('history keeps decision outcomes',c.history.groups.some(row=>/sample-model\/high.*n10.*med3\.0m.*pass1 rework1 unrev8/.test(row)));
 check('full retains individual groups',f.history.groups.length===3&&!f.history.groups.some(g=>g.model==='other'));
 check('self-test history excluded',!JSON.stringify(decision).includes('self-test-only'));
 const empty=decision.agents.find(a=>a.agent==='claude');
 check('no-policy keeps defaults and constraints',empty.availability.endsWith('no policy')&&empty.defaults.model==='native-default'&&empty.denyModels[0]==='denied-model');
 const d=decision.agents.find(a=>a.agent==='dsh');
 check('shared quota reference',d.quota.some(q=>q.ref==='claude/opencode-go/shared'));
 check('persisted session timestamp retained',d.source==='persisted-session-snapshot'&&d.observedAt==='2026-01-01T00:00:00Z');
 check('unavailable native models remain explicit',d.models.unavailable==='not-reported-by-session');
 check('stale quota timestamp retained',empty.quota[0].observedAt==='2026-01-01T00:00:00Z'&&empty.quota[0].state==='stale');
 check('fresh timestamps omitted',decision.observedAt===undefined&&c.observedAt===undefined);
 const knownCriteriaHash={global:decision.criteriaHash,codex:c.criteriaHash};
 const cached=await call('dispatch_policy',{all:true,knownCriteriaHash});await save('hash-round-trip',cached);
 const cachedFull=await call('dispatch_policy',{all:true,view:'full',knownCriteriaHash});
 check('decision hash elision',cached.criteria===undefined&&cached.criteriaUnchanged&&cached.agents.find(a=>a.agent==='codex').criteriaUnchanged&&!cached.agents.find(a=>a.agent==='codex').criteria);
 check('full hash elision',cachedFull.criteriaUnchanged&&cachedFull.agents.find(a=>a.agent==='codex').policy.criteriaUnchanged);
 policy.codex.criteria='MUST review changed results.';await put('dispatch-policy.json',policy);
 const changed=(await call('dispatch_policy',{all:true,knownCriteriaHash})).agents.find(a=>a.agent==='codex');
 check('changed criteria returned with new hash',changed.criteria===policy.codex.criteria&&changed.criteriaHash!==c.criteriaHash&&!changed.criteriaUnchanged);
 const installed=await call('dispatch_policy');
 check('all keeps inventory semantics',installed.agents.every(a=>!a.availability.startsWith('disabled')&&!a.availability.startsWith('not installed'))&&decision.agents.length>installed.agents.length);
 function omitted(v){if(v===null||v==='unknown'||v==='')return false;if(Array.isArray(v))return v.length>0&&v.every(omitted);if(typeof v==='object')return Object.keys(v).length>0&&Object.values(v).every(omitted);return true;}
 check('empty and unknown values omitted',omitted(decision)&&omitted(full));
 await save('report',report);console.log(JSON.stringify(report,null,2));
}catch(error){report.defects.push(error.message);await save('report',report);throw error;}
finally{await client?.close();await rm(dir,{recursive:true,force:true});execFileSync(process.execPath,['tooling/prune-build-cache.mjs'],{cwd:repo,stdio:'inherit'});}
