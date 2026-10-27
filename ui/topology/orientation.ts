export type Orientation = 'landscape' | 'portrait';
export type LayoutPreference = Orientation | 'auto';

export function resolveOrientation(current: Orientation, preference: LayoutPreference, width: number, height: number): Orientation {
  if (preference !== 'auto') return preference;
  if (!(width > 0 && height > 0) || !Number.isFinite(width / height)) return current;
  const ratio = width / height;
  return ratio <= 0.85 ? 'portrait' : ratio >= 1 ? 'landscape' : current;
}
