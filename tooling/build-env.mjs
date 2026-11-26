import { buildVersion } from './version.mjs';

export const versionSymbol = 'github.com/whzxc/agent-remote-control/internal/core.buildVersion';

export function buildEnv() {
  const env = { ...process.env, ARC_BUILD_VERSION: buildVersion(), CGO_ENABLED: '0' };
  delete env.GOOS;
  delete env.GOARCH;
  // Packaging selects all build tags and linker settings explicitly.
  delete env.GOFLAGS;
  return env;
}

export function goTarget(value = `${process.platform}/${process.arch}`) {
  const aliases = {
    'aarch64-apple-darwin': 'darwin/arm64',
    'x86_64-pc-windows-msvc': 'windows/amd64',
    'x86_64-unknown-linux-gnu': 'linux/amd64',
    'aarch64-unknown-linux-gnu': 'linux/arm64',
  };
  let [os, arch] = (aliases[value] || value).split('/');
  if (os === 'win32') os = 'windows';
  if (arch === 'x64') arch = 'amd64';
  if (!/^(darwin|windows|linux)\/(amd64|arm64)$/.test(`${os}/${arch}`) ||
      !(aliases[value] || value).match(/^[^/]+\/[^/]+$/)) {
    throw new Error(`Expected a Go desktop or Core target, got ${value}.`);
  }
  return { os, arch, name: `${os}/${arch}`, suffix: os === 'windows' ? '.exe' : '' };
}

export function coreFlags(version, release = false) {
  return ['-trimpath', '-ldflags', `-X ${versionSymbol}=${version}${release ? ' -s -w' : ''}`];
}
