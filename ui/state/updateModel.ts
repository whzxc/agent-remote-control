export type UpdateSnapshot = {
  phase: 'idle' | 'checking' | 'downloading' | 'installing';
  revision?: number;
  update?: { available: boolean; version?: string; notes?: string | null; ready?: boolean } | null;
  error?: string | null;
  errorStage?: string | null;
  downloaded?: number;
  total?: number | null;
};
export const idleUpdate = (): UpdateSnapshot => ({ phase: 'idle', update: null });
export const updateActive = (value: UpdateSnapshot) => value.phase !== 'idle';
