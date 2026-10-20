import {
  useCallback, useId, useImperativeHandle, useLayoutEffect, useRef, type Ref,
} from "react";
import { frame, cancelFrame } from "motion";
import { useMotionValueEvent, useReducedMotion, useSpring } from "motion/react";
import { springTransition } from "../motion/geometry";

type Point = { x: number; y: number };
export type WireState = "normal" | "connecting" | "error" | "inactive";
type WireEntry = { id: string; state: WireState };
type Painter = (viewport: DOMRect) => boolean;
export type ConnectionWiresHandle = {
  element: HTMLDivElement | null;
  follow: () => void;
};

// Offset a cubic by arc length, so the root flare has the same physical reach
// for short, long and steep connections. Widths are full widths, not radii.
function grownWire(
  start: Point,
  c1: Point,
  c2: Point,
  end: Point,
  scale: number,
  state: WireState,
) {
  const steps = Math.max(64, Math.ceil((
    Math.hypot(c1.x - start.x, c1.y - start.y) +
    Math.hypot(c2.x - c1.x, c2.y - c1.y) +
    Math.hypot(end.x - c2.x, end.y - c2.y)
  ) / Math.max(0.5, scale)));
  let length = 0;
  const samples = Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps, v = 1 - t;
    const x = v ** 3 * start.x + 3 * v * v * t * c1.x + 3 * v * t * t * c2.x + t ** 3 * end.x;
    const y = v ** 3 * start.y + 3 * v * v * t * c1.y + 3 * v * t * t * c2.y + t ** 3 * end.y;
    const dx = 3 * v * v * (c1.x - start.x) + 6 * v * t * (c2.x - c1.x) + 3 * t * t * (end.x - c2.x);
    const dy = 3 * v * v * (c1.y - start.y) + 6 * v * t * (c2.y - c1.y) + 3 * t * t * (end.y - c2.y);
    const speed = Math.hypot(dx, dy) || 1;
    return { x, y, nx: -dy / speed, ny: dx / speed, length: 0 };
  });
  samples.forEach((p, i) => {
    if (i) length += Math.hypot(p.x - samples[i - 1].x, p.y - samples[i - 1].y);
    p.length = length;
  });
  const edges = samples.map((p) => {
    const u = p.length / (length || 1), s = length - p.length;
    const body = state === "connecting" ? 0 : 3 + 3 * u ** 1.6;
    const halfWidth =
      (scale * (body + 12 * Math.max(0, 1 - s / (26 * scale)) ** 2)) / 2;
    return [
      `${p.x + p.nx * halfWidth} ${p.y + p.ny * halfWidth}`,
      `${p.x - p.nx * halfWidth} ${p.y - p.ny * halfWidth}`,
    ];
  });
  const gap = samples.filter((p) => Math.abs(p.length - length * 0.45) <= 7 * scale);
  return {
    outline: `M ${edges.map(([p]) => p).join(" L ")} L ${edges.reverse().map(([, p]) => p).join(" L ")} Z`,
    centerline: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`,
    gap: gap.length ? `M ${gap.map((p) => `${p.x} ${p.y}`).join(" L ")}` : "",
  };
}
function WireBranch({ entry, targetAngle, center, radius, scale, width, height, right, nodes, painters, follow }: {
  entry: WireEntry;
  targetAngle: number;
  center: Point;
  radius: number;
  scale: number;
  width: number;
  height: number;
  right: boolean;
  nodes: Map<string, HTMLButtonElement>;
  painters: Map<string, Painter>;
  follow: () => void;
}) {
  const gradientId = useId();
  const gradient = useRef<SVGLinearGradientElement>(null);
  const solidStop = useRef<SVGStopElement>(null);
  const fadeStop = useRef<SVGStopElement>(null);
  const outline = useRef<SVGPathElement>(null);
  const centerline = useRef<SVGPathElement>(null);
  const gap = useRef<SVGPathElement>(null);
  const angle = useSpring(targetAngle, springTransition(0.3, 0.9));
  const reduced = useReducedMotion();
  useMotionValueEvent(angle, "change", follow);
  useLayoutEffect(() => {
    if (reduced) angle.jump(targetAngle);
    else angle.set(targetAngle);
    follow();
  }, [angle, targetAngle, reduced, follow]);
  useLayoutEffect(() => {
    let previous = "";
    const paint: Painter = viewport => {
      const node = nodes.get(entry.id);
      if (!node || !viewport.width || !viewport.height) return false;
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      const start = {
        x: ((right ? rect.left : rect.right) - viewport.left) * width / viewport.width + (right ? -8 : 8),
        y: ((rect.top + rect.bottom) / 2 - viewport.top) * height / viewport.height,
      };
      const radians = (right ? angle.get() : 180 - angle.get()) * Math.PI / 180;
      const end = { x: center.x + radius * Math.cos(radians), y: center.y + radius * Math.sin(radians) };
      const signature = [start.x, start.y, end.x, end.y, scale, entry.state].join("|");
      if (signature === previous) return false;
      previous = signature;
      const c1 = { x: start.x + (right ? -100 : 100) * scale, y: start.y };
      const c2 = { x: end.x + (end.x - center.x) * 60 / 130, y: end.y + (end.y - center.y) * 60 / 130 };
      const shape = grownWire(start, c1, c2, end, scale, entry.state);
      outline.current?.setAttribute("d", shape.outline);
      centerline.current?.setAttribute("d", shape.centerline);
      gap.current?.setAttribute("d", shape.gap);
      const span = Math.max(1, Math.hypot(end.x - start.x, end.y - start.y));
      solidStop.current?.setAttribute("offset", String(Math.min(0.29, 10 * scale / span)));
      fadeStop.current?.setAttribute("offset", String(entry.state === "connecting" ? Math.min(1, 26 * scale / span) : 0.3));
      gradient.current?.setAttribute("x1", String(end.x));
      gradient.current?.setAttribute("y1", String(end.y));
      gradient.current?.setAttribute("x2", String(start.x));
      gradient.current?.setAttribute("y2", String(start.y));
      return true;
    };
    painters.set(entry.id, paint);
    follow();
    const resize = new ResizeObserver(follow);
    const node = nodes.get(entry.id);
    if (node) resize.observe(node);
    return () => {
      painters.delete(entry.id);
      resize.disconnect();
    };
  }, [entry.id, entry.state, nodes, painters, follow, center.x, center.y, radius, scale, width, height, right, angle]);
  return <g data-state={entry.state}>
    <defs>
      <linearGradient ref={gradient} id={gradientId} gradientUnits="userSpaceOnUse" data-state={entry.state}>
        <stop offset="0" stopOpacity="1" />
        <stop ref={solidStop} stopOpacity="1" />
        <stop ref={fadeStop} stopOpacity={entry.state === "connecting" ? 0 : 0.7} />
        <stop offset="1" stopOpacity={entry.state === "connecting" ? 0 : right ? 0.42 : 0.32} />
      </linearGradient>
    </defs>
    {entry.state === "connecting" && <path ref={centerline} className="connecting-wire" style={{ strokeWidth: 3 * scale }} />}
    <path ref={outline} className="grown-wire" style={{ fill: `url(#${gradientId})` }} />
    {entry.state === "error" && <path ref={gap} className="wire-break" style={{ strokeWidth: 18 * scale }} />}
  </g>;
}

export default function ConnectionWires({ ref, entries, nodes, right = false, width, height, brandSize, coreColumnWidth }: {
  ref?: Ref<ConnectionWiresHandle>;
  entries: WireEntry[];
  nodes: Map<string, HTMLButtonElement>;
  right?: boolean;
  width: number;
  height: number;
  brandSize: number;
  coreColumnWidth: number;
}) {
  const element = useRef<HTMLDivElement>(null);
  const painters = useRef(new Map<string, Painter>());
  const idleFrames = useRef(0);
  const mounted = useRef(false);
  // Read after Motion writes its transforms, then paint SVG before the browser
  // presents the frame. Stop once both node projection and root springs settle.
  const paint = useCallback(() => {
    const viewport = element.current?.getBoundingClientRect();
    let changed = false;
    if (viewport?.width && viewport.height) {
      painters.current.forEach(draw => { changed = draw(viewport) || changed; });
    }
    if (changed) idleFrames.current = 0;
    else if (++idleFrames.current >= 2) cancelFrame(paint);
  }, []);
  const follow = useCallback(() => {
    if (!mounted.current) return;
    idleFrames.current = 0;
    frame.postRender(paint, true);
  }, [paint]);
  useImperativeHandle(ref, () => ({ element: element.current, follow }), [follow]);
  useLayoutEffect(() => {
    mounted.current = true;
    follow();
    return () => {
      mounted.current = false;
      cancelFrame(paint);
    };
  }, [follow, paint, width, height, brandSize, coreColumnWidth]);
  const connected = entries.filter(entry => entry.state !== "inactive");
  const scale = brandSize / (92 * 2.6), radius = 130 * scale;
  const center = { x: right ? -coreColumnWidth / 2 : width + coreColumnWidth / 2, y: height / 2 };
  const halfAngle = Math.min(40, Math.max(26, (connected.length - 1) * 4 + 6));
  const spacing = connected.length > 1 ? Math.min(16, (halfAngle * 2 - 12) / (connected.length - 1)) : 0;
  const onArc = (offset: number) => {
    const angle = (right ? offset : 180 - offset) * Math.PI / 180;
    return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
  };
  const start = onArc(-halfAngle), end = onArc(halfAngle);
  return <div ref={element} className={`graph-wires earmuff-wires ${right ? "right" : "left"}`}>
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      {connected.map((entry, index) => <WireBranch key={entry.id} entry={entry}
        targetAngle={(index - (connected.length - 1) / 2) * spacing}
        center={center} radius={radius} scale={scale} width={width} height={height} right={right}
        nodes={nodes} painters={painters.current} follow={follow} />)}
      <path className="earmuff" style={{ strokeWidth: 14 * scale }}
        d={`M ${start.x} ${start.y} A ${radius} ${radius} 0 0 ${right ? 1 : 0} ${end.x} ${end.y}`} />
    </svg>
  </div>;
}
