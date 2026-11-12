import { DEFAULTS, PARAMETERS, type ParameterKey, type Params } from "./solve.ts";

export interface ParameterDocument { schemaVersion: 1; overrides: Partial<Params> }
export const emptyParameters = (): ParameterDocument => ({ schemaVersion: 1, overrides: {} });
export function clampParameter(key: ParameterKey, value: number, defaults = DEFAULTS) {
  const spec = PARAMETERS.find(p => p.key === key)!;
  return Number.isFinite(value) ? Math.max(spec.min, Math.min(spec.max, value)) : defaults[key];
}
export function parameterDiff(values: Params, defaults = DEFAULTS): ParameterDocument {
  return { schemaVersion: 1, overrides: Object.fromEntries(PARAMETERS.flatMap(({ key }) => {
    const value = clampParameter(key, values[key], defaults);
    return value === defaults[key] ? [] : [[key, value]];
  })) };
}
export function loadParameters(document: ParameterDocument, defaults = DEFAULTS): Params {
  return Object.fromEntries(PARAMETERS.map(({ key }) => [key,
    clampParameter(key, document.overrides[key] ?? defaults[key], defaults),
  ])) as Params;
}
type ImportResult = { ok: true; document: ParameterDocument; clamped: ParameterKey[] }
  | { ok: false; error: "json" | "schema" | "key" | "value" };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function importParameters(json: string, defaults = DEFAULTS): ImportResult {
  let input: unknown;
  try { input = JSON.parse(json); } catch { return { ok: false, error: "json" }; }
  if (!object(input) || input.schemaVersion !== 1 || !object(input.overrides)
    || Object.keys(input).some(key => !["schemaVersion", "overrides"].includes(key))) return { ok: false, error: "schema" };
  const values = { ...defaults }, clamped: ParameterKey[] = [];
  for (const [name, value] of Object.entries(input.overrides)) {
    const spec = PARAMETERS.find(p => p.key === name);
    if (!spec) return { ok: false, error: "key" };
    if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, error: "value" };
    values[spec.key] = clampParameter(spec.key, value, defaults);
    if (values[spec.key] !== value) clamped.push(spec.key);
  }
  return { ok: true, document: parameterDiff(values, defaults), clamped };
}
