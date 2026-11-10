import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AjvJsonSchemaValidator} from '@modelcontextprotocol/sdk/validation/ajv';
const catalog=JSON.parse(readFileSync(new URL('../../native/src/catalog.json',import.meta.url),'utf8'));
const engine=new AjvJsonSchemaValidator();
const validators=new Map<string,ReturnType<typeof engine.getValidator>>();
export function assertNextCalls(value: any): void {
  // Only the operation outcome is a failure boundary; historical rows are data.
  const root=value && Object.keys(value).length===1 && value.result ? value.result : value;
  let outcome=root;
  for(let depth=0;outcome && depth<8;depth++) {
    if(outcome.ok===false || outcome.error?.code || (['failed','rejected','not-executed','unconfirmed','rolled-back'].includes(outcome.state) || (outcome.state==='cancelled' && outcome.stateScope!=='turn'))) {
      assert.ok(root.next && typeof root.next==='object','Failure response is missing next');
      assert.ok(typeof root.next.op==='string' || (root.next.op===null && typeof root.next.hint==='string' && root.next.hint.trim()),'Failure next must name an operation or explicitly describe human recovery');
      break;
    }
    outcome=outcome.result??outcome.lastResult;
  }
  validateNextCalls(value);
}
function validateNextCalls(value: any): void {
  if(!value || typeof value!=='object')return;
  const next=value.next;
  if(next && typeof next==='object' && next.op) {
    const spec=catalog.ops.find((op:any)=>op.name===next.op);
    assert.ok(spec,`Unknown next op: ${next.op}`);
    if(!validators.has(next.op))validators.set(next.op,engine.getValidator(spec.inputSchema));
    const result=validators.get(next.op)!(next.args??{});
    assert.equal(result.valid,true,`Invalid next ${JSON.stringify(next)}: ${JSON.stringify(result)}`);
  }
  for(const child of Object.values(value))validateNextCalls(child);
}
