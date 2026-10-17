export type ToolPolicy = 'all' | { allowlist: string[] };
export type ToolMode = 'all' | 'common' | 'readOnly' | 'custom';
export interface ToolCatalog {
  groups: { id: string; label: { en: string; 'zh-CN': string } }[];
  required: string[];
  tools: { name: string; description: string; via: "query" | "act"; group: string; presets: string[]; requires: string[]; tier?: "default" | "advanced"; conditional?: boolean; available?: boolean }[];
}

// Only an explicit selection/save of a changed policy invokes normalization.
// Existing allowlists remain exact snapshots, including across catalog upgrades.
export function normalizeSelection(names: readonly string[], catalog: ToolCatalog): string[] {
  const selected = new Set([...names, ...catalog.required]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const tool of catalog.tools) {
      if (!selected.has(tool.name)) continue;
      for (const dependency of tool.requires) {
        if (!selected.has(dependency)) { selected.add(dependency); changed = true; }
      }
    }
  }
  const known = new Set(catalog.tools.map(tool => tool.name));
  return [...catalog.tools.filter(tool => selected.has(tool.name)).map(tool => tool.name),
    ...[...selected].filter(name => !known.has(name)).sort()];
}
export function presetPolicy(mode: 'common' | 'readOnly', catalog: ToolCatalog): ToolPolicy {
  return { allowlist: normalizeSelection(catalog.tools.filter(tool => tool.presets.includes(mode)).map(tool => tool.name), catalog) };
}
export function identifyPolicy(policy: ToolPolicy | undefined, catalog: ToolCatalog): ToolMode {
  if (!policy) return 'common';
  if (policy === 'all') return 'all';
  const selected = new Set(policy.allowlist);
  for (const mode of ['common', 'readOnly'] as const) {
    const preset = presetPolicy(mode, catalog) as { allowlist: string[] };
    if (selected.size === preset.allowlist.length && preset.allowlist.every(name => selected.has(name))) return mode;
  }
  return 'custom';
}
