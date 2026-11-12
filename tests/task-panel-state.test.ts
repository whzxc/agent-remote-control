import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeControl} from './helpers/native-control.ts';
test('Small task-panel state stays inline when the transcript requires pagination',async()=>{
  // Regression: reading follow and width required paging through a large task transcript.
  const fixture=await nativeControl('',{ARC_FIXTURE_SNAPSHOT:'1'});
  const args={agent:'codex',id:'00000000-0000-4000-8000-000000000004'};
  try {
    for(const [op,extra] of [['task_panel',{}],['task_panel_control',{action:'width'}]] as const) {
      const panel=await fixture.call(op,{...args,...extra});
      assert.equal(Object.hasOwn(panel,'purpose'),false);assert.equal(panel.following,true);assert.equal(panel.expanded,true);assert.equal(panel.outputId,undefined);assert.equal(panel.timeline.entryCount,1);
    }
    const full=await fixture.call('task_panel',{...args,view:'full'});assert.ok(full.outputId);
    const page=await fixture.call('control_output',{outputId:full.outputId,offset:0,length:1000});assert.ok(page.text.includes('following'));
  }finally{await fixture.close();}
});
