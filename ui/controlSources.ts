import registry from '../shared/control-sources.json';

// Metadata never constrains the backend's open-ended controlSource string.
export const controlSources = registry;
export const curatedSources = controlSources.filter(source => source.curated);
export function controlSource(id: string) {
  return controlSources.find(source => source.id === id);
}
export const sourcePlatforms = [
  { id: 'openai', displayName: 'OpenAI', icon: 'openai' },
  { id: 'anthropic', displayName: 'Anthropic', icon: 'anthropic' },
  { id: 'google', displayName: 'Google', icon: 'google' },
  { id: 'xai', displayName: 'xAI', icon: 'xai' },
  { id: 'microsoft', displayName: 'Microsoft', icon: 'microsoft' },
  { id: 'notion', displayName: 'Notion', icon: 'notion' },
  { id: 'slack', displayName: 'Slack', icon: 'slack' },
  { id: 'raycast', displayName: 'Raycast', icon: 'raycast' },
  { id: 'cursor', displayName: 'Cursor', icon: 'cursor' },
  { id: 'opencode', displayName: 'OpenCode', icon: 'opencode' },
  { id: 'alibaba', displayName: 'Alibaba', icon: 'alibaba' },
  { id: 'custom', displayName: 'Other', icon: 'custom' },
];
export function controlSourcePlatform(product: string) {
  const id = controlSource(product)?.platform ?? product;
  return sourcePlatforms.find(platform => platform.id === id) ?? sourcePlatforms[sourcePlatforms.length - 1];
}
export function nextSourceName(id: string, names: string[]) {
  const base = controlSource(id)?.displayName || id;
  let name = base, suffix = 2;
  while (names.includes(name)) name = `${base} ${suffix++}`;
  return name;
}
