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

test('send and review schemas accept optional delivery attribution', async () => {
  // Contract: clients can validate trigger names and positive counts for supported defect classes.
  const { ops } = JSON.parse(await readFile(new URL('../native/src/catalog.json', import.meta.url), 'utf8'));
  const validator = new AjvJsonSchemaValidator();
  for (const name of ['codex_send', 'agent_send', 'codex_review', 'agent_review']) {
    const validate = validator.getValidator(ops.find((op: any) => op.name === name).inputSchema);
    const task = name.startsWith('codex') ? { threadId: 'thread' } : { agent: 'pi', taskId: '00000000-0000-4000-8000-000000000001' };
    if (name.endsWith('send')) {
      const args = { ...task, prompt: 'Continue' };
      assert.ok(validate(args).valid);
      for (const trigger of ['controller', 'acceptance', 'installed', 'user', 'automation', 'continuation']) {
        assert.ok(validate({ ...args, trigger }).valid);
      }
      assert.equal(validate({ ...args, trigger: 'unknown' }).valid, false);
    } else {
      const args = { ...task, verdict: 'rework' };
      assert.ok(validate(args).valid);
      const classes = { states: 2, environment: 1, scale: 1, visual: 1, requirement: 1, regression: 1, other: 1 };
      assert.ok(validate({ ...args, defectClasses: classes }).valid);
      for (const defectClasses of [{ missing: 1 }, { states: 0 }, { states: 1.5 }]) {
        assert.equal(validate({ ...args, defectClasses }).valid, false);
      }
    }
  }
});
