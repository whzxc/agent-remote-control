import { animate, mix, type AnimationPlaybackControlsWithThen } from "motion";

export const surfaceDuration = 0.2;

export type Surface = Record<string, string | number>;
export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// Morph the shell's real dimensions; its independently laid-out content is clipped,
// never scaled. A shared monotonic curve keeps every edge between its endpoints.
export function surfaceMotion(node: HTMLElement, naturalStyle: () => Surface = () => ({})) {
  const base: Record<string, string> = {};
  const content = node.firstElementChild as HTMLElement | null;
  const contentTranslate = content?.style.translate ?? "";
  let controls: AnimationPlaybackControlsWithThen | undefined;
  let startFrame: number | undefined;
  let generation = 0;
  let goal: Surface = {};
  let rendered: Surface = {};
  let active = false;
  let retained = false;
  let settledSize = node.getBoundingClientRect();
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
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
    { from: { width: `${from.width}px`, height: `${from.height}px` } },
  );
  // The content lays out independently of the animated shell. Observe it so
  // asynchronous data and view changes resize the shell before the next paint.
  const observer = new ResizeObserver(() => {
    if (active || retained || !node.isConnected) return;
    const next = node.getBoundingClientRect();
    if (!reduced.matches && sizeChanged(settledSize, next)) {
      void resize(settledSize, next);
    } else settledSize = next;
  });
  if (content) observer.observe(content);
  const motion = {
    get running() { return active; },
    to(target: Surface, { from, retain = false }: {
      from?: Surface; retain?: boolean;
    } = {}): AnimationPlaybackControlsWithThen {
      const id = ++generation;
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
        duration: reduced.matches ? 0 : surfaceDuration,
        ease: [0.2, 0.8, 0.3, 1],
        onUpdate: (progress) => {
          rendered = { ...interpolate(progress) };
          Object.assign(node.style, rendered);
          pinContent();
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
          rendered = {};
          goal = {};
          const natural = node.getBoundingClientRect();
          // Content may have changed during opening. Continue from the visible
          // size instead of snapping when explicit dimensions are released.
          if (!reduced.matches && sizeChanged(end, natural)) {
            void resize(end, natural);
          } else settledSize = natural;
        }
      });
      return controls;
    },
    dispose() {
      ++generation;
      observer.disconnect();
      active = false;
      cancelAnimationFrame(startFrame ?? 0);
      controls?.stop();
      restore();
      reduced.removeEventListener("change", settle);
    },
  };
  return motion;
}
