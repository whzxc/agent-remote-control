import { execFileSync } from 'node:child_process';
import { copyFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { desktopExecutable } from './dev-identity.mjs';
import { macosSigningArgs } from './macos-signing.mjs';

export async function finishMacosApp(directory, { productName, identifier }, signingIdentity, env, icon) {
  const app = path.join(directory, `${productName}.app`);
  await rename(path.join(directory, `${desktopExecutable}.app`), app);
  // The native asset catalog and fallback icon both use the historical Icon name.
  await rm(path.join(app, 'Contents/Resources/icon.icns'), { force: true });
  await copyFile(icon, path.join(app, 'Contents/Resources/Icon.icns'));
  const helpers = path.join(app, 'Contents/Resources/bin');
  for (const [file, suffix] of [['arc', 'core'], ['arc-screen', 'screen']]) {
    execFileSync('codesign', [...macosSigningArgs(signingIdentity, `${identifier}.${suffix}`), path.join(helpers, file)], { env, stdio: 'inherit' });
  }
  execFileSync('codesign', [...macosSigningArgs(signingIdentity, identifier), app], { env, stdio: 'inherit' });
  return app;
}
