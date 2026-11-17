import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {nativeControl} from './helpers/native-control.ts';

for(const surface of ['native','scenario']) test(`The documented ${surface} readiness command waits through POST model snapshots`, {skip:process.platform==='win32'}, async()=>{
  // Recurring bug class: the documented scenario wait timed out on ordinary native pages where scenario is null.
  const fixture=await nativeControl('',{ARC_FIXTURE_SNAPSHOT:surface});
  try {
    const docs=await readFile('docs/reference/cli.md','utf8');
    const pointer=surface==='native'?'/model/layoutSettled':'/model/scenario/ready';
    const command=[...docs.matchAll(/`(echo '[^`]+arc cli wait --op app\.snapshot[^`]+)`/g)].map(match=>match[1]).find(command=>command.includes(pointer))!;
    assert.ok(command,`Missing documented command for ${surface}`);
    const {stdout}=await fixture.shell(command);
    const result=JSON.parse(stdout);assert.equal(result.ok,true);const model=result.result.lastResult.model;
    if(surface==='native') {assert.equal(model.scenario,null);assert.equal(model.layoutSettled,true);} else assert.equal(model.scenario.ready,true);
    await assert.rejects(fixture.shell(command.replace('"modelOnly":true','"modelOnly":true,"width":600')), (error:any)=>JSON.parse(error.stdout).error.message.includes("read-only op"));
  } finally {await fixture.close();}
});


test('Agents can invoke the absolute CLI path returned by guide and status without an arc shim', {skip:process.platform==='win32'},async()=>{
  // Recurring bug class: agents had to guess the application bundle executable because arc was absent from PATH.
  const {isAbsolute}=await import('node:path');
  const {execFileSync}=await import('node:child_process');
  const fixture=await nativeControl('');
  try {
    const guide=await fixture.call('guide',{topic:'notify'});
    const status=JSON.parse((await fixture.shell('arc cli status')).stdout);
    assert.equal(status.ok,true);
    assert.equal(isAbsolute(guide.cliPath),true);
    assert.equal(status.result.cliPath,guide.cliPath);
    const help=JSON.parse(execFileSync(guide.cliPath,['cli','--help'],{env:{...process.env,PATH:'/usr/bin:/bin'},encoding:'utf8'}));
    assert.equal(help.ok,true);
    const cached=await fixture.call('guide',{topic:'notify',knownGuideHash:guide.guideHash});
    assert.equal(cached.unchanged,true);
    assert.equal(cached.cliPath,guide.cliPath);
  }finally{await fixture.close();}
});
