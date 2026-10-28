import { createStore, preference } from "./store";
import { DEFAULTS, type ParameterKey } from "../topology/solve";
import { clampParameter, emptyParameters, importParameters, loadParameters, parameterDiff } from "../topology/parameters";

export const topologyTuningEnabled = preference("arc.topology-tuning", false, raw => JSON.parse(raw) === true);
export const topologyParameters = preference("arc.topology-parameters", emptyParameters(), raw => {
  const input = JSON.parse(raw);
  const overrides = input?.schemaVersion === 1 && input.overrides && typeof input.overrides === "object" && !Array.isArray(input.overrides)
    ? input.overrides : null;
  const removed = ["bubbleWeight", "activeScale", "idleScale", "minIdleScale"];
  const migrated = overrides && ["pitch", ...removed].some(key => Object.hasOwn(overrides, key));
  if (overrides && Object.hasOwn(overrides, "pitch")) {
    if (typeof overrides.pitch !== "number" || !Number.isFinite(overrides.pitch)) throw new Error("Invalid task pitch");
    if (!Object.hasOwn(overrides, "taskGap")) overrides.taskGap = Math.max(0, overrides.pitch - 54);
    delete overrides.pitch;
  }
  if (overrides) for (const key of removed) delete overrides[key];
  const result = importParameters(JSON.stringify(input));
  if (!result.ok) throw new Error(result.error);
  if (migrated) queueMicrotask(() => {
    if (topologyParameters.get() !== result.document) return;
    try {
      // Replace the cache so the preference store also writes the migrated document to Core.
      localStorage.removeItem("arc.topology-parameters");
      topologyParameters.set({ ...result.document });
    } catch {
      // The parsed preferences remain usable when browser storage is unavailable.
    }
  });
  return result.document;
});
// Slider preview does not flood native preferences with in-flight writes.
export const topologyValues = createStore(loadParameters(topologyParameters.get()));
topologyParameters.subscribe(() => topologyValues.set(loadParameters(topologyParameters.get())));
export function previewParameter(key: ParameterKey, value: number) {
  const clamped = clampParameter(key, value);
  topologyValues.set(old => ({ ...old, [key]: clamped }));
  return !Number.isFinite(value) || clamped !== value;
}
export function saveTopologyParameters() {
  topologyParameters.set(parameterDiff(topologyValues.get()));
}
export function resetTopologyParameter(key?: ParameterKey) {
  topologyValues.set(key ? { ...topologyValues.get(), [key]: DEFAULTS[key] } : { ...DEFAULTS });
  saveTopologyParameters();
}
export const topologyDebug = createStore({ guides: false, slow: false });
export const topologyPanel = preference("arc.topology-panel", { x: 16, y: 48, collapsed: true }, raw => {
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("Invalid panel position");
  return { x: Number.isFinite(value.x) ? Math.max(0, value.x) : 16,
    y: Number.isFinite(value.y) ? Math.max(48, value.y) : 48, collapsed: value.collapsed !== false };
});
