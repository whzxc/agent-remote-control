import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

test('published MCP tool schemas retain the frozen envelopes and compile every operation schema', async () => {
  // Contract: guide/query/act names, input envelopes and read/write annotations are frozen; advertised operation schemas must be usable by clients.
  const catalog = JSON.parse(await readFile(new URL('../native/src/catalog.json', import.meta.url), 'utf8'));
  assert.deepEqual(catalog.tools.map((tool: any) => tool.name).sort(), ['act', 'guide', 'query']);
  const op = { type: 'string' }, args = { type: 'object', additionalProperties: true };
  const properties = {
    guide: { topic: { type: 'string', enum: ['loop', 'notify', 'review', 'approvals'], default: 'loop' }, op },
    query: { op, args },
    act: { op, args, requestId: { type: 'string' } },
  };
  const validator = new AjvJsonSchemaValidator();
  for (const tool of catalog.tools) {
    assert.equal(tool.outputSchema, undefined);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.inputSchema.properties, properties[tool.name as keyof typeof properties]);
    assert.deepEqual(tool.inputSchema.required, tool.name === 'guide' ? [] : ['op', 'args']);
    assert.equal(tool.annotations.readOnlyHint, tool.name !== 'act');
    assert.equal(validator.getValidator(tool.inputSchema)(tool.name === 'guide' ? {} : { op: 'guide', args: {} }).valid, true);
  }
  for (const operation of catalog.ops) assert.equal(typeof validator.getValidator(operation.inputSchema), 'function', operation.name);
});
