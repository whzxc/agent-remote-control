export type LayerKind = 'panel' | 'dialog';
export type LayerSide = 'left' | 'right' | 'center';
export type LayerRect = { x: number; y: number; width: number; height: number };
export type LayerViewport = { width: number; height: number; desktop: boolean };
export type LayerTokens = { sizes: { m: number; xl: number }; margin: number; desktopTop: number; browserTop: number };
export function panelSlot(side: LayerSide, viewport: Pick<LayerViewport, 'width' | 'height'>) {
  return viewport.width < 760 || viewport.height > viewport.width ? 'collapsed' : side;
}
/** Center once; subsequent measurements preserve the top until growth reaches the bottom margin. */
export function layerFrame(kind: LayerKind, side: LayerSide, viewport: LayerViewport,
  tokens: LayerTokens, contentHeight: number, trigger?: LayerRect, expanded = false, previousTop?: number) {
  const margin = Math.min(tokens.margin, viewport.width / 2, viewport.height / 2);
  const topLine = Math.min(viewport.desktop ? tokens.desktopTop : tokens.browserTop, viewport.height - margin);
  const collapsed = panelSlot(side, viewport) === 'collapsed';
  const availableWidth = Math.max(0, viewport.width - margin * 2);
  const width = collapsed || expanded ? availableWidth : Math.min(tokens.sizes[kind === 'panel' && side === 'center' ? 'xl' : 'm'], availableWidth);
  const height = Math.min(Math.max(0, contentHeight), Math.max(0, viewport.height - margin - topLine));
  const centered = topLine + (viewport.height - margin - topLine - height) / 2;
  const y = Math.max(topLine, Math.min(previousTop ?? centered, viewport.height - margin - height));
  const maxHeight = Math.max(0, viewport.height - y - margin);
  const x = collapsed || side === 'left' && kind === 'panel' ? margin
    : side === 'right' && kind === 'panel' ? viewport.width - margin - width : (viewport.width - width) / 2;
  const distance = kind === 'panel' ? 8 : 6;
  const dx = trigger ? x + width / 2 - trigger.x - trigger.width / 2 : 0;
  const dy = trigger ? y + height / 2 - trigger.y - trigger.height / 2 : -1;
  const length = Math.hypot(dx, dy);
  const entry = length ? { x: dx / length * distance, y: dy / length * distance } : { x: 0, y: -distance };
  return { x, y, width, height, maxHeight, entry };
}
