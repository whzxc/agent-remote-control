import type { LayerKind, LayerTokens } from "./layerFrame";

export function layerInsetToken(kind: LayerKind, desktop: boolean) {
  if (kind === 'panel') return '--layer-panel-inset';
  return desktop ? '--layer-top-desktop' : '--layer-top-browser';
}

export function readLayerTokens(kind: LayerKind): LayerTokens {
  const css = getComputedStyle(document.documentElement);
  const value = (name: string, defaultValue: number) => {
    const raw = css.getPropertyValue(name).trim();
    const parsed = raw.endsWith('px') ? Number.parseFloat(raw) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
  };
  const margin = value('--layer-side-margin', 16);
  return { sizes: { m: value('--layer-m', 560), xl: value('--layer-xl', 960) }, margin,
    desktopInset: value(layerInsetToken(kind, true), kind === 'panel' ? 76 : 48),
    browserInset: value(layerInsetToken(kind, false), kind === 'panel' ? 76 : 20) };
}

