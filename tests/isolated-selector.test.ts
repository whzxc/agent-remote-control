import test from 'node:test';
import assert from 'node:assert/strict';
import {developmentConfig,isolatedStatus} from '../tooling/dev-identity.mjs';
test('An isolated rebuild changes process observations without invalidating the screen selector',()=>{
  // Recurring bug class: isolated-ready advertised a PID selector that became invalid after the development supervisor rebuilt.
  const identity=developmentConfig({ARC_DEV_INSTANCE_ID:'instance1234'});
  const before=isolatedStatus(identity,{pid:10,port:1,instance:'a'},{pid:11,build:'old'});
  const after=isolatedStatus(identity,{pid:20,port:2,instance:'b'},{pid:21,build:'new'});
  assert.deepEqual(before.screen,after.screen);assert.equal(after.screen.bundleId,identity.identifier);assert.equal(after.screen.pid,undefined);
  assert.equal(after.desktopPid,21);assert.equal(after.corePid,20);assert.equal(after.desktopBuild,'new');
});
