import { readFileSync } from 'node:fs';

export function developmentPort(env = process.env) {
  const value = env.ARC_DEV_PORT ?? '5187';
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('ARC_DEV_PORT must be an integer from 1 to 65535.');
  }
  return port;
}

export function developmentConfig(env = process.env) {
  const config = JSON.parse(readFileSync(new URL('../desktop/tauri.dev.conf.json', import.meta.url), 'utf8'));
  const previousOrigin = new URL(config.build.devUrl).origin;
  const origin = new URL(`http://127.0.0.1:${developmentPort(env)}`).origin;
  config.build.devUrl = origin;
  config.app.security.devCsp = config.app.security.devCsp.split(';').map(directive => directive.split(' ').map(source => {
    if (source === previousOrigin) return origin;
    if (source === previousOrigin.replace('http:', 'ws:')) return origin.replace('http:', 'ws:');
    return source;
  }).join(' ')).join(';');
  const instance = env.ARC_DEV_INSTANCE_ID;
  if (!instance) return config;
  if (!/^[a-z0-9]{8,32}$/.test(instance)) throw new Error('ARC_DEV_INSTANCE_ID must contain 8-32 lowercase letters or digits.');
  return { ...config, identifier: `${config.identifier}.acceptance-${instance}`, productName: `ARC Acceptance ${instance}` };
}

// Bundle identity survives supervisor rebuilds; PIDs are observations, not selectors.
export function isolatedStatus(identity, endpoint, desktop) {
  return {bundleId:identity.identifier,appName:identity.productName,desktopPid:desktop.pid,corePid:endpoint.pid,instance:endpoint.instance,
    desktopBuild:desktop.build,port:endpoint.port,screen:{action:'tree',bundleId:identity.identifier}};
}
