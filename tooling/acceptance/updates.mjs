import { requireMainCheckout } from '../coding-lane.mjs';
requireMainCheckout();
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {createServer} from 'node:http';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, mkdtemp, readFile, writeFile, rm, open, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

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
const manifest = { version: '0.0.1', notes: 'Direct update acceptance', platforms: {} };
const name = 'acceptance.app.tar.gz';
let payload;
let expected;
let checkError = false, assetError = false, child;
const transfers = [], report = {cases:[], temporary, stateDir, version:manifest.version};
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const server = createServer((req,res)=>{
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

const config = path.join(out, 'updater-config.json');
const mainWindow = JSON.parse(await readFile('desktop/tauri.conf.json','utf8')).app.windows[0];
await writeFile(config, JSON.stringify({identifier:'com.whzxc.agent-remote-control',app:{windows:[{...mainWindow,incognito:true,visible:false,title:'ARC Update Acceptance'}]},plugins:{updater:{endpoints:[endpoint+'/latest.json'],dangerousInsecureTransportProtocol:true}}}));
async function command(args, options={}) {
  return execute(args[0], args.slice(1), {env:environment, timeout:180_000, maxBuffer:16*1024*1024,...options});
}
async function cli(...args) {
  const {stdout}=await command([path.join(candidate,'Contents/Resources/bin/arc'),'cli',...args]);
  const value=JSON.parse(stdout);
  if(!value.ok) throw new Error(JSON.stringify(value.error));
  return value.result;
}
async function call(op, body) {
  if(body===undefined) return cli('call',op);
  const child=spawn(path.join(candidate,'Contents/Resources/bin/arc'),['cli','call',op,'--stdin'],{env:environment,stdio:['pipe','pipe','pipe'],timeout:180_000});
  let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  child.stdin.end(JSON.stringify(body));
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  const value=JSON.parse(stdout);
  if(code || !value.ok) throw new Error(JSON.stringify(value.error ?? stderr));
  return value.result;
}
async function until(read, accept, timeout=90_000) {
  const deadline=Date.now()+timeout;let last;
  while(Date.now()<deadline) {try {last=await read();} catch(error){last=String(error);await sleep(150);continue;}if(accept(last))return last;await sleep(150);}
  throw new Error('Acceptance timed out: '+JSON.stringify(last));
}
async function launch() {
  const log=await open(path.join(out,'desktop.log'),'a');
  child=spawn(path.join(target,'Contents/MacOS/agent-remote-control-desktop'),['--state-dir',stateDir],{env:environment,stdio:['ignore',log.fd,log.fd]});
  child.on('error',error=>{report.launchError=String(error);});
  child.on('exit',()=>void log.close());
  await until(()=>cli('app','status'),status=>status.executable.startsWith(target));
}
async function quit() {
  const app=await cli('app','status'), health=await cli('call','health');
  await cli('app','quit');
  await until(async()=>[app.pid,health.pid].every(pid=>{try{process.kill(pid,0);return false;}catch{return true;}}),Boolean);
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
  await regression('automatic downloading joins manual checks and downloads without busy errors',async()=>{
    // Regression: UI and hourly checks launched overlapping downloads and displayed a transient busy failure.
    await until(()=>call('updates.status'),status=>{assert.equal(status.error??null,null);return status.phase==='downloading';});
    const requests=[call('updates.check'),call('updates.check'),call('updates.download',{body:{version:manifest.version}})];
    const snapshots=[];let finished=false;
    const results=Promise.all(requests).finally(()=>finished=true);
    while(!finished){snapshots.push(await call('updates.status'));await sleep(100);}
    for(const result of await results){assert.equal(result.version,manifest.version);assert.equal(result.ready,true);}
    assert.ok(snapshots.some(status=>status.phase==='downloading'));
    assert.ok(snapshots.every(status=>!status.error));
    for(let index=1;index<snapshots.length;index++)assert.ok(snapshots[index].revision>=snapshots[index-1].revision);
    report.snapshots=snapshots;
  });
  await regression('failed checks discard the previous version and offer',async()=>{
    // Regression: a check failure kept an old version and its download action visible.
    checkError=true;await assert.rejects(()=>call('updates.check'));
    const status=await call('updates.status');assert.equal(status.phase,'idle');assert.equal(status.update,null);assert.equal(status.errorStage,'check');assert.ok(status.error);
    checkError=false;
  });
  await quit();await launch();
  await regression('restarting discards historical offers and download readiness',async()=>{
    // Regression: restarted Desktop offered an old persisted version after a failed check.
    const status=await call('updates.status');assert.equal(status.update,null);assert.equal(status.error,null);assert.equal(status.downloaded,0);
  });
  await regression('download failures identify their stage and manual retry verifies signed bytes',async()=>{
    // Regression: automatic download errors were reported as check failures and competed with manual retry.
    assetError=true;await assert.rejects(()=>call('updates.check'));
    const failed=await call('updates.status');assert.equal(failed.errorStage,'download');assert.equal(failed.update.version,manifest.version);assert.equal(failed.update.ready,false);
    assetError=false;const result=await call('updates.download',{body:{version:manifest.version}});assert.equal(result.ready,true);
    const ready=await call('updates.status');assert.equal(ready.error,null);assert.equal(ready.downloaded,payload.length);
  });
  await regression('downloaded update installs and restarts directly with the feed offline', async()=>{
    // Regression: a ready update was routed through settling, countdown and task recovery instead of installing immediately.
    const before = await cli('app','status'), oldCore = await cli('call','health');
    const endpoint = JSON.parse(await readFile(path.join(stateDir, 'app/native.json'), 'utf8'));
    const lease = await fetch(`http://127.0.0.1:${endpoint.port}/api/runtime/lease`, {
      method: 'POST', headers: {authorization:`Bearer ${endpoint.token}`, 'content-type':'application/json'},
      body: JSON.stringify({id:crypto.randomUUID(),kind:'cli',pid:process.pid}),
    });
    assert.equal(lease.ok,true);
    assetError = true; checkError = true;
    const started = Date.now();
    const installed = await call('updates.install', {body:{version:manifest.version}});
    assert.equal(installed.restarting, true);
    const running = await until(()=>cli('app','status'), app=>app.version===manifest.version && app.build===expected.desktop, 30_000);
    const core = await until(()=>cli('call','health'), health=>health.build===expected.core && health.state==='ready', 15_000);
    assert.notEqual(running.pid,before.pid);
    assert.notEqual(core.pid,oldCore.pid);
    assert.equal(running.executable,path.join(target,'Contents/MacOS/agent-remote-control-desktop'));
    report.install = {desktop:running, core, elapsedMs:Date.now()-started};
  });
  report.ok=true;
} catch(error) {report.ok=false;report.error=String(error);throw error;}
finally {
  report.transfers=transfers;
  if(child){try{await quit();}catch{}}
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({ok:report.ok,directory:out,cases:report.cases,error:report.error}));
}
