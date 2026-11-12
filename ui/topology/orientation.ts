export type Orientation = 'landscape' | 'portrait';
export type LayoutPreference = Orientation | 'auto';

// A drag owns its slots until release, including changes to manual preference.
export function resolveOrientation(current: Orientation, preference: LayoutPreference, width: number, height: number, dragging = false): Orientation {
  if (dragging) return current;
  if (preference !== 'auto') return preference;
  if (!(width > 0 && height > 0) || !Number.isFinite(width / height)) return current;
  const ratio = width / height;
  return ratio <= 0.85 ? 'portrait' : ratio >= 1 ? 'landscape' : current;
}
