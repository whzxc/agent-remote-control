import { environmentMedia, useAppNow } from "./appEnvironment";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
export function useInterval(
  callback: () => void,
  delay: number | null,
  immediate = false,
) {
  const latest = useRef(callback);
  useLayoutEffect(() => {
    latest.current = callback;
  });
  useEffect(() => {
    if (delay === null) return;
    if (immediate) latest.current();
    const timer = setInterval(() => latest.current(), delay);
    return () => clearInterval(timer);
  }, [delay, immediate]);
}
export function useNow() { return useAppNow(60000); }
export function useMedia(query: string) {
  const [matches, setMatches] = useState(() => environmentMedia(query).matches);
  useEffect(() => {
    const media = environmentMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}
