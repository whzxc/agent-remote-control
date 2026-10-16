import { useSyncExternalStore } from "react";

// Small immutable stores share native snapshots and preferences across React roots.
export function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  const get = () => value;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const set = (next: T | ((previous: T) => T)) => {
    const updated =
      typeof next === "function" ? (next as (previous: T) => T)(value) : next;
    if (Object.is(value, updated)) return;
    value = updated;
    listeners.forEach((listener) => listener());
  };
  return {
    get,
    set,
    subscribe,
    use: () => useSyncExternalStore(subscribe, get),
  };
}
const preferenceListeners = new Map<string, (raw: string | null) => void>();
let applyingPreferences = false;
let preferencesReady: Promise<void> | undefined;
export function preparePreferences(): Promise<void> {
  return preferencesReady ??= import("../api").then(async ({api}) => {
    const defaults = await api<Record<string,string>>("preferences");
    const values: Record<string,string> = {};
    for (const key of [...Object.keys(defaults),...preferenceListeners.keys(),"update-announcement"]) {
      const value = localStorage.getItem(key);
      if (value !== null) values[key] = value;
    }
    acceptPreferences(await api<Record<string,string>>("preferences/import","POST",{values}));
  }).catch((error) => {preferencesReady = undefined; throw error;});
}
export const preferenceStorage = {
  getItem: (key: string) => localStorage.getItem(key),
  setItem(key: string, value: string) {
    if (localStorage.getItem(key) === value) return;
    localStorage.setItem(key,value);
    if (!applyingPreferences) void import("../api").then(({api}) => api("preferences","PUT",{values:{[key]:value}})).catch(console.error);
  },
  removeItem(key: string) {
    if (localStorage.getItem(key) === null) return;
    localStorage.removeItem(key);
    if (!applyingPreferences) void import("../api").then(({api}) => api("preferences","PUT",{values:{[key]:null}})).catch(console.error);
  },
};
export function acceptPreferences(values: Record<string,string>) {
  applyingPreferences = true;
  try {
    for (const [key,value] of Object.entries(values)) {
      if (localStorage.getItem(key) === value) continue;
      localStorage.setItem(key,value);
      preferenceListeners.get(key)?.(value);
    }
  } finally { applyingPreferences = false; }
}
export function preference<T>(
  key: string,
  fallback: T,
  parse: (raw: string) => T = JSON.parse,
  serialize: (value: T) => string = JSON.stringify,
) {
  let initial = fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) initial = parse(raw);
  } catch {
    /* Use the default if storage is unavailable. */
  }
  const store = createStore(initial);
  store.subscribe(() => {
    try {
      preferenceStorage.setItem(key, serialize(store.get()));
    } catch {
      /* The session remains usable without storage. */
    }
  });
  preferenceListeners.set(key, (raw) => {
    try { store.set(raw === null ? fallback : parse(raw)); } catch {store.set(fallback);}
  });
  window.addEventListener("storage", (event) => {
    if (event.key === key) {
      try {
        store.set(event.newValue === null ? fallback : parse(event.newValue));
      } catch {
        store.set(fallback);
      }
    }
  });
  return store;
}

export const notificationsPreference = preference("notifications",true, value => value !== "off", value => value ? "on" : "off");

export const mascotPreference = preference("mascot", false, value => value === "on", value => value ? "on" : "off");
