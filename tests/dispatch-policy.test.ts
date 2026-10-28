import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {nativeControl} from './helpers/native-control.ts';

test('Dispatch criteria hashes round-trip as strings or per-agent maps in both views',async()=>{
  // Regression: passing the criteriaHash string returned by dispatch_policy failed with INVALID_ARGUMENTS.
  const directory=await mkdtemp(path.join(tmpdir(),'arc-policy-hash-'));
  const state=path.join(directory,'state');
  const policy=path.join(state,'dispatch-policy.json');
  const fixture=await nativeControl(`import {createInterface} from 'node:readline';
for await(const line of createInterface({input:process.stdin})) {
  const {id}=JSON.parse(line);if(id!==undefined)console.log(JSON.stringify({id,result:{data:[]}}));
}`,{ARC_STATE_DIR:state});
  try {
    const written=await fixture.completed('write',{path:policy,content:JSON.stringify({criteria:'Fixture global criteria',codex:{criteria:'Fixture Codex criteria'}})});
    assert.equal(written.state,'completed',JSON.stringify(written));
    for(const view of ['decision','full']) {
      const args={agent:'codex',view,all:true};
      const row=(result:any)=>view==='full'?result.agents[0].policy:result.agents[0];
      const initial=await fixture.call('dispatch_policy',args);
      assert.equal(initial.criteria,'Fixture global criteria',JSON.stringify(initial));
      assert.equal(row(initial).criteria,'Fixture Codex criteria');
      const global=await fixture.call('dispatch_policy',{...args,knownCriteriaHash:initial.criteriaHash});
      assert.equal(global.criteriaUnchanged,true);assert.equal(global.criteria,undefined);
      assert.equal(row(global).criteria,'Fixture Codex criteria');
      const agent=await fixture.call('dispatch_policy',{...args,knownCriteriaHash:row(initial).criteriaHash});
      assert.equal(row(agent).criteriaUnchanged,true);assert.equal(row(agent).criteria,undefined);
      assert.equal(agent.criteria,'Fixture global criteria');
      const mapped=await fixture.call('dispatch_policy',{...args,knownCriteriaHash:{global:initial.criteriaHash,codex:row(initial).criteriaHash}});
      assert.equal(mapped.criteriaUnchanged,true);assert.equal(row(mapped).criteriaUnchanged,true);
      const changed=await fixture.call('dispatch_policy',{...args,knownCriteriaHash:'outdated-hash'});
      assert.equal(changed.criteria,initial.criteria);assert.equal(row(changed).criteria,row(initial).criteria);
    }
  }finally{await fixture.close();await rm(directory,{recursive:true,force:true});}
});


test('Decision policy folds sparse dispatches without losing full history or selection constraints',async()=>{
  // Regression: review of 136285a8 found structured per-model decision rows regressed mandatory dispatch-read token budgets.
  const directory=await mkdtemp(path.join(tmpdir(),'arc-policy-decision-'));
  const state=path.join(directory,'state');
  const criteria='Selection guidance. '.repeat(145);
  const threadId='00000000-0000-4000-8000-000000000001';
  const records=path.join(state,'dispatches',threadId);
  const rows:any[]=[];
  const add=(model:string,n:number,duration:number)=>{
    for(let i=0;i<n;i++) rows.push({threadId,turnId:String(rows.length),model,effort:'high',serviceTier:'default',dispatchMode:'new-turn',submittedAt:new Date().toISOString(),review:{verdict:'pass'},terminal:{state:'completed',observedDurationMs:duration}});
  };
  add('model-main',10,600000);add('model-small',9,60000);add('model-tiny',2,180000);
  for(let i=0;i<12;i++) rows.push({threadId,turnId:String(rows.length),model:'model-small',effort:'high',serviceTier:'default',dispatchOrigin:'external',review:{verdict:'rework',reviewedAt:new Date().toISOString()}});
  for(let i=0;i<12;i++) add(`model-rare-${i}`,1,60000);
  const fixture=await nativeControl(`import {createInterface} from 'node:readline';
for await(const line of createInterface({input:process.stdin})) {
  const {id,method}=JSON.parse(line);
  const result=method==='model/list'?{data:['model-main','model-small','model-tiny','model-four','model-five','model-six','model-seven'].map(model=>({model,displayName:model,contextWindow:131072,supportedReasoningEfforts:['low','medium','high','xhigh','max','ultra'].map(reasoningEffort=>({reasoningEffort})),serviceTiers:[{id:'priority',name:'Fast'}]}))}:{data:[]};
  if(id!==undefined) console.log(JSON.stringify({id,result}));
}`,{ARC_STATE_DIR:state});
  try {
    assert.equal((await fixture.completed('write',{path:path.join(state,'dispatch-policy.json'),content:JSON.stringify({codex:{criteria,model:'model-main',effort:'high',denyModels:['model-denied'],serviceTiers:{'model-main':'default'}}})})).state,'completed');
    for(const [i,row] of rows.entries()) assert.equal((await fixture.completed('write',{path:path.join(records,`${i}.json`),content:JSON.stringify(row)})).state,'completed');
    const args={agent:'codex',all:true};
    const decision=await fixture.call('dispatch_policy',args);
    const agent=decision.agents[0];
    assert.equal(agent.defaults.model,'model-main');assert.equal(agent.defaults.effort,'high');
    assert.deepEqual(agent.denyModels,['model-denied']);
    assert.equal(agent.criteria,criteria);
    const history=agent.history.groups as string[];
    assert.equal(history.length,2);
    assert.ok(history.some(row=>/model-main.*n10.*med10\.0m.*pass10/.test(row)));
    assert.ok(history.some(row=>/other.*n23.*med1\.0m.*pass23.*ext12.*rework12/.test(row)));
    assert.ok(!history.some(row=>row.startsWith('model-small')));
    for(const model of ['model-main','model-small','model-tiny','model-four','model-five','model-six','model-seven']) assert.ok(agent.models.some((row:string)=>row.includes(model)));
    const cached=await fixture.call('dispatch_policy',{...args,knownCriteriaHash:agent.criteriaHash});
    assert.equal(cached.agents[0].criteriaUnchanged,true);
    assert.equal(cached.arcInbox,undefined);assert.equal(decision.arcInbox,undefined);
    assert.equal(agent.authoritative,true);
    assert.deepEqual(cached.agents[0].models,agent.models);
    assert.equal(agent.models.length,1);
    assert.ok(agent.models[0].endsWith(': low-ultra, fast=priority'));
    assert.ok(JSON.stringify(cached).length<=2000,JSON.stringify(cached));
    assert.ok(JSON.stringify(decision).length<=4500,JSON.stringify(decision));
    const full=await fixture.call('dispatch_policy',{...args,view:'full'});
    const detail=full.agents[0];
    assert.equal(detail.policy.criteria,criteria);
    assert.equal(detail.authoritative,true);
    assert.equal(detail.models[0].displayName,detail.models[0].model);
    assert.equal(detail.models[0].contextWindow,131072);
    assert.equal(detail.history.groups.length,15);
    const small=detail.history.groups.find((g:any)=>g.model==='model-small');
    assert.equal(small.dispatches,9);assert.equal(small.external.reviews,12);
    assert.equal(small.medianObservedDurationMs,60000);
  } finally {await fixture.close();await rm(directory,{recursive:true,force:true});}
});


const policyServer=`import {createInterface} from 'node:readline';
import {mkdir,rm} from 'node:fs/promises';
for await(const line of createInterface({input:process.stdin})) {
  const {id,method,params}=JSON.parse(line);if(id===undefined)continue;
  if(method==='fs/remove')await rm(params.path,{recursive:params.recursive??false});
  if(method==='fs/createDirectory')await mkdir(params.path,{recursive:params.recursive??false});
  console.log(JSON.stringify({id,result:{data:[]}}));
}`;
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
const quote=(text:string)=>"'"+text.replaceAll("'","'\\''")+"'";
async function policyText(fixture:Awaited<ReturnType<typeof nativeControl>>,file:string) {
  const result=await fixture.call('read',{path:file});
  assert.ok(result.data?.text!==undefined,JSON.stringify(result));
  return result.data.text.replace(/^\d+: /gm,'') as string;
}
async function formattedPolicy(fixture:Awaited<ReturnType<typeof nativeControl>>,file:string,expected:unknown) {
  const text=await policyText(fixture,file);
  assert.deepEqual(JSON.parse(text),expected);
  assert.equal(text,JSON.stringify(JSON.parse(text),null,2)+'\n');
}

test('Criteria replacement preserves other scopes and settings and exposes the active policy and formatted backup',async()=>{
  // Regression: agents could read criteria but had no write op or active policy path and nearly selected stale acceptance backups.
  const fixture=await nativeControl(policyServer);
  try {
    const initial=await fixture.call('dispatch_policy',{agent:'codex',all:true});
    assert.ok(path.isAbsolute(initial.policyPath));
    assert.equal(initial.criteriaHash,digest(''));
    assert.equal(initial.agents[0].criteriaHash,digest(''));
    const original={criteria:'Original global',codex:{criteria:'Original Codex',model:'fixture-model',effort:'high',serviceTiers:{'fixture-model':'priority'},denyModels:['denied']},pi:{criteria:'Original Pi',options:{mode:'fixture'}}};
    assert.equal((await fixture.completed('write',{path:initial.policyPath,content:JSON.stringify(original)})).state,'completed');
    const criteria="Updated criteria\nKeep exact whitespace.  ";
    const updated=await fixture.call('dispatch_policy_update',{scope:'codex',criteria,expectedCriteriaHash:digest(original.codex.criteria)});
    assert.equal(updated.scope,'codex');assert.equal(updated.criteriaHash,digest(criteria));
    assert.equal(updated.policyPath,initial.policyPath);assert.ok(path.isAbsolute(updated.backupPath));
    await formattedPolicy(fixture,updated.backupPath,original);
    const expected={...original,codex:{...original.codex,criteria}};
    await formattedPolicy(fixture,updated.policyPath,expected);
    for(const view of ['decision','full']) {
      const policy=await fixture.call('dispatch_policy',{agent:'codex',all:true,view});
      const row=view==='full'?policy.agents[0].policy:policy.agents[0];
      assert.equal(policy.policyPath,initial.policyPath);assert.equal(row.criteria,criteria);assert.equal(row.criteriaHash,updated.criteriaHash);
      const cached=await fixture.call('dispatch_policy',{agent:'codex',all:true,view,knownCriteriaHash:updated.criteriaHash});
      assert.equal(cached.policyPath,initial.policyPath);
    }
    const cleared=await fixture.call('dispatch_policy_update',{scope:'codex',criteria:'',expectedCriteriaHash:updated.criteriaHash});
    assert.equal(cleared.criteriaHash,digest(''));
    await formattedPolicy(fixture,updated.backupPath,expected);
    const global=await fixture.call('dispatch_policy_update',{scope:'global',criteria:'Updated global',expectedCriteriaHash:digest(original.criteria)});
    assert.equal((await fixture.call('dispatch_policy',{agent:'codex',all:true})).criteriaHash,global.criteriaHash);
    const pi=await fixture.call('dispatch_policy_update',{scope:'pi',criteria:'Updated Pi',expectedCriteriaHash:digest(original.pi.criteria)});
    assert.equal((await fixture.call('dispatch_policy',{agent:'pi',all:true})).agents[0].criteriaHash,pi.criteriaHash);
    await fixture.restart();
    const persisted=await fixture.call('dispatch_policy',{agent:'codex',all:true});
    assert.equal(persisted.criteria,'Updated global');assert.equal(persisted.agents[0].criteriaHash,cleared.criteriaHash);
    assert.equal(persisted.agents[0].defaults.model,original.codex.model);
    assert.deepEqual(persisted.agents[0].denyModels,original.codex.denyModels);
  }finally{await fixture.close();}
});

test('Policy update uses the act and CLI envelopes with guarded error codes and ingress authorization',async()=>{
  // Contract: act/query routing, CLI schemaVersion/ok/result envelopes and INVALID_ARGUMENTS, DISPATCH_POLICY_CONFLICT, WRONG_TOOL and OP_UNAVAILABLE errors.
  const fixture=await nativeControl(policyServer);
  try {
    const initial=await fixture.call('dispatch_policy',{agent:'codex',all:true});
    const args={scope:'codex',criteria:"CLI's replacement",expectedCriteriaHash:initial.agents[0].criteriaHash};
    const guide=await fixture.call('guide',{op:'dispatch_policy_update'});
    assert.equal(guide.via,'act');
    const cli=JSON.parse((await fixture.shell(`printf '%s' ${quote(JSON.stringify(args))} | arc cli control dispatch_policy_update --stdin`)).stdout);
    assert.equal(cli.schemaVersion,1);assert.equal(cli.ok,true);assert.equal(cli.result.criteriaHash,digest(args.criteria));
    for(const invalid of [{scope:'codex',criteria:'Missing hash'},{...args,scope:'unknown-agent'},{...args,defaults:{model:'unsupported'}}]) {
      const error=await fixture.call('dispatch_policy_update',invalid);
      assert.equal(error.error.code,'INVALID_ARGUMENTS');assert.equal(error.next.op,'guide');
    }
    await assert.rejects(fixture.shell(`printf '%s' ${quote(JSON.stringify(args))} | arc cli control dispatch_policy_update --stdin`),(error:any)=>{
      const response=JSON.parse(error.stdout);
      assert.equal(error.code,1);assert.equal(response.schemaVersion,1);assert.equal(response.ok,false);
      assert.equal(response.error.code,'DISPATCH_POLICY_CONFLICT');assert.equal(response.error.currentCriteriaHash,cli.result.criteriaHash);
      assert.equal(response.next.op,'dispatch_policy');assert.deepEqual(response.next.args,{agent:'codex',all:true});
      return true;
    });
    const ingress=await fixture.api('ingress',{id:'policy-source',name:'Policy source',controlSource:'claude',transport:'https',auth:'bearer',bearerToken:'fixture-policy'.padEnd(40,'x'),toolPolicy:{allowlist:['dispatch_policy','dispatch_policy_update']},config:{httpsProvider:'custom',httpsUrl:'https://policy.example.com/mcp'}});
    assert.equal(ingress.id,'policy-source',JSON.stringify(ingress));
    await fixture.api(`ingress/${ingress.id}/start`,{});
    assert.equal((await fixture.sourceCall(ingress.id,'dispatch_policy_update',args,'query')).error.code,'WRONG_TOOL');
    const mcp=await fixture.sourceCall(ingress.id,'dispatch_policy_update',{...args,expectedCriteriaHash:cli.result.criteriaHash});
    assert.equal(mcp.criteriaHash,cli.result.criteriaHash);
    await fixture.api(`ingress/${ingress.id}`,{toolPolicy:{allowlist:['dispatch_policy']}},'PUT');
    assert.equal((await fixture.sourceCall(ingress.id,'dispatch_policy_update',args)).error.code,'OP_UNAVAILABLE');
    const envelope=await fixture.api('cli/control',{op:'dispatch_policy_update',args:{scope:'global',criteria:'Outer request ID',expectedCriteriaHash:initial.criteriaHash},requestId:randomUUID()});
    assert.equal(envelope.isError,false);assert.equal(envelope.structuredContent.result.criteriaHash,digest('Outer request ID'));
  }finally{await fixture.close();}
});

test('Concurrent policy replacements reject stale hashes without modifying policy or backup and backup failures preserve policy',async()=>{
  // Regression: a read-then-manual-write workflow could overwrite concurrent criteria changes or lose the prior policy.
  const fixture=await nativeControl(policyServer);
  try {
    const initial=await fixture.call('dispatch_policy',{agent:'pi',all:true});
    const replies=await Promise.all(['First criteria','Second criteria'].map(criteria=>fixture.call('dispatch_policy_update',{scope:'pi',criteria,expectedCriteriaHash:initial.agents[0].criteriaHash})));
    const success=replies.find(r=>!r.error),conflict=replies.find(r=>r.error);
    assert.ok(success);assert.equal(conflict.error.code,'DISPATCH_POLICY_CONFLICT');assert.equal(conflict.error.currentCriteriaHash,success.criteriaHash);
    const policyBefore=await policyText(fixture,success.policyPath),backupBefore=await policyText(fixture,success.backupPath);
    const stale=await fixture.call('dispatch_policy_update',{scope:'pi',criteria:'Stale replacement',expectedCriteriaHash:initial.agents[0].criteriaHash});
    assert.equal(stale.error.code,'DISPATCH_POLICY_CONFLICT');
    assert.equal(await policyText(fixture,success.policyPath),policyBefore);assert.equal(await policyText(fixture,success.backupPath),backupBefore);
    assert.equal((await fixture.completed('fs',{action:'remove',params:{path:success.backupPath}})).state,'completed');
    assert.equal((await fixture.completed('fs',{action:'createDirectory',params:{path:success.backupPath}})).state,'completed');
    assert.ok((await fixture.call('dispatch_policy_update',{scope:'pi',criteria:'Backup must succeed',expectedCriteriaHash:success.criteriaHash})).error);
    assert.equal(await policyText(fixture,success.policyPath),policyBefore);
  }finally{await fixture.close();}
});
