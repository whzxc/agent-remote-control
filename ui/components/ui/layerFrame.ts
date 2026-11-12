export type LayerKind = 'panel' | 'dialog';
export type LayerSize = 's' | 'm' | 'l' | 'xl';
export type LayerSide = 'left' | 'right' | 'center';
export type LayerRect = { x: number; y: number; width: number; height: number };
export type LayerViewport = { width: number; height: number; desktop: boolean };
export type LayerTokens = {
  sizes: Record<LayerSize, number>;
  margin: number;
  desktopTop: number;
  browserTop: number;
};

/** Slot geometry is independent of the trigger. Entry is the movement toward the slot. */
export function layerFrame(kind: LayerKind, size: LayerSize, side: LayerSide, viewport: LayerViewport,
  tokens: LayerTokens, contentHeight: number, trigger?: LayerRect, expanded = false) {
  const margin = Math.min(tokens.margin, viewport.width / 2, viewport.height / 2);
  const topLine = viewport.desktop ? tokens.desktopTop : tokens.browserTop;
  const y = Math.min(kind === 'dialog' ? Math.max(topLine, viewport.height * 0.12) : topLine,
    viewport.height - margin);
  const collapsed = viewport.width < 760 || viewport.height > viewport.width;
  const availableWidth = Math.max(0, viewport.width - margin * 2);
  const width = collapsed || expanded ? availableWidth : Math.min(tokens.sizes[size], availableWidth);
  const maxHeight = Math.max(0, viewport.height - y - margin);
  const height = Math.min(Math.max(0, contentHeight), maxHeight);
  const x = collapsed || side === 'left' && kind === 'panel' ? margin
    : side === 'right' && kind === 'panel' ? viewport.width - margin - width : (viewport.width - width) / 2;
  const distance = kind === 'panel' ? 8 : 6;
  const dx = trigger ? x + width / 2 - trigger.x - trigger.width / 2 : 0;
  const dy = trigger ? y + height / 2 - trigger.y - trigger.height / 2 : -1;
  const length = Math.hypot(dx, dy);
  const entry = length ? { x: dx / length * distance, y: dy / length * distance } : { x: 0, y: -distance };
  return { x, y, width, height, maxHeight, entry };
}
