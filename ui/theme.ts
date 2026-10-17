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
  forest: { label: "themeForest", light: "#6f9d89", dark: "#afd1bf" },
  blue: { label: "themeBlue", light: "#007aff", dark: "#0a84ff" },
  purple: { label: "themePurple", light: "#943d96", dark: "#bf5af2" },
  pink: { label: "themePink", light: "#f8509e", dark: "#ff375f" },
  red: { label: "themeRed", light: "#e1393e", dark: "#ff453a" },
  orange: { label: "themeOrange", light: "#f78218", dark: "#ff9f0a" },
  yellow: { label: "themeYellow", light: "#ffc626", dark: "#ffd60a" },
  green: { label: "themeGreen", light: "#63ba47", dark: "#32d74b" },
  gray: { label: "themeGray", light: "#999998", dark: "#98989d" },
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
  const resolved =
    value === "system" ? (hostDark ?? system.matches) : value === "dark";
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
  if (isDesktop && navigator.platform.toLowerCase().includes("win"))
    void import("@tauri-apps/api/core")
      .then(({ invoke }) =>
        invoke("set_windows_appearance", { dark: resolved }),
      )
      .catch(console.error);
}
theme.subscribe(applyTheme);
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
