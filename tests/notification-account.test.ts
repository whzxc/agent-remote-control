import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {nativeControl} from './helpers/native-control.ts';

test('Malformed cloud targets fail before binding or delivery',async()=>{
  // Regression: malformed tagged IDs reached Claude and required delivery logs to diagnose.
  const fixture=await nativeControl('');
  try {
    for(const target of [
      'session_test', 'session_01111111111111111111111', 'session_0111111111111111111111111',
      'session_01aaaaaaaaaaaaaaaaaaaaa_', 'cse_invalid', '00000000-0000-4000-8000-000000000001',
      'https://claude.ai/code/session_invalid', 'https://claude.ai/code/011111111111111111111111',
      'https://other.invalid/code/session_011111111111111111111111',
    ]) {
      for(const action of ['bind','verify']) {
        const result=await fixture.call('notify_control',{action,target});
        assert.equal(result.error.code,'INVALID_CLAUDE_SESSION',JSON.stringify(result));
        assert.equal(result.error.argument,'target');
        assert.equal(result.bound,undefined);assert.equal(result.verificationAttempts,undefined);
        assert.deepEqual(result.next.args,{topic:'notify'});
      }
    }
    assert.deepEqual((await fixture.call('notify_status')).targets,[]);
  }finally{await fixture.close();}
});

test('Cloud bind preserves a missing-session diagnosis and only safe routed profile identity', {skip:process.platform==='win32'},async()=>{
  // Regression: CLI Session not found hid the host account and returned only generic transport recovery.
  const directory=await mkdtemp(path.join(tmpdir(),'arc-notify-cli-'));
  const binary=path.join(directory,'claude');
  await writeFile(binary,`#!${process.execPath}
const args=process.argv.slice(2);
if(args[0]==='auth' && args[1]==='status') {
  console.log(JSON.stringify({loggedIn:true,email:'fixture@example.com',authMethod:'claude.ai',accessToken:'fixture-secret',credentials:{refreshToken:'fixture-secret'}}));
} else if(args[0]==='auth' && args[1]==='login') {process.exitCode=0;}
else if(args[0]==='-p') {console.error('Session not found');process.exitCode=1;}
else {throw new Error('Unexpected fixture CLI operation');}
`);
  await chmod(binary,0o755);
  const fixture=await nativeControl('',{PATH:directory+path.delimiter+process.env.PATH,HOME:directory});
  try {
    const target='session_010000000000000000000011';
    const login=await fixture.api('accounts/add',{kind:'claude'});
    const deadline=Date.now()+5000;
    let accounts=await fixture.api('accounts');
    while(accounts.login?.state!=='completed' && Date.now()<deadline) {
      await new Promise(resolve=>setTimeout(resolve,20));
      accounts=await fixture.api('accounts');
    }
    assert.equal(accounts.login.state,'completed',JSON.stringify(accounts.login));
    const unowned=await fixture.call('notify_control',{action:'route',target,accountId:login.accountId});
    assert.equal(unowned.error.code,'NOTIFICATION_TARGET_NOT_BOUND_TO_SOURCE');
    assert.equal(unowned.profiles,undefined);
    const result=await fixture.call('notify_control',{action:'bind',target,accountId:login.accountId});
    assert.equal(result.ok,false);assert.equal(result.bound,true);
    assert.equal(result.error.code,'CLAUDE_SESSION_NOT_FOUND',JSON.stringify(result));
    assert.equal(result.verification.reason,'claude-session-not-found');
    assert.equal(result.error.localAccount.email,'fixture@example.com');
    assert.deepEqual(result.next.args,{action:'route',target});
    const route=await fixture.call('notify_control',result.next.args);
    assert.equal(route.accountId,login.accountId);
    assert.equal(route.profiles[0].identity.email,'fixture@example.com');
    const set=await fixture.call('notify_control',{action:'route',target,accountId:login.accountId});
    assert.equal(set.accountId,login.accountId);
    const status=await fixture.call('notify_status',{target});
    assert.equal(status.targets[0].lastVerificationError.code,'CLAUDE_SESSION_NOT_FOUND');
    assert.equal(status.targets[0].lastVerificationError.localAccount.loggedIn,true);
    assert.ok(!JSON.stringify([result,status]).includes('fixture-secret'));
  }finally{await fixture.close();await rm(directory,{recursive:true,force:true});}
});

test('Unrouted targets select only a uniquely visible profile and persist that choice', {skip:process.platform==='win32'},async()=>{
  // Regression: unrouted cloud targets silently used the first imported account instead of the session owner.
  const {createServer}=await import('node:http');
  const {readFile}=await import('node:fs/promises');
  const directory=await mkdtemp(path.join(tmpdir(),'arc-account-selection-'));
  let visibility=new Map<string,number>();
  const server=createServer((request,response)=>{
    const accountId=request.headers.authorization?.replace('Bearer fixture-secret-','')??'';
    const status=visibility.get(accountId)??404;
    response.writeHead(status,{'content-type':'application/json'});
    response.end(JSON.stringify(status===200?{session:{id:request.url?.split('/').at(-1)}}:{error:'fixture-secret-upstream'}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as import('node:net').AddressInfo).port;
  const binary=path.join(directory,'claude');
  const deliveries=path.join(directory,'deliveries.jsonl');
  await writeFile(binary,`#!${process.execPath}
const {writeFileSync,appendFileSync}=require('node:fs');
const path=require('node:path');
const args=process.argv.slice(2),config=process.env.CLAUDE_CONFIG_DIR,id=path.basename(path.dirname(config));
if(args[0]==='auth' && args[1]==='login') {
  writeFileSync(path.join(config,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'fixture-secret-'+id}}));
} else if(args[0]==='auth' && args[1]==='status') {
  console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:id+'@example.com',orgName:'Fixture',orgId:'550e8400-e29b-41d4-a716-446655440000',subscriptionType:'pro',accessToken:'fixture-secret'}));
} else if(args[0]==='-p') {
  appendFileSync(${JSON.stringify(deliveries)},JSON.stringify({accountId:id,target:args[3],message:args[1]})+'\\n');
  console.log(JSON.stringify({ok:true,session_id:args[3]}));
} else {throw new Error('Unexpected fixture CLI operation');}
`);
  await chmod(binary,0o755);
  let fixture: Awaited<ReturnType<typeof nativeControl>> | undefined;
  try {
    fixture=await nativeControl(`import {createInterface} from 'node:readline';
for await(const line of createInterface({input:process.stdin})) {const {id}=JSON.parse(line);if(id!==undefined)console.log(JSON.stringify({id,result:{data:[]}}));}`,{PATH:directory+path.delimiter+process.env.PATH,HOME:directory,ARC_FIXTURE_CLAUDE_API:`http://127.0.0.1:${port}`});
    const owner=await fixture.api('ingress',{id:'route-owner',name:'Route owner',controlSource:'claude',transport:'https',auth:'bearer',bearerToken:'fixture-owner'.padEnd(40,'x'),toolPolicy:'all',config:{httpsProvider:'custom',httpsUrl:'https://fixture.example.com/mcp'}});
    assert.equal(owner.id,'route-owner');
    await fixture.api(`ingress/${owner.id}/start`,{});
    const call=(op:string,args:Record<string,unknown>={})=>fixture!.sourceCall(owner.id,op,args,['whoami','notify_status','accounts'].includes(op)?'query':'act');
    const empty=await call('notify_control',{action:'bind',target:'session_010000000000000000000018',verify:false});
    assert.equal(empty.error.code,'ACCOUNT_SELECTION_REQUIRED');
    assert.deepEqual(empty.error.candidates,[]);
    const profiles:string[]=[];
    for(let i=0;i<2;i++) {
      const login=await fixture.api('accounts/add',{kind:'claude'});
      const deadline=Date.now()+5000;
      let status=await fixture.api('accounts');
      while(status.login?.state!=='completed' && Date.now()<deadline) {
        await new Promise(resolve=>setTimeout(resolve,20));status=await fixture.api('accounts');
      }
      assert.equal(status.login.state,'completed',JSON.stringify(status.login));profiles.push(login.accountId);
    }
    await call('account_update',{id:profiles[0],defaultFor:'claude'});
    await call('account_update',{id:profiles[1],defaultFor:'claude',default:false});
    assert.ok((await call('accounts',{id:profiles[0]})).agentProfiles.some((p:any)=>p.default));
    for(const [index,codes] of [[404,404],[200,200],[200,503]].entries()) {
      visibility=new Map(profiles.map((id,i)=>[id,codes[i]]));
      const target=`session_01000000000000000000001${index}`;
      const result=await call('notify_control',{action:'bind',target});
      assert.equal(result.error.code,'ACCOUNT_SELECTION_REQUIRED',JSON.stringify(result));
      assert.equal(result.bound,true);
      assert.deepEqual(result.next.args,{action:'route',target});
      assert.equal(result.error.candidates.length,2);
      assert.ok(result.error.candidates.every((p:any)=>p.identity.orgName==='Fixture' && p.identity.subscriptionType==='pro'));
      assert.ok(!JSON.stringify(result).includes('fixture-secret'));
      const status=await call('notify_status',{target});
      assert.equal(status.targets[0].verificationAttempts,0);
    }
    visibility=new Map([[profiles[0],404],[profiles[1],200]]);
    const target='session_010000000000000000000019';
    const unidentified=await call('whoami');
    const result=await call('notify_control',{action:'bind',target});
    assert.equal(result.accountRoute.accountId,profiles[1],JSON.stringify(result));
    assert.equal((await call('whoami')).id,unidentified.id);
    assert.equal(result.verification.deliveryStatus,'delivered');
    const delivered=(await readFile(deliveries,'utf8')).trim().split('\n').map(row=>JSON.parse(row)).find(row=>row.target===target && row.message.includes('notification_ack'));
    assert.ok(delivered);
    const challenge=JSON.parse(delivered.message.slice(delivered.message.indexOf('{'),delivered.message.lastIndexOf('}')+1));
    const beforeAck=await fixture.sourceCall(owner.id,'src_conversations',{},'query');
    assert.ok(beforeAck.accounts.every((a:any)=>a.conversations.length===0));
    const acknowledged=await call('notification_ack',challenge.args);
    assert.equal(acknowledged.reachability,'verified');
    assert.equal(acknowledged.identityResolution.state,'resolved');
    assert.equal(acknowledged.identityResolution.accountId,profiles[1]);
    assert.equal(acknowledged.identityResolution.evidence.kind,'claude-session-handshake');
    assert.equal(acknowledged.identityResolution.evidence.orgId,'550e8400-e29b-41d4-a716-446655440000');
    assert.equal(acknowledged.identityResolution.evidence.target,target);
    assert.ok(acknowledged.identityResolution.evidence.confirmedAt);
    const linked=await call('whoami');
    assert.equal(linked.id,profiles[1]);
    assert.equal(linked.sourceId,unidentified.sourceId);
    const sourceConversations=await fixture.sourceCall(owner.id,'src_conversations',{accountId:linked.id},'query');
    const cowork=sourceConversations.accounts[0].conversations.find((r:any)=>r.id===target.replace('session_','cse_'));
    assert.equal(cowork.accountId,linked.id);
    assert.equal(cowork.basis,'notify-target');
    assert.deepEqual(cowork.taskRefs,[]);
    assert.equal(linked.orgName,'Fixture');
    assert.deepEqual(linked.identityResolution,acknowledged.identityResolution);
    const replay=await call('notification_ack',challenge.args);
    assert.equal(replay.error.code,'HANDSHAKE_INVALID_OR_EXPIRED');
    await fixture.restart();
    assert.equal((await call('whoami')).id,profiles[1]);
    assert.deepEqual((await call('whoami')).identityResolution,linked.identityResolution);
    await call('notify_control',{action:'bind',target,accountId:profiles[1],verify:false});
    assert.equal((await call('notify_status',{target})).targets[0].reachability,'verified');
    const saved=await call('notify_control',{action:'route',target});
    assert.equal(saved.accountId,profiles[1]);
    const ingress=await fixture.api('ingress',{id:'route-peer',name:'Route peer',controlSource:'custom',transport:'https',auth:'bearer',bearerToken:'fixture-peer'.padEnd(40,'x'),toolPolicy:'all',config:{httpsProvider:'custom',httpsUrl:'https://fixture.example.com/mcp'}});
    assert.equal(ingress.id,'route-peer',JSON.stringify(ingress));
    await fixture.api(`ingress/${ingress.id}/start`,{});
    const denied=await fixture.sourceCall(ingress.id,'notify_control',{action:'route',target,accountId:profiles[0]});
    assert.equal(denied.error.code,'NOTIFICATION_TARGET_NOT_BOUND_TO_SOURCE',JSON.stringify(denied));
    assert.equal(denied.profiles,undefined);
    const peer=await fixture.sourceCall(ingress.id,'notify_control',{action:'bind',target,accountId:profiles[0],verify:false});
    assert.equal(peer.accountRoute.accountId,profiles[0],JSON.stringify(peer));
    assert.equal((await call('notify_control',{action:'route',target})).accountId,profiles[1]);
    // A later host assignment cannot change the source's persisted selection.
    await fixture.api('accounts/routes',{target,accountId:profiles[0]},'PUT');
    assert.equal((await call('notify_control',{action:'route',target})).accountId,profiles[1]);
    await call('notify_control',{action:'route',target,accountId:profiles[0]});
    const changed=await call('notify_status',{target});
    assert.equal(changed.targets[0].reachability,'unverified');
    assert.equal(changed.targets[0].reason,'handshake-required');
    await call('notify_control',{action:'verify',target});
    const last=JSON.parse((await readFile(deliveries,'utf8')).trim().split('\n').at(-1)!);
    const conflictingChallenge=JSON.parse(last.message.slice(last.message.indexOf('{'),last.message.lastIndexOf('}')+1));
    const conflict=await call('notification_ack',conflictingChallenge.args);
    assert.equal(conflict.reachability,'verified');
    assert.equal(conflict.identityResolution.state,'conflict');
    assert.equal(conflict.identityResolution.code,'ACCOUNT_IDENTITY_CONFLICT');
    assert.equal(conflict.identityResolution.accountId,profiles[1]);
    assert.equal(conflict.identityResolution.evidence.accountId,profiles[0]);
    assert.equal((await call('whoami')).id,profiles[1]);
    assert.equal((await call('accounts',{id:profiles[1]})).health.state,'attention');
    await fixture.restart();
    assert.equal((await call('whoami')).identityResolution.state,'conflict');
    await call('notify_control',{action:'route',target,accountId:profiles[1]});
    await call('notify_control',{action:'verify',target});
    const retry=JSON.parse((await readFile(deliveries,'utf8')).trim().split('\n').at(-1)!);
    const retryChallenge=JSON.parse(retry.message.slice(retry.message.indexOf('{'),retry.message.lastIndexOf('}')+1));
    await call('notify_control',{action:'route',target,accountId:profiles[0]});
    assert.equal((await call('notification_ack',retryChallenge.args)).error.code,'HANDSHAKE_INVALID_OR_EXPIRED');
    assert.equal((await call('whoami')).identityResolution.state,'conflict');
    await call('notify_control',{action:'verify',target,accountId:profiles[1]});
    const corrected=JSON.parse((await readFile(deliveries,'utf8')).trim().split('\n').at(-1)!);
    const correctedChallenge=JSON.parse(corrected.message.slice(corrected.message.indexOf('{'),corrected.message.lastIndexOf('}')+1));
    assert.equal((await call('notification_ack',correctedChallenge.args)).identityResolution.state,'resolved');
    assert.equal((await call('whoami')).identityResolution.state,'resolved');
    const localTarget='session_010000000000000000000020';
    await fixture.call('notify_control',{action:'bind',target:localTarget,accountId:profiles[1]});
    const localDelivery=JSON.parse((await readFile(deliveries,'utf8')).trim().split('\n').at(-1)!);
    const localChallenge=JSON.parse(localDelivery.message.slice(localDelivery.message.indexOf('{'),localDelivery.message.lastIndexOf('}')+1));
    const localAck=await fixture.call('notification_ack',localChallenge.args);
    assert.equal(localAck.reachability,'verified');
    assert.equal(localAck.identityResolution.state,'not-applicable');
    const local=await fixture.call('whoami');
    assert.equal(local.id,null);
    assert.equal(local.authority,'local');
    assert.ok(!(await call('accounts')).accounts.some((account:any)=>account.sources.includes(local.sourceId)));
  } finally {
    await fixture?.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(directory,{recursive:true,force:true});
  }
});
