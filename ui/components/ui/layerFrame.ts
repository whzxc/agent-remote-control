export type LayerKind = 'panel' | 'dialog';
export type LayerSize = 'm' | 'xl';
export type LayerRect = { x: number; y: number; width: number; height: number };
export type LayerViewport = { width: number; height: number; desktop: boolean };
export type LayerTokens = { sizes: { m: number; xl: number }; margin: number; desktopTop: number; browserTop: number };
/** Slot geometry depends only on the viewport and current content height. */
export function layerFrame(size: LayerSize, viewport: LayerViewport,
  tokens: LayerTokens, contentHeight: number, expanded = false) {
  const margin = Math.min(tokens.margin, viewport.width / 2, viewport.height / 2);
  const topLine = Math.min(viewport.desktop ? tokens.desktopTop : tokens.browserTop, viewport.height - margin);
  const collapsed = viewport.width < 760 || viewport.height > viewport.width;
  const availableWidth = Math.max(0, viewport.width - margin * 2);
  const width = collapsed || expanded ? availableWidth : Math.min(tokens.sizes[size], availableWidth);
  const height = Math.min(Math.max(0, contentHeight), Math.max(0, viewport.height - margin - topLine));
  const y = topLine + (viewport.height - margin - topLine - height) / 2;
  const maxHeight = Math.max(0, viewport.height - topLine - margin);
  const x = (viewport.width - width) / 2;
  return { x, y, width, height, maxHeight };
}
