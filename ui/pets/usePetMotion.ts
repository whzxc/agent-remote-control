import { useEffect, useState } from 'react';
import { isDesktop } from '../platform';
import { useMedia } from '../state/hooks';
export function usePetMotion() {
  const reduced = useMedia('(prefers-reduced-motion: reduce)');
  const [visible, setVisible] = useState(document.visibilityState === 'visible');
  useEffect(() => {
    let disposed = false, stop: (() => void) | undefined;
    async function update() {
      const windowVisible = document.visibilityState === 'visible';
      if (!windowVisible || !isDesktop) { if (!disposed) setVisible(windowVisible); return; }
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      const shown = await win.isVisible(), minimized = await win.isMinimized();
      if (!disposed) setVisible(shown && !minimized && document.visibilityState === 'visible');
    }
    const change = () => { void update().catch(() => { if (!disposed) setVisible(false); }); };
    document.addEventListener('visibilitychange', change);
    if (isDesktop) void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const unlisten = await getCurrentWindow().onResized(change); if (disposed) unlisten(); else stop = unlisten;
    });
    change();
    return () => { disposed = true; stop?.(); document.removeEventListener('visibilitychange', change); };
  }, []);
  return { visible, reduced, animate: visible && !reduced };
}
