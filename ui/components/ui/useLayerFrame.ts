import { useLayoutEffect, useRef, useState } from 'react';
import { isDesktop } from '../../platform';
import { layerFrame, type LayerKind, type LayerSide } from './layerFrame';
import type { NaturalContent } from './LayerPortals';
import { readLayerTokens } from './layerTokens';

/** Observe the capped natural content box, never individual streaming mutations. */
export function useLayerFrame(content: HTMLElement | null, {
  kind, side, expanded, viewKey, retainedViewHeight, naturalBody, chromeVersion,
}: { kind: LayerKind; side: LayerSide; expanded: boolean; viewKey: string; retainedViewHeight?: number; naturalBody?: NaturalContent; chromeVersion: string }) {
  const [frame, setFrame] = useState<ReturnType<typeof layerFrame>>();
  const previousNatural = useRef<HTMLElement>(undefined);
  const retained = useRef(0), previousView = useRef(viewKey);
  if (previousView.current !== viewKey) { retained.current = 0; previousView.current = viewKey; }
  if (naturalBody?.node !== previousNatural.current) { if (naturalBody?.resetHeight) retained.current = 0; previousNatural.current = naturalBody?.node; }
  useLayoutEffect(() => {
    if (!content) return;
    const update = (height: number) => {
      const desired = retainedViewHeight ?? height;
      const next = layerFrame(kind, side, { width: innerWidth, height: innerHeight, desktop: isDesktop }, readLayerTokens(),
        kind === 'panel' ? Math.max(retained.current, desired) : desired, expanded);
      if (kind === 'panel') retained.current = next.height;
      setFrame(old => old && Object.keys(next).every(key => old[key as keyof typeof next] === next[key as keyof typeof next]) ? old : next);
    };
    const target = naturalBody?.node ?? content;
    // Cache fixed chrome when attaching a scroll view, not for each streaming text change.
    const body = naturalBody && content.querySelector<HTMLElement>('.dialog-body');
    const footer = naturalBody && content.querySelector<HTMLElement>('.dialog-footer:not([hidden])');
    const measureChrome = () => {
      if (!body) return 0;
      let scrolled = body.scrollTop;
      for (let parent = target.parentElement; parent && parent !== body; parent = parent.parentElement) scrolled += parent.scrollTop;
      const flexible = naturalBody?.flexibleFooter && footer && Number(getComputedStyle(footer).flexShrink) > 0;
      return content.getBoundingClientRect().height - body.getBoundingClientRect().height
        - (flexible ? footer.getBoundingClientRect().height : 0)
        + target.getBoundingClientRect().top - body.getBoundingClientRect().top + scrolled;
    };
    let chrome = measureChrome(), width = target.getBoundingClientRect().width;
    let height = Math.max(target.getBoundingClientRect().height, naturalBody?.initialHeight ?? 0) + chrome;
    update(height);
    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      const nextWidth = entry.borderBoxSize?.[0]?.inlineSize ?? entry.target.getBoundingClientRect().width;
      if (width !== nextWidth) { width = nextWidth; chrome = measureChrome(); }
      height = (entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height) + chrome;
      update(height);
    });
    observer.observe(target);
    const resize = () => update(height);
    window.addEventListener('resize', resize);
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); };
  }, [content, kind, side, expanded, viewKey, retainedViewHeight, naturalBody, chromeVersion]);
  return { frame, retainedHeight: kind === 'panel' ? retained.current : 0 };
}
