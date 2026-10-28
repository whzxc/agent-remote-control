import { decorativeSvg } from '../decorative';
import manifest from './manifest.json';

const artwork = import.meta.glob('./*.svg', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
const resolve = (mapping: Record<string, string>): Record<string, string> => Object.fromEntries(
  Object.entries(mapping).map(([id, file]) => [id, decorativeSvg(artwork[`./${file}.svg`])]),
);
export const agentIcons = resolve(manifest.agents);
export const platformIcons = resolve(manifest.platforms);
export const productIcons = resolve(manifest.products);
