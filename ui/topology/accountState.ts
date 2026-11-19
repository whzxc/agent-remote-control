import { preference } from '../state/store';

export const topologyMode = preference<'tree' | 'flat'>('arc.topology-mode', 'tree', raw => JSON.parse(raw) === 'flat' ? 'flat' : 'tree');
export const topologyCollapsed = preference<Record<string, boolean>>('arc.topology-collapsed', {}, raw => {
  const value = JSON.parse(raw);
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([, collapsed]) => typeof collapsed === 'boolean')) as Record<string, boolean> : {};
});
