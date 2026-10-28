import { studioTone } from './display/state';
import { appEnvironment, envOverrides } from "./state/appEnvironment";
import { createStore, preference } from "./state/store";
import { isDesktop } from "./platform";
import "./tokens.css";
export type Theme = "system" | "light" | "dark";
export const theme = preference<Theme>(
  "theme",
  "system",
  (value) => (value === "light" || value === "dark" ? value : "system"),
  (value) => value,
);
export const themeColors = {
  arc: { label: "themeArc", light: "#5B5FF5", dark: "#7A7DFF" },
  blue: { label: "themeBlue", sourceLight: "#00a6c7", sourceDark: "#64d2ff", light: "#007aff", dark: "#0a84ff" },
  purple: { label: "themePurple", sourceLight: "#f8509e", sourceDark: "#ff75b5", light: "#943d96", dark: "#bf5af2" },
  orange: { label: "themeOrange", sourceLight: "#e1393e", sourceDark: "#ff453a", light: "#f78218", dark: "#ff9f0a" },
  green: { label: "themeGreen", sourceLight: "#e0b219", sourceDark: "#ffd60a", light: "#22b85c", dark: "#43e773" },
} as const;
export const themeColor = preference<keyof typeof themeColors>(
  "theme-color",
  "arc",
  (value) =>
    Object.hasOwn(themeColors, value)
      ? (value as keyof typeof themeColors)
      : "arc",
  (value) => value,
);
const system = matchMedia("(prefers-color-scheme: dark)");
export const dark = createStore(system.matches);
let hostDark: boolean | undefined;
function applyTheme() {
  const value = theme.get();
  const studio = studioTone.get();
  const resolved = studio ? studio === "night" :
    envOverrides().colorScheme ? envOverrides().colorScheme === "dark" : value === "system" ? (hostDark ?? system.matches) : value === "dark";
  if (studio) document.documentElement.dataset.studioPhase = studio;
  else delete document.documentElement.dataset.studioPhase;
  dark.set(resolved);
  document.documentElement.dataset.theme = resolved ? "dark" : "light";
  document.documentElement.style.colorScheme = resolved ? "dark" : "light";
  document.documentElement.dataset.themeColor = themeColor.get();
  const color = themeColors[themeColor.get()];
  document.documentElement.style.setProperty(
    "--accent",
    resolved ? color.dark : color.light,
  );
  document.documentElement.style.setProperty("--accent-dark", color.dark);
  if ("sourceLight" in color)
    document.documentElement.style.setProperty("--theme-source", resolved ? color.sourceDark : color.sourceLight);
  else document.documentElement.style.removeProperty("--theme-source");
  if (isDesktop && navigator.platform.toLowerCase().includes("win"))
    void import("@tauri-apps/api/core")
      .then(({ invoke }) =>
        invoke("set_windows_appearance", { dark: resolved }),
      )
      .catch(console.error);
}
appEnvironment.subscribe(applyTheme);
theme.subscribe(applyTheme);
studioTone.subscribe(applyTheme);
themeColor.subscribe(applyTheme);
system.addEventListener("change", () => {
  hostDark = undefined;
  applyTheme();
});
applyTheme();
// The main native window remains in system mode; manual appearance affects the UI.
// This lets System resume following host theme events without persisting a resolved value.
export function observeNativeTheme() {
  let stopped = false;
  let off: (() => void) | undefined;
  if (isDesktop)
    void import("@tauri-apps/api/window")
      .then(async ({ getCurrentWindow }) => {
        const win = getCurrentWindow();
        const current = await win.theme();
        if (stopped) return;
        hostDark = current === null ? undefined : current === "dark";
        applyTheme();
        const dispose = await win.onThemeChanged((event) => {
          hostDark = event.payload === "dark";
          applyTheme();
        });
        if (stopped) dispose();
        else off = dispose;
      })
      .catch(console.error);
  return () => {
    stopped = true;
    off?.();
  };
}

// Native MCP surfaces follow their host without changing desktop preferences.
export function applyMcpHostTheme(context: unknown) {
  if (!context || typeof context !== 'object') return;
  const host = context as {theme?: string; styles?: {variables?: Record<string, string>}};
  if (host.theme === 'light' || host.theme === 'dark') {
    document.documentElement.dataset.theme = host.theme;
    document.documentElement.style.colorScheme = host.theme;
  }
  document.documentElement.dataset.surface = 'mcp';
  for (const [key, value] of Object.entries(host.styles?.variables ?? {})) {
    if (key.startsWith('--') && typeof value === 'string') document.documentElement.style.setProperty(key, value);
  }
}
