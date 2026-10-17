import { execFileSync } from 'node:child_process';

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
      throw new Error('正式 macOS 构建必须使用固定的个人自签名证书；不允许 ad-hoc 或其他 Team。详见 docs/dev/release.md。');
    }
    const identities = execFileSync('security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8' });
    if (!identities.includes(releaseCertificate)) {
      throw new Error('钥匙串缺少正式签名证书及私钥 Local Connector Self Signed；请导入原证书，不要重新生成或回退 ad-hoc。');
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
