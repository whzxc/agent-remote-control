import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../tooling/diagnostics/runtime.mjs';

test('resource comparison uses cumulative CPU and preserves unavailable memory', () => {
  // Property: CPU deltas use elapsed time and unavailable memory never becomes zero.
  const sample = (elapsedMs,cpuTotalMs,residentBytes) => ({instance:'instance',pid:1,elapsedMs,process:{cpuTotalMs,residentBytes,physicalFootprintBytes:null},work:[]});
  const report = summarize([sample(0,100,1000),sample(1000,300,1500),sample(2000,500,2000)]);
  assert.equal(report.cpuPercent,20);
  assert.equal(report.residentBytes.slopeBytesPerMinute,30000);
  assert.equal(report.physicalFootprintBytes,null);
  assert.throws(() => summarize([sample(0,100,1),{...sample(1000,200,1),instance:'new'}]));
});
