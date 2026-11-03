import { useEffect, useState } from "react";
import { createStore } from "./store";
import { activeOverrides, clockNow, type EnvSample } from "./appEnvModel";
import { isDesktop } from "../platform";
import { readOnlyBrowser } from '../browserMode';

export const appEnvironment = createStore<EnvSample | undefined>(undefined);
export const envOverrides = () => activeOverrides(appEnvironment.get(), Date.now());
export const appNow = () => clockNow(appEnvironment.get(), Date.now());
// App-owned media observation. Never patches matchMedia or host settings.
export function environmentMedia(query: string) {
  const media = matchMedia(query);
  const listeners = new Map<() => void, () => void>();
  return {
    get matches() { return query === "(prefers-reduced-motion: reduce)" ? envOverrides().reducedMotion ?? media.matches : media.matches; },
    addEventListener(_event: "change", listener: () => void) {
      media.addEventListener("change", listener);
      listeners.set(listener, appEnvironment.subscribe(listener));
    },
    removeEventListener(_event: "change", listener: () => void) {
      media.removeEventListener("change", listener);
      listeners.get(listener)?.(); listeners.delete(listener);
    },
  };
}
export function useReducedMotion() {
  const [value, setValue] = useState(() => environmentMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const media = environmentMedia("(prefers-reduced-motion: reduce)");
    const update = () => setValue(media.matches);
    media.addEventListener("change", update); update();
    return () => media.removeEventListener("change", update);
  }, []);
  return value;
}
export function useAppNow(interval: number | null = 1000) {
  const [now, setNow] = useState(appNow);
  const sample = appEnvironment.use();
  const delay = sample?.active && sample.clock.source === "override" ? 1000 : interval;
  useEffect(() => {
    const update = () => setNow(appNow());
    const off = appEnvironment.subscribe(update);
    const timer = delay === null ? undefined : setInterval(update, delay);
    update();
    return () => { off(); clearInterval(timer); };
  }, [delay]);
  return now;
}
let pending: Promise<void> | undefined;
let appliedSize: string | undefined;
export function refreshAppEnvironment() {
  if (readOnlyBrowser) return Promise.resolve();
  return pending ??= (async () => {
    const { api } = await import("../api");
    const sample = await api<EnvSample>("app/env");
    if (!sample || typeof sample.active !== "boolean") return;
    const previous = appEnvironment.get();
    const changed = !previous || JSON.stringify(previous.overrides) !== JSON.stringify(sample.overrides) || previous.expiresAt !== sample.expiresAt;
    // Keep the real/virtual anchor until an input changes; polling must not rerender every consumer.
    if (changed) appEnvironment.set(sample);
    const overrides = activeOverrides(sample, Date.now());
    const width = overrides.windowWidth ?? null, height = overrides.windowHeight ?? null;
    const size = JSON.stringify([width, height]);
    if (isDesktop && (size !== appliedSize || width !== null && Math.abs(innerWidth - width) > 1 || height !== null && Math.abs(innerHeight - height) > 1)) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("apply_env_window", { width, height });
      appliedSize = size;
    }
  })().finally(() => { pending = undefined; });
}
export function observeAppEnvironment() {
  const media = environmentMedia("(prefers-reduced-motion: reduce)");
  const update = () => { document.documentElement.dataset.reducedMotion = String(media.matches); };
  media.addEventListener("change", update); update();
  const refresh = () => {
    if (document.hidden) return;
    const sample = appEnvironment.get();
    if (sample?.active && sample.expiresAt !== null && Date.now() >= sample.expiresAt) appEnvironment.set(undefined);
    void refreshAppEnvironment().catch(console.error);
  };
  refresh();
  document.addEventListener("visibilitychange", refresh);
  const timer = setInterval(refresh, 500);
  return () => { clearInterval(timer); document.removeEventListener("visibilitychange", refresh); media.removeEventListener("change", update); };
}
