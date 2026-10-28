import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionDomain, validDomain } from '../ui/formRules.ts';

test('connection domains accept pasted product URLs without retaining paths or query strings', () => {
  // Regression: pasting a full MCP URL into the connection domain field failed validation.
  for (const value of ['https://mcp.example.com/mcp?client=demo#setup', 'http://mcp.example.com:8080/mcp', 'mcp.example.com/mcp', '  mcp.example.com  ']) {
    assert.equal(connectionDomain(value), 'mcp.example.com');
    assert.ok(validDomain(connectionDomain(value)));
  }
  for (const value of ['ftp://mcp.example.com', 'https://user:secret@mcp.example.com', 'not a domain']) {
    assert.ok(!validDomain(connectionDomain(value)));
  }
});
