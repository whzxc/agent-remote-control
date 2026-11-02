import type { Ingress } from './state/types.ts';

export type ConnectionReadiness = 'unknown' | 'stopped' | 'starting' | 'stopping' | 'ready' | 'partial' | 'error';

export function connectionReadiness(ingresses: readonly Pick<Ingress, 'enabled' | 'running' | 'state' | 'error'>[] | undefined): ConnectionReadiness {
  if (!ingresses) return 'unknown';
  const entries = ingresses.filter(entry => entry.enabled || entry.running);
  if (!entries.length) return 'stopped';
  if (entries.some(entry => entry.state === 'stopping')) return 'stopping';
  if (entries.some(entry => entry.state === 'starting')) return 'starting';
  const ready = entries.filter(entry => entry.running && entry.state === 'ready' && !entry.error).length;
  if (ready === entries.length) return 'ready';
  if (ready) return 'partial';
  if (entries.some(entry => entry.error || ['error', 'degraded'].includes(entry.state))) return 'error';
  return entries.every(entry => !entry.running && entry.state === 'stopped') ? 'stopped' : 'unknown';
}
