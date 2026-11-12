/** Read the design-owned motion values for imperative Motion animations. */
export function motionTransition(token: 'fast' | 'base' | 'panel' = 'base') {
  const defaults = { fast: 120, base: 160, panel: 180 };
  const style = typeof document === 'undefined' ? undefined : getComputedStyle(document.documentElement);
  const raw = style?.getPropertyValue(`--motion-${token}`).trim() ?? '';
  const match = raw.match(/^([\d.]+)(ms|s)$/);
  const duration = match ? Number(match[1]) * (match[2] === 's' ? 1 : .001) : defaults[token] / 1000;
  const curve = style?.getPropertyValue('--ease-enter').match(/cubic-bezier\(([^)]+)\)/)?.[1].split(',').map(Number);
  const ease: [number, number, number, number] = curve?.length === 4 && curve.every(Number.isFinite) ? curve as [number, number, number, number] : [.16, 1, .3, 1];
  return { duration, ease };
}
