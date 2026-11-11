import { environmentMedia } from "../state/appEnvironment";
import { animate, mix, type AnimationPlaybackControlsWithThen } from "motion";

export const surfaceDuration = 0.2;

export interface SurfaceRect { x: number; y: number; width: number; height: number }
export type Surface = Record<string, string | number>;
export const reducedMotion = () => environmentMedia("(prefers-reduced-motion: reduce)").matches;

// Morph the shell's real dimensions; its independently laid-out content is clipped,
// never scaled. A shared monotonic curve keeps every edge between its endpoints.
export function surfaceMotion(node: HTMLElement, naturalStyle: () => Surface = () => ({}), onFrame?: (rect: SurfaceRect) => void, observeResize = true, fitDockHeight?: () => boolean) {
  const base: Record<string, string> = {};
  const content = node.firstElementChild as HTMLElement | null;
  const contentTranslate = content?.style.translate ?? "";
  let controls: AnimationPlaybackControlsWithThen | undefined;
  let startFrame: number | undefined;
  let fitFrame = 0;
  let generation = 0;
  let goal: Surface = {};
  let rendered: Surface = {};
  let active = false;
  let retained = false;
  const fit = () => fitDockHeight?.() === true;
  const fitToContent = () => {
    if (content) node.style.setProperty("--dock-fit-height", `${content.getBoundingClientRect().height}px`);
  };
  if (fit()) fitToContent();
  let settledSize = node.getBoundingClientRect();
  const reduced = environmentMedia("(prefers-reduced-motion: reduce)");
  const save = (surface: Surface) => {
    for (const key of Object.keys(surface)) {
      if (!(key in base)) base[key] = (node.style as unknown as Record<string, string>)[key] ?? "";
    }
  };
  const restore = () => {
    Object.assign(node.style, base, naturalStyle());
    if (content) content.style.translate = contentTranslate;
  };
  const settle = () => {
    if (reduced.matches) {
      cancelAnimationFrame(startFrame ?? 0);
      startFrame = undefined;
      controls?.complete();
    }
  };
  reduced.addEventListener("change", settle);
  const sizeChanged = (a: DOMRect, b: DOMRect) =>
    Math.abs(a.width - b.width) > 0.5 || Math.abs(a.height - b.height) > 0.5;
  const resize = (from: DOMRect, to: DOMRect): AnimationPlaybackControlsWithThen => motion.to(
    { width: `${to.width}px`, height: `${to.height}px` },
    { from: { width: `${from.width}px`, height: `${from.height}px` }, duration: fit() ? 0.18 : surfaceDuration },
  );
  // The content lays out independently of the animated shell. Observe it so
  // asynchronous data and view changes resize the shell before the next paint.
  const updateSize = () => {
    const next = node.getBoundingClientRect();
    if ((observeResize || fit()) && !reduced.matches && sizeChanged(settledSize, next)) {
      void resize(settledSize, next);
    } else settledSize = next;
  };
  const observer = new ResizeObserver(() => {
    if (active || retained || !node.isConnected) return;
    if (!fit()) { updateSize(); return; }
    // Keep the painted dock at its current height until the next frame. Its
    // independently sized body can change without jumping the outer shell.
    if (!fitFrame) fitFrame = requestAnimationFrame(() => {
      fitFrame = 0;
      if (active || retained || !node.isConnected) return;
      if (fit()) fitToContent();
      updateSize();
    });
  });
  if (content && (observeResize || fitDockHeight)) observer.observe(content);
  const motion = {
    get running() { return active; },
    to(destination: Surface | (() => Surface), { from, retain = false, duration = surfaceDuration }: {
      from?: Surface; retain?: boolean; duration?: number;
    } = {}): AnimationPlaybackControlsWithThen {
      const id = ++generation;
      const follow = typeof destination === "function" ? destination : undefined;
      const target = typeof destination === "function" ? destination() : destination;
      retained = retain;
      save(target);
      goal = { ...goal, ...target };
      cancelAnimationFrame(startFrame ?? 0);
      controls?.stop();
      // Opening content belongs at its destination; dismissal keeps it where
      // it is. Only the shell moves, revealing/clipping this stationary layer.
      let contentRect = content?.getBoundingClientRect();
      if (content && !retain) {
        const shellStyle = node.style.cssText;
        const previousTranslate = content.style.translate;
        Object.assign(node.style, goal);
        content.style.translate = contentTranslate;
        contentRect = content.getBoundingClientRect();
        node.style.cssText = shellStyle;
        content.style.translate = previousTranslate;
      }
      const pinContent = () => {
        if (!content || !contentRect) return;
        content.style.translate = contentTranslate;
        const rect = content.getBoundingClientRect();
        content.style.translate = `${contentRect.x - rect.x}px ${contentRect.y - rect.y}px`;
      };
      if (from) {
        save(from);
        rendered = { ...rendered, ...from };
        Object.assign(node.style, from);
      }
      pinContent();
      const fromRect = node.getBoundingClientRect();
      const savedStyle = node.style.cssText;
      Object.assign(node.style, goal);
      const toRect = node.getBoundingClientRect();
      node.style.cssText = savedStyle;
      const interpolateRect = mix(
        { x: fromRect.x, y: fromRect.y, width: fromRect.width, height: fromRect.height },
        { x: toRect.x, y: toRect.y, width: toRect.width, height: toRect.height },
      );
      const computed = getComputedStyle(node);
      const start = Object.fromEntries(Object.keys(goal).map((key) => [
        key, rendered[key] ?? computed[key as keyof CSSStyleDeclaration],
      ])) as Surface;
      const interpolate = mix(start, goal);
      active = true;
      // One progress value writes the whole surface atomically. Mixing DOM
      // transforms (WAAPI) with layout sizes (JS) can put edges a frame apart.
      controls = animate(0, 1, {
        type: "tween",
        autoplay: reduced.matches,
        duration: reduced.matches ? 0 : duration,
        ease: [0.2, 0.8, 0.3, 1],
        onUpdate: (progress) => {
          // A dismissing dock follows its live node while the scene rebounds.
          // Opening and resizing keep a fixed destination from the solver.
          if (follow) goal = { ...goal, ...follow() };
          rendered = { ...(follow ? mix(start, goal)(progress) : interpolate(progress)) };
          Object.assign(node.style, rendered);
          pinContent();
          onFrame?.(follow || (fit() && !goal.transform) ? node.getBoundingClientRect() : interpolateRect(progress));
        },
      });
      if (!reduced.matches) {
        // Keep the origin intact through preparation. Start the clock at the
        // next paint, after React layout and the visual copy are ready.
        const animation = controls;
        startFrame = requestAnimationFrame(() => {
          startFrame = undefined;
          animation.play();
        });
      }
      void controls.then(() => {
        if (id !== generation) return;
        active = false;
        if (!retain) {
          const end = node.getBoundingClientRect();
          restore();
          if (fit()) fitToContent();
          rendered = {};
          goal = {};
          const natural = node.getBoundingClientRect();
          // Content may have changed during opening. Continue from the visible
          // size instead of snapping when explicit dimensions are released.
          if ((observeResize || fit()) && !reduced.matches && sizeChanged(end, natural)) {
            void resize(end, natural);
          } else { settledSize = natural; onFrame?.(natural); }
        }
      });
      return controls;
    },
    dispose() {
      ++generation;
      observer.disconnect();
      cancelAnimationFrame(fitFrame);
      active = false;
      cancelAnimationFrame(startFrame ?? 0);
      controls?.stop();
      restore();
      if (fitDockHeight) node.style.removeProperty("--dock-fit-height");
      reduced.removeEventListener("change", settle);
    },
  };
  return motion;
}
