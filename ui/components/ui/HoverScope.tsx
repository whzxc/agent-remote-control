import { environmentMedia } from "../../state/appEnvironment";
import { useLayoutEffect, useRef, useState, type HTMLAttributes } from "react";
import { motion, useMotionValue, animate } from "motion/react";
import { motionTransition } from "../../motion/tokens";

// Controlled owners retain bubble sources; Radix owns highlighted menu items.
// Ordinary groups derive a temporary target from pointer and keyboard focus.
export function HoverScope({ activeKey, tracking = "pointer", className = "", children, ...props }:
  HTMLAttributes<HTMLDivElement> & { activeKey?: string; tracking?: "pointer" | "highlighted" }) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [pointed, setPointed] = useState("");
  useLayoutEffect(() => {
    if (activeKey !== undefined) setPointed("");
  }, [activeKey]);
  const targetKey = (target: EventTarget | null) => {
    const node = target instanceof Element ? target.closest<HTMLElement>("[data-hover-target]") : null;
    return node?.closest(".hover-scope") === root &&
      !node?.matches(":disabled, [aria-disabled='true'], [data-disabled]") ? node?.dataset.hoverTarget || "" : "";
  };
  return (
    <div {...props} ref={setRoot} className={`hover-scope ${className}`}
      onPointerOver={(e) => { props.onPointerOver?.(e); if (activeKey === undefined && tracking === "pointer" && e.pointerType !== "touch") setPointed(targetKey(e.target)); }}
      onPointerLeave={(e) => { props.onPointerLeave?.(e); if (activeKey === undefined && tracking === "pointer") setPointed(""); }}
      onFocusCapture={(e) => { props.onFocusCapture?.(e); if (activeKey === undefined && tracking === "pointer") setPointed(targetKey(e.target)); }}
      onBlurCapture={(e) => { props.onBlurCapture?.(e); if (activeKey === undefined && tracking === "pointer") setPointed(targetKey(e.relatedTarget)); }}
    >
      {root && <Highlight root={root} activeKey={activeKey ?? pointed} tracking={tracking} />}
      {children}
    </div>
  );
}

function Highlight({ root, activeKey, tracking }: {
  root: HTMLDivElement;
  activeKey: string;
  tracking: "pointer" | "highlighted";
}) {
  const transition = motionTransition("fast");
  const x = useMotionValue(0), y = useMotionValue(0);
  const width = useMotionValue(0), height = useMotionValue(0);
  const radius = useMotionValue(0);
  const [visible, setVisible] = useState(false);
  const present = useRef(false);
  useLayoutEffect(() => {
    const scope = root;
    const reduced = environmentMedia("(prefers-reduced-motion: reduce)");
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    const hide = () => {
      if (hideTimer) return;
      hideTimer = setTimeout(() => {
        present.current = false;
        setVisible(false);
      }, 80);
    };
    const measure = () => {
      const target = [...scope.querySelectorAll<HTMLElement>("[data-hover-target]")]
        .find((node) => (tracking === "highlighted" ? node.hasAttribute("data-highlighted") : node.dataset.hoverTarget === activeKey) &&
          node.closest(".hover-scope") === scope && !node.matches(":disabled, [aria-disabled='true'], [data-disabled]"));
      if (!target || !target.getClientRects().length) { hide(); return; }
      const box = target.getBoundingClientRect(), parent = scope.getBoundingClientRect();
      if (!box.width || !box.height || !parent.width || !parent.height) { hide(); return; }
      // Undo ancestor scaling; the local layer follows ancestor transforms naturally.
      const sx = parent.width / scope.offsetWidth, sy = parent.height / scope.offsetHeight;
      const corner = getComputedStyle(target).borderTopLeftRadius;
      const r = corner.endsWith("%") ? parseFloat(corner) * Math.min(box.width / sx, box.height / sy) / 100 : parseFloat(corner);
      const next = [
        (box.left - parent.left) / sx + scope.scrollLeft - scope.clientLeft,
        (box.top - parent.top) / sy + scope.scrollTop - scope.clientTop,
        box.width / sx, box.height / sy, r || 0,
      ];
      clearTimeout(hideTimer);
      hideTimer = undefined;
      [x, y, width, height, radius].forEach((value, i) => {
        if (present.current && !reduced.matches) animate(value, next[i], transition);
        else value.jump(next[i]);
      });
      present.current = true;
      setVisible(true);
    };
    const resize = new ResizeObserver(measure);
    const observe = () => {
      resize.disconnect();
      resize.observe(scope);
      scope.querySelectorAll<HTMLElement>("[data-hover-target]").forEach((node) => resize.observe(node));
      measure();
    };
    const changes = new MutationObserver(observe);
    changes.observe(scope, { childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ["data-hover-target", "data-highlighted", "data-disabled", "disabled", "aria-disabled"] });
    observe();
    reduced.addEventListener("change", measure);
    window.addEventListener("resize", measure);
    scope.addEventListener("scroll", measure, true);
    return () => {
      clearTimeout(hideTimer);
      resize.disconnect();
      changes.disconnect();
      reduced.removeEventListener("change", measure);
      window.removeEventListener("resize", measure);
      scope.removeEventListener("scroll", measure, true);
    };
  }, [activeKey, tracking, root, x, y, width, height, radius]);
  return <motion.span aria-hidden="true" className="hover-highlight" style={{
    x, y, width, height,
    borderRadius: radius, opacity: visible ? 1 : 0,
  }} />;
}
