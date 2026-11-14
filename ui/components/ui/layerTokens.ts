import type { LayerKind, LayerTokens } from "./layerFrame";

export function readLayerTokens(kind: LayerKind): LayerTokens {
  const css = getComputedStyle(document.documentElement);
  const value = (name: string, defaultValue: number) => {
    const raw = css.getPropertyValue(name).trim();
    const parsed = raw.endsWith('px') ? Number.parseFloat(raw) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
  };
  const margin = value('--layer-side-margin', 16);
  return { sizes: { m: value('--layer-m', 560), xl: value('--layer-xl', 960) }, margin,
    bottom: kind === 'panel' ? value('--layer-panel-bottom', 76) : margin,
    desktopTop: value('--layer-top-desktop', 48), browserTop: value('--layer-top-browser', 20) };
}

