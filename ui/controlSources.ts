import registry from '../shared/control-sources.json';

// Metadata never constrains the backend's open-ended controlSource string.
export const controlSources = registry;
export const curatedSources = controlSources.filter(source => source.curated);
export function controlSource(id: string) {
  return controlSources.find(source => source.id === id);
}
export function controlSourcePlatform(product: string) {
  const source = controlSource(product);
  return source?.platform === 'xai' || product === 'xai'
    ? { id: 'xai', displayName: 'X' }
    : { id: product, displayName: source?.displayName ?? product };
}
export function nextSourceName(id: string, names: string[]) {
  const base = controlSource(id)?.displayName || id;
  let name = base, suffix = 2;
  while (names.includes(name)) name = `${base} ${suffix++}`;
  return name;
}
