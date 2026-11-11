import { useEffect, useLayoutEffect, useRef, useState } from "react";

export const dockLoadingDelay = 200;

export function useDockOpening(key: string, pending: boolean, closing: boolean | undefined, cancel: () => void) {
  const opened = useRef(false);
  const [expired, setExpired] = useState<string>();
  const ready = opened.current || (!closing && (!pending || expired === key));
  useLayoutEffect(() => { if (ready) opened.current = true; }, [ready]);
  useEffect(() => {
    if (ready) return;
    if (closing) { cancel(); return; }
    const timer = setTimeout(() => setExpired(key), dockLoadingDelay);
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || opened.current) return;
      event.preventDefault();
      cancel();
    };
    window.addEventListener("keydown", escape);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", escape);
    };
  }, [key, ready, closing, cancel]);
  return ready;
}
