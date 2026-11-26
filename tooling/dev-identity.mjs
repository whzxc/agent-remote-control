import path from 'node:path';

export const desktopName = 'Agent Remote Control';
export const desktopExecutable = 'agent-remote-control-desktop';
export const desktopIdentifier = 'com.whzxc.agent-remote-control';
export const desktopScheme = 'agent-remote-control';

export function developmentPort(env = process.env) {
  const value = env.ARC_DEV_PORT ?? '5187';
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('ARC_DEV_PORT must be an integer from 1 to 65535.');
  }
  return port;
}

export function developmentConfig(env = process.env) {
  const instance = env.ARC_DEV_INSTANCE_ID;
  if (instance && !/^[a-z0-9]{8,32}$/.test(instance)) {
    throw new Error('ARC_DEV_INSTANCE_ID must contain 8-32 lowercase letters or digits.');
  }
  const devUrl = new URL(`http://127.0.0.1:${developmentPort(env)}`).origin;
  const devCsp = `default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' ${devUrl} ${devUrl.replace('http:', 'ws:')}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:`;
  return {
    identifier: `${desktopIdentifier}.dev${instance ? `.${instance}` : ''}`,
    productName: instance ? `ARC Development ${instance}` : `${desktopName} Dev`,
    scheme: `${desktopScheme}-dev${instance ? `-${instance}` : ''}`,
    build: { devUrl },
    app: { security: { devCsp } },
  };
}

export function developmentEnvironment(home, env = process.env) {
  if (!path.isAbsolute(home) || !path.basename(home).startsWith('arc-godev-home')) throw new Error('Use an absolute arc-godev-home directory.');
  const result = { ...env, ARC_STATE_DIR: path.join(home, 'state'), ARC_MYGO_DEV_HOME: home };
  // Only the development app and its children see this home.
  if (process.platform === 'win32') Object.assign(result, { USERPROFILE: home, LOCALAPPDATA: path.join(home, 'AppData/Local'), APPDATA: path.join(home, 'AppData/Roaming') });
  else result.HOME = home;
  delete result.CODEX_HOME;
  return result;
}

export function isolatedStatus(identity, endpoint, desktop) {
  return { bundleId: identity.identifier, appName: identity.productName, desktopPid: desktop.pid, corePid: endpoint.pid,
    instance: endpoint.instance, desktopBuild: desktop.build, port: endpoint.port, screen: { action: 'tree', bundleId: identity.identifier } };
}
