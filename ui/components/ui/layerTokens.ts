import type { LayerTokens } from "./layerFrame";

export function readLayerTokens(): LayerTokens {
  const css = getComputedStyle(document.documentElement);
  const fallback: LayerTokens = { sizes: { s: 400, m: 560, l: 720, xl: 960 }, margin: 16, desktopTop: 48, browserTop: 20 };
  const value = (name: string, defaultValue: number) => {
    const raw = css.getPropertyValue(name).trim();
    const parsed = raw.endsWith('px') ? Number.parseFloat(raw) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
  };
  return { sizes: { s: value('--layer-s', fallback.sizes.s), m: value('--layer-m', fallback.sizes.m),
    l: value('--layer-l', fallback.sizes.l), xl: value('--layer-xl', fallback.sizes.xl) },
    margin: value('--layer-side-margin', fallback.margin), desktopTop: value('--layer-top-desktop', fallback.desktopTop), browserTop: value('--layer-top-browser', fallback.browserTop) };
}

