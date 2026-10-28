import test from 'node:test';
import assert from 'node:assert/strict';
import { developmentConfig, developmentPort } from '../tooling/dev-identity.mjs';

test('isolated development identities cannot collide with installed or ordinary development apps', () => {
  // Regression: acceptance shared the ordinary Dev bundle ID and app name, making native targeting ambiguous.
  const ordinary=developmentConfig({});
  const first=developmentConfig({ARC_DEV_INSTANCE_ID:'1234abcd'});
  const second=developmentConfig({ARC_DEV_INSTANCE_ID:'abcd1234'});
  assert.notEqual(first.identifier,ordinary.identifier);assert.notEqual(first.identifier,second.identifier);
  assert.notEqual(first.productName,ordinary.productName);assert.notEqual(first.productName,second.productName);
  assert.throws(()=>developmentConfig({ARC_DEV_INSTANCE_ID:'../bad'}));
});

test('development port keeps the native web URL and CSP on the selected loopback listener', () => {
  // Regression: isolated development could not coexist with an existing DEV WEB listener on port 5187.
  assert.equal(developmentPort({}), 5187);
  for (const port of [1, 80, 5190, 65535]) {
    const env = { ARC_DEV_PORT: String(port), ARC_DEV_INSTANCE_ID: 'instance1234' };
    const config = developmentConfig(env);
    const origin = new URL(config.build.devUrl);
    assert.equal(developmentPort(env), port);
    assert.equal(origin.hostname, '127.0.0.1');
    assert.equal(Number(origin.port || 80), port);
    const sources = config.app.security.devCsp.split(/[;\s]+/).filter((source: string) => source.startsWith('http://127.') || source.startsWith('ws://127.'));
    assert.deepEqual(sources, [origin.origin, origin.origin.replace('http:', 'ws:')]);
  }
});

test('development port rejects invalid or out-of-range listener values', () => {
  // Property: a configured development port is a decimal integer within the TCP port range.
  for (const value of ['', '0', '-1', '65536', '5190.5', '5e3', '0x1446', ' 5190', '5190 ', 'Infinity', 'NaN']) {
    assert.throws(() => developmentPort({ ARC_DEV_PORT: value }));
    assert.throws(() => developmentConfig({ ARC_DEV_PORT: value }));
  }
});
