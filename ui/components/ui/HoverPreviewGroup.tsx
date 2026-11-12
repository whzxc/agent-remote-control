import { TransientLayer } from "./TransientLayer";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Popover } from "radix-ui";
import { AnimatedSize } from "./AnimatedSize";
import { HoverScope } from "./HoverScope";
import "./HoverPreviewGroup.css";

// One preview remains mounted while moving through a group. Radix owns
// positioning and dismissal; HoverScope owns the shared moving highlight.
export function HoverPreviewGroup({ children, preview, className = "" }: {
  children: ReactNode;
  preview: (key: string) => ReactNode;
  className?: string;
}) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const content = useRef<HTMLDivElement>(null);
  const id = useId();
  const anchor = useMemo(() => ({ current: target }), [target]);
  const cancel = () => { clearTimeout(timer.current); timer.current = undefined; };
  const close = () => { cancel(); setOpen(false); setMoving(false); };
  const leave = () => { cancel(); timer.current = setTimeout(() => { setOpen(false); setMoving(false); }, 120); };
  const show = (node: EventTarget | null, scope: HTMLElement) => {
    const next = node instanceof Element ? node.closest<HTMLElement>("[data-hover-target]") : null;
    if (!next || !scope.contains(next) || next.matches(":disabled, [aria-disabled='true']")) return;
    cancel();
    setMoving(open);
    setTarget(next);
    if (!open) timer.current = setTimeout(() => setOpen(true), 250);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open || !target) return;
    const previous = target.getAttribute("aria-describedby");
    target.setAttribute("aria-describedby", [previous, id].filter(Boolean).join(" "));
    return () => { if (previous) target.setAttribute("aria-describedby", previous); else target.removeAttribute("aria-describedby"); };
  }, [open, target, id]);
  useEffect(() => {
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && content.current?.contains(event.target)) return;
      clearTimeout(timer.current); setOpen(false); setMoving(false);
    };
    window.addEventListener("scroll", dismiss, true);
    return () => window.removeEventListener("scroll", dismiss, true);
  }, []);
  return <Popover.Root open={open} onOpenChange={value => { if (!value) close(); }}>
    <HoverScope className={className}
      onPointerOver={event => { if (event.pointerType !== "touch") show(event.target, event.currentTarget); }}
      onPointerLeave={event => { if (!(event.relatedTarget instanceof Node) || !content.current?.contains(event.relatedTarget)) leave(); }}
      onFocusCapture={event => show(event.target, event.currentTarget)}
      onBlurCapture={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) leave(); }}
      onPointerDownCapture={close}>
      {children}
    </HoverScope>
    <Popover.Anchor virtualRef={anchor} />
    <Popover.Portal><TransientLayer><Popover.Content ref={content} id={id} role="tooltip" data-moving={moving || undefined} className="tooltip hover-preview" side="bottom" align="center" sideOffset={6} collisionPadding={10}
      onFocusOutside={event => {
        const node = event.detail.originalEvent.target;
        if (node instanceof Element && node.closest(".hover-scope") === target?.closest(".hover-scope")) event.preventDefault();
      }}
      onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}
      onPointerEnter={cancel} onPointerLeave={leave}>
      <AnimatedSize>{target && preview(target.dataset.hoverTarget ?? "")}</AnimatedSize>
    </Popover.Content></TransientLayer></Popover.Portal>
  </Popover.Root>;
}
