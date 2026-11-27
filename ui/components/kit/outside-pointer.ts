let activeCleanup: (() => void) | null = null;
let consumedActive = false;

/** Returns true while an outside-press dismissal gesture is actively being consumed. */
export function isOutsidePointerConsumed(): boolean {
  return consumedActive;
}

/**
 * Consumes the remainder of a pointer gesture (mousedown, pointerup, mouseup, click)
 * that dismissed a transient layer via outside-press so the same gesture never
 * activates an underlying control or closes the owning shell, even across long presses.
 */
export function consumeOutsidePointerGesture(originEvent?: Event): void {
  if (typeof window === "undefined") return;
  activeCleanup?.();

  let released = false;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  consumedActive = true;

  const stop = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
  };

  const cleanup = () => {
    if (releaseTimer !== undefined) {
      clearTimeout(releaseTimer);
      releaseTimer = undefined;
    }
    consumedActive = false;
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("mousedown", onMouseDown, true);
    window.removeEventListener("pointerup", onRelease, true);
    window.removeEventListener("mouseup", onRelease, true);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("pointercancel", cleanup, true);
    window.removeEventListener("blur", cleanup);
    if (activeCleanup === cleanup) activeCleanup = null;
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event === originEvent) return;
    cleanup();
  };

  const onMouseDown = (event: MouseEvent) => {
    if (event === originEvent) return;
    if (released) {
      cleanup();
      return;
    }
    stop(event);
  };

  const onRelease = (event: Event) => {
    stop(event);
    released = true;
    if (releaseTimer !== undefined) clearTimeout(releaseTimer);
    releaseTimer = setTimeout(cleanup, 100);
  };

  const onClick = (event: MouseEvent) => {
    stop(event);
    cleanup();
  };

  activeCleanup = cleanup;
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("mousedown", onMouseDown, true);
  window.addEventListener("pointerup", onRelease, true);
  window.addEventListener("mouseup", onRelease, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("pointercancel", cleanup, true);
  window.addEventListener("blur", cleanup);

  if (originEvent?.type === "click") {
    cleanup();
  }
}
