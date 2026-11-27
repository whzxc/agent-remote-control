import { defineConfig } from "mygo-cli";
import { desktopExecutable, desktopIdentifier, desktopName, desktopScheme, developmentConfig } from "./tooling/dev-identity.mjs";
import { resolveMygoUpdatePublicKey } from "./tooling/mygo-update-public-key.mjs";

const development = process.env.ARC_MYGO_DEVELOPMENT === "1";
const identity = development ? developmentConfig() : { identifier: desktopIdentifier, productName: desktopName, scheme: desktopScheme };
const fixtureFrontend = development ? process.env.ARC_MYGO_FIXTURE_FRONTEND : undefined;
const updateKey = resolveMygoUpdatePublicKey(process.env, development, fixtureFrontend);
const updateBase = process.env.ARC_MYGO_UPDATE_BASE || "https://github.com/whzxc/agent-remote-control/releases/latest/download";
const macos = process.env.ARC_MYGO_MACOS === "1";
const resources = [
  macos ? "desktop/icons/menubar-18Template@2x.png" : "desktop/icons/tray-logo.png",
  "dist/mygo-input/bin",
  "skills",
  "licenses",
];
if (macos) resources.push("dist/mygo-input/icon/Assets.car");

export default defineConfig({
  name: desktopExecutable,
  slug: "agent-remote-control",
  identifier: identity.identifier,
  version: process.env.ARC_BUILD_VERSION || "0.0.0",
  main: "./cmd/arc-desktop",
  icon: development ? "desktop/icons/dev/icon.png" : "desktop/icons/icon.png",
  frontendDist: fixtureFrontend || "dist/ui",
  buildCommand: "node tooling/prepare-desktop.mjs",
  resources,
  bindings: "ui/mygo.generated.ts",
  urlSchemes: [identity.scheme],
  macos: {
    minimumSystemVersion: "13.0",
    infoPlist: {
      CFBundleName: identity.productName,
      CFBundleDisplayName: identity.productName,
      CFBundleIconName: "Icon",
      CFBundleIconFile: "Icon",
      CFBundleDevelopmentRegion: "en",
      CFBundleURLTypes: [{
        CFBundleURLName: identity.identifier,
        CFBundleTypeRole: "Viewer",
        CFBundleURLSchemes: [identity.scheme],
      }],
    },
  },
  windows: { displayName: identity.productName, installDirName: desktopName },
  ...(updateKey ? { updates: { publicKey: updateKey, url: fixtureFrontend ? updateBase.replace(/^http:/, "https:") : updateBase, deltas: 0 } } : {}),
});
