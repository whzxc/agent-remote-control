import { defineConfig } from "mygo-cli";

const productName = "Agent Remote Control";
const updateKey = process.env.ARC_MYGO_UPDATE_PUBLIC_KEY;
const updateURL = "https://github.com/whzxc/agent-remote-control/releases/latest/download";

export default defineConfig({
  // MyGo derives the physical executable name from this field.
  name: "agent-remote-control-desktop",
  slug: "agent-remote-control",
  identifier: "com.whzxc.agent-remote-control",
  version: process.env.ARC_BUILD_VERSION || "0.0.0",
  main: "./cmd/arc-desktop",
  icon: "desktop/icons/icon.png",
  frontendDist: "dist/ui",
  buildCommand: "npm exec -- vite build --config vite.config.ts",
  resources: ["desktop/icons/menubar-18Template@2x.png", "desktop/icons/tray-logo.png", "dist/mygo-input/bin"],
  bindings: "ui/mygo.generated.ts",
  urlSchemes: ["agent-remote-control"],
  macos: {
    icon: "desktop/icons/AgentRemoteControl.icon",
    infoPlist: { CFBundleName: productName, CFBundleDisplayName: productName },
  },
  windows: { displayName: productName, installDirName: productName },
  ...(updateKey ? { updates: { publicKey: updateKey, url: updateURL } } : {}),
});
