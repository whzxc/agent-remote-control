import {toolResult} from '../mcp-result.mjs';
import { requireMainCheckout } from '../coding-lane.mjs';
requireMainCheckout();
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {createServer} from 'node:http';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, mkdtemp, readFile, writeFile, open, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import { build as buildClient } from 'vite';

// Real signed updater bytes, a private HTTP endpoint, and a disposable app/state.
// No request in this runner targets the user's installed ARC state directory.
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Update acceptance requires an Apple Silicon Mac');
const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
process.chdir(root);
const out = path.join(root, 'output/acceptance', `updates-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(out, {recursive:true});
const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'arc-update-acceptance-')));
const stateDir = path.join(temporary, 'state');
const target = path.join(temporary, 'ARC Update Acceptance.app');
const candidate = path.join(temporary, 'Candidate.app');
const environment = {...process.env, ARC_STATE_DIR:stateDir};
const agent = 'update-fixture';
const releaseTask = path.join(temporary, 'release-task');
let taskId;
await mkdir(path.join(stateDir, 'agents'), {recursive:true});
const agentScript = path.join(temporary, 'agent.mjs');
await writeFile(agentScript, `
import {createInterface} from 'node:readline';
import {existsSync} from 'node:fs';
const emit = value => process.stdout.write(JSON.stringify(value)+'\\n');
const update = value => emit({method:'session/update',params:{sessionId:'update-session',update:value}});
let timer;
const input=createInterface({input:process.stdin});
input.on('close',()=>{clearInterval(timer);process.exit(0);});
input.on('line',line=>{
 const request=JSON.parse(line);
 if(request.method==='initialize') emit({id:request.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
 if(request.method==='session/new'||request.method==='session/load') emit({id:request.id,result:{sessionId:'update-session'}});
 if(request.method==='session/prompt') {
  update({sessionUpdate:'tool_call',toolCallId:'held-tool',title:'Fixture tool',kind:'other',status:'in_progress'});
  timer=setInterval(()=>{
   if(!existsSync(${JSON.stringify(releaseTask)})) return;
   clearInterval(timer);
   update({sessionUpdate:'tool_call_update',toolCallId:'held-tool',status:'completed'});
   update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'UPDATE_TASK_COMPLETED'}});
   emit({id:request.id,result:{stopReason:'end_turn'}});
  },100);
 }
 if(request.method==='session/cancel') {clearInterval(timer);process.exit(0);}
});
`);
await writeFile(path.join(stateDir,'agents/manifests.json'),JSON.stringify([{id:agent,command:process.execPath,args:[agentScript],versionArgs:[],protocol:'acp-v1'}]));
await writeFile(path.join(stateDir,'task-settings.json'),JSON.stringify({autoOpenCodex:false}));
const manifest = { version: '0.0.1', notes: 'Direct update acceptance', platforms: {} };
const name = 'acceptance.app.tar.gz';
let payload;
let expected;
let checkError = false, assetError = false, child;
let observed, instance, nextId = 0, waiting;
const commands = [], results = new Map();
const clientDirectory = path.join(out, 'client');
const transfers = [], report = {cases:[], temporary, stateDir, version:manifest.version};
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const server = createServer(async (req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  if (req.url === '/next') {
    if (commands.length) res.end(JSON.stringify(commands.shift()));
    else { waiting = res; res.on('close',()=>{ if(waiting===res) waiting=undefined; }); }
    return;
  }
  if (req.method === 'POST') {
    let body='';for await (const chunk of req) body+=chunk;
    const value = JSON.parse(body);
    if (req.url === '/hello') { instance=value.instance; observed=undefined; }
    if (req.url === '/state' && value.instance===instance) observed=value.view;
    if (req.url === '/result') results.set(value.id,value);
    if (req.url === '/error') (report.runtimeErrors ??= []).push(value.error);
    res.end('{}');return;
  }
  if(req.url === '/latest.json') {
    res.setHeader('Content-Type','application/json');
    res.writeHead(checkError ? 503 : 200);
    res.end(checkError ? '{"error":"fixture unavailable"}' : JSON.stringify(manifest));
  } else if(req.url === '/' + name) {
    transfers.push({at:new Date().toISOString(),error:assetError});
    if(assetError) {res.writeHead(503);res.end('fixture unavailable');return;}
    res.writeHead(200, {'Content-Type':'application/octet-stream','Content-Length':payload.length});
    let offset=0;
    const timer=setInterval(()=>{const end=Math.min(offset+65536,payload.length);res.write(payload.subarray(offset,end));offset=end;if(offset===payload.length){clearInterval(timer);res.end();}},25);
    res.on('close',()=>clearInterval(timer));
  } else {res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
await buildClient({ configFile: false, logLevel: 'error', define: {'process.env.NODE_ENV':JSON.stringify('production'),'__UPDATE_ACCEPTANCE_ENDPOINT__':JSON.stringify(endpoint)}, build: { outDir: clientDirectory,
  lib: { entry: path.join(root, 'tooling/acceptance/update-client.ts'), formats: ['es'], fileName: 'client' },
  rolldownOptions: { output: { codeSplitting: false } } } });
await writeFile(path.join(clientDirectory,'index.html'), '<script type="module" src="./client.js"></script>');


const config = path.join(out, 'updater-config.json');
const mainWindow = JSON.parse(await readFile('desktop/tauri.conf.json','utf8')).app.windows[0];
await writeFile(config, JSON.stringify({identifier:'com.whzxc.agent-remote-control',
  build:{frontendDist:clientDirectory},
  app:{windows:[{...mainWindow,url:'index.html',incognito:true,visible:false,focus:false,title:'ARC Update Acceptance'}],
    security:{csp:`default-src 'self'; connect-src ipc: http://ipc.localhost ${endpoint}; style-src 'self' 'unsafe-inline'`}},
  plugins:{updater:{endpoints:[endpoint+'/latest.json'],dangerousInsecureTransportProtocol:true}}}));
function submit(action) {
  const command={id:++nextId,action};
  if(waiting){waiting.end(JSON.stringify(command));waiting=undefined;}else commands.push(command);
  return command.id;
}
async function run(action) {
  const id=submit(action);
  const result=await until(async()=>results.get(id),Boolean);
  if(result.error)throw new Error(result.error);
  return result.view;
}

async function command(args, options={}) {
  return execute(args[0], args.slice(1), {env:environment, timeout:180_000, maxBuffer:16*1024*1024,...options});
}
async function cli(...args) {
  const {stdout}=await command([path.join(candidate,'Contents/Resources/bin/arc'),'cli',...args]);
  const value=JSON.parse(stdout);
  if(!value.ok) throw new Error(JSON.stringify(value.error));
  return value.result;
}
async function control(op,args) {
  const endpoint=JSON.parse(await readFile(path.join(stateDir,'app/native.json'),'utf8'));
  const response=await fetch(`http://127.0.0.1:${endpoint.port}/api/cli/control`,{
    method:'POST',headers:{authorization:`Bearer ${endpoint.token}`,'content-type':'application/json'},body:JSON.stringify({op,args}),
  });
  const value=await response.json();
  if(value.isError)throw new Error(JSON.stringify(toolResult(value)));
  return toolResult(value);
}
async function task() { return control('agent_read',{agent,taskId}); }
async function until(read, accept, timeout=90_000) {
  const deadline=Date.now()+timeout;let last;
  while(Date.now()<deadline) {if(report.runtimeErrors?.length)throw new Error(report.runtimeErrors.join('\n'));try {last=await read();} catch(error){last=String(error);await sleep(150);continue;}if(accept(last))return last;await sleep(150);}
  throw new Error('Acceptance timed out: '+JSON.stringify(last));
}
async function launch() {
  observed=undefined; instance=undefined;
  const log=await open(path.join(out,'desktop.log'),'a');
  child=spawn(path.join(target,'Contents/MacOS/agent-remote-control-desktop'),['--state-dir',stateDir],{env:environment,stdio:['ignore',log.fd,log.fd]});
  child.on('error',error=>{report.launchError=String(error);});
  child.on('exit',()=>void log.close());
  await until(()=>cli('app','status'),status=>status.executable.startsWith(target));
  await until(async()=>observed,Boolean);
}
async function quit() {
  const app=await cli('app','status'), health=await cli('call','health');
  await cli('app','quit');
  const stopped=()=>[app.pid,health.pid].every(pid=>{try{process.kill(pid,0);return false;}catch{return true;}});
  const deadline=Date.now()+30_000;
  while(!stopped() && Date.now()<deadline) await sleep(100);
  if(!stopped()) throw new Error('Disposable Desktop or Core did not exit');
}
async function regression(name, run) {
  const started=Date.now();console.log('START '+name);
  await run();report.cases.push({name,ok:true,seconds:(Date.now()-started)/1000});console.log('PASS '+name);
}
async function build(version) {
  console.log('START isolated debug build '+version);
  const result=await command(['npm','run','desktop:build','--','--debug','--features','tauri-plugin-single-instance/semver','--config',config],{cwd:root,env:{...process.env,ARC_BUILD_VERSION:version},timeout:600_000});
  await writeFile(path.join(out,`build-${version}.log`),result.stdout+'\n'+result.stderr);
  return path.join(root,'target/aarch64-apple-darwin/debug/bundle/macos/Agent Remote Control.app');
}
try {
  const nextApp = await build('0.0.1');
  payload = await readFile(nextApp + '.tar.gz');
  const signature = (await readFile(nextApp + '.tar.gz.sig', 'utf8')).trim();
  manifest.platforms['darwin-aarch64'] = { url: endpoint + '/' + name, signature };
  const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
  expected = { desktop: await hash(path.join(nextApp, 'Contents/MacOS/agent-remote-control-desktop')), core: await hash(path.join(nextApp, 'Contents/Resources/bin/arc')) };
  const app=await build('0.0.0');
  await command(['/usr/bin/ditto',app,target]);await command(['/usr/bin/ditto',app,candidate]);
  await launch();
  await regression('automatic and manual checks share the official download',async()=>{
    // Regression: manual checks duplicated an automatic download and surfaced busy errors.
    await until(async()=>observed,status=>{if(status?.error)throw new Error(status.error);return status?.phase==='downloading';});
    const states=await Promise.all([run('check'),run('check'),run('download')]);
    for(const status of states){assert.equal(status.error,'');assert.equal(status.version,manifest.version);assert.equal(status.ready,true);}
  });
  await regression('failed checks discard the previous offer',async()=>{
    // Regression: a failed check retained an old version and its install button.
    checkError=true;
    const status=await run('check');assert.ok(status.error);assert.equal(status.version,undefined);assert.equal(status.ready,false);
    checkError=false;
  });
  await quit();await launch();
  await regression('recreated renderer has no stale offer or download handle',async()=>{
    // Regression: recreated update UI must not claim readiness for a released WebView resource.
    assert.equal(observed.version,undefined);assert.equal(observed.ready,false);assert.equal(observed.error,'');
  });
  await regression('official download errors remain retryable on the same Update resource',async()=>{
    // Regression: download failure cleared the pending version and prevented a direct retry.
    assetError=true;
    const failed=await run('check');assert.ok(failed.error);assert.equal(failed.version,manifest.version);assert.equal(failed.ready,false);
    assetError=false;
    const ready=await run('download');assert.equal(ready.error,'');assert.equal(ready.ready,true);assert.equal(ready.downloaded,payload.length);
  });
  await regression('downloaded update installs and restarts directly with the feed offline', async()=>{
    // Regression: a ready update was routed through settling, countdown and task recovery instead of installing immediately.
    const created=await control('agent_create',{agent,cwd:temporary,prompt:'Hold the fixture tool across update.',approval:'approved',purpose:'self-test',notify:null,requestId:crypto.randomUUID(),waitMs:1});
    taskId=created.taskId;
    assert.ok(taskId,JSON.stringify(created));
    const active=await until(task,value=>value.status==='running' && value.taskHost?.hostPid);
    assert.equal(active.taskHost.hostProtocol,1);
    await until(()=>control('agent_events',{agent,taskId}),value=>value.events?.some(row=>row.method==='session/update' && row.params?.params?.update?.toolCallId==='held-tool'));
    const before = await cli('app','status'), oldCore = await cli('call','health');
    const endpoint = JSON.parse(await readFile(path.join(stateDir, 'app/native.json'), 'utf8'));
    const lease = await fetch(`http://127.0.0.1:${endpoint.port}/api/runtime/lease`, {
      method: 'POST', headers: {authorization:`Bearer ${endpoint.token}`, 'content-type':'application/json'},
      body: JSON.stringify({id:crypto.randomUUID(),kind:'cli',pid:process.pid}),
    });
    assert.equal(lease.ok,true);
    assetError = true; checkError = true;
    const started = Date.now();
    submit('install');
    const running = await until(()=>cli('app','status'), app=>app.version===manifest.version && app.build===expected.desktop, 30_000);
    const core = await until(()=>cli('call','health'), health=>health.build===expected.core && health.state==='ready', 15_000);
    assert.notEqual(running.pid,before.pid);
    assert.notEqual(core.pid,oldCore.pid);
    assert.equal(running.executable,path.join(target,'Contents/MacOS/agent-remote-control-desktop'));
    const restored=await until(task,value=>value.status==='running' && value.taskHost?.hostPid===active.taskHost.hostPid);
    assert.equal(restored.taskHost.hostStart,active.taskHost.hostStart);
    assert.equal(restored.taskHost.agentPid,active.taskHost.agentPid);
    await writeFile(releaseTask,'finish');
    const finished=await until(task,value=>value.status==='completed');
    assert.equal(finished.finalResponse,'UPDATE_TASK_COMPLETED');
    assert.ok(finished.taskHost.ackedOffset>active.taskHost.ackedOffset);
    report.install = {desktop:running, core, elapsedMs:Date.now()-started};
    report.task={taskId,hostPid:restored.taskHost.hostPid,hostStart:restored.taskHost.hostStart,agentPid:restored.taskHost.agentPid,status:finished.status,finalResponse:finished.finalResponse};
  });
  report.ok=true;
} catch(error) {report.ok=false;report.error=String(error);throw error;}
finally {
  report.transfers=transfers;
  if(taskId){try{await writeFile(releaseTask,'finish');await until(task,value=>['completed','failed','cancelled'].includes(value.status),5000);}catch{}}
  if(child){try{await quit();}catch{}}
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({ok:report.ok,directory:out,cases:report.cases,error:report.error}));
}
