import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Public certificate fingerprint, never a private key or a keychain-selected identity.
const releaseCertificate = 'DCE238666578502CF7DE81A7B4D5E835A186BC60';
const releaseCertificateName = 'Local Connector Self Signed';

// Never let the bundler select an identity from the keychain automatically.
function isDeveloperId(identity) {
  return /^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(identity);
}

export function macosSigningIdentity(env, { release = false } = {}) {
  if (process.platform === 'darwin' && release) {
    const requested = env.APPLE_SIGNING_IDENTITY?.trim();
    if (requested && requested !== releaseCertificateName && requested.toUpperCase() !== releaseCertificate) {
      throw new Error('Production macOS builds must use the fixed personal self-signed certificate. Ad-hoc signatures and other Teams are not allowed. See docs/dev/release.md.');
    }
    const identities = execFileSync('security', ['find-identity', '-p', 'codesigning'], {
      encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL',
    });
    if (!identities.includes(releaseCertificate)) {
      throw new Error('The keychain lacks the production certificate and private key Local Connector Self Signed. Import the original certificate. Do not generate a replacement or fall back to ad-hoc signing.');
    }
    for (const key of Object.keys(env)) if (key.startsWith('APPLE_')) delete env[key];
    env.APPLE_SIGNING_IDENTITY = releaseCertificate;
    return releaseCertificate;
  }
  const identity = process.platform === 'darwin' ? env.APPLE_SIGNING_IDENTITY?.trim() : undefined;
  if (!identity || identity === '-' || !isDeveloperId(identity)) {
    for (const key of Object.keys(env)) if (key.startsWith('APPLE_')) delete env[key];
  }
  if (!identity || identity === '-') return '-';
  env.APPLE_SIGNING_IDENTITY = identity;
  return identity;
}

export function macosSigningArgs(identity, identifier, hardenedRuntime = true) {
  return [
    '--force', '--sign', identity, '--identifier', identifier,
    ...(identity !== '-' && hardenedRuntime ? ['--options', 'runtime'] : []),
    ...(isDeveloperId(identity) ? ['--timestamp'] : []),
  ];
}

export function verifyMacosReleaseSignature(file, identifier) {
  execFileSync('codesign', ['--verify', '--strict', '-R',
    `=identifier "${identifier}" and certificate leaf = H"${releaseCertificate.toLowerCase()}"`, file],
  { stdio: 'inherit' });
}

export function preflightMacosSigning(env) {
  const identity = macosSigningIdentity(env, { release: true });
  const directory = mkdtempSync(join(tmpdir(), 'arc-signing-'));
  try {
    const probe = join(directory, 'probe');
    copyFileSync('/usr/bin/true', probe);
    execFileSync('codesign', [...macosSigningArgs(identity, 'com.whzxc.agent-remote-control.signing-probe'), probe], {
      env, timeout: 3000, killSignal: 'SIGKILL', stdio: ['ignore', 'ignore', 'pipe'],
    });
    return identity;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
