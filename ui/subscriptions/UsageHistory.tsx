import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from "react";
import { Popover } from "radix-ui";
import { useGeometrySpring } from "../motion/geometry";
export type BubbleControls = {
  register: (key: string, node: HTMLElement | null) => void;
  hover: (key: string) => void;
  focus: (key: string) => void;
  highlighted: string;
  expanded: boolean;
  displayed: string;
};
export default function UsageHistory({
  children,
  detail,
  side = "left",
}: {
  children: (controls: BubbleControls) => ReactNode;
  detail: (key: string) => ReactNode;
  side?: "left" | "right" | "bottom";
}) {
  const [pointed, setPointed] = useState("");
  const [expanded, setExpanded] = useState(false),
    [displayed, setDisplayed] = useState("");
  const triggers = useRef(new Map<string, HTMLElement>()),
    content = useRef<HTMLDivElement>(null),
    card = useRef<HTMLDivElement>(null);
  const [contentNode, setContentNode] = useState<HTMLDivElement | null>(null);
  const attachContent = useCallback((node: HTMLDivElement | null) => {
    content.current = node;
    setContentNode(node);
  }, []);
  const measuredContent = useRef<HTMLDivElement | null>(null);
  const live = useRef({ expanded, displayed });
  live.current = { expanded, displayed };
  const hoverTarget = useRef(""),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const motion = useGeometrySpring([0, 0, 80, 0], 0.34, 0.82);
  const refs = useRef({ motion });
  refs.current = { motion };
  const register = (key: string, node: HTMLElement | null) => {
    if (node) triggers.current.set(key, node);
    else triggers.current.delete(key);
  };
  const compact = (key: string) => key.startsWith("product:") || key === "productRemaining";
  const geometry = (key: string) => {
    const trigger = triggers.current.get(key);
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    return [
      rect.left,
      compact(key) ? rect.top : rect.top + rect.height / 2,
      Math.min(
        content.current?.scrollHeight || 80,
        Math.min(360, innerHeight * 0.6),
      ),
      rect.width,
    ];
  };
  function schedule(key: string) {
    if (hoverTarget.current === key) return;
    hoverTarget.current = key;
    setPointed(key);
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => {
        if (!key) {
          setExpanded(false);
          return;
        }
        const next = geometry(key);
        if (!next) return;
        if (!live.current.expanded) refs.current.motion.jump(next);
        else refs.current.motion.to(next);
        setDisplayed(key);
        setExpanded(true);
      },
      key ? (live.current.expanded ? 0 : 120) : 180,
    );
  }
  const dismiss = () => {
    clearTimeout(timer.current);
    hoverTarget.current = "";
    setPointed("");
    setExpanded(false);
  };
  useLayoutEffect(() => {
    if (!expanded || !contentNode) return;
    const retarget = () => {
      const next = geometry(displayed);
      if (next) motion.to(next);
    };
    const initial = geometry(displayed);
    if (initial && measuredContent.current !== contentNode)
      motion.jump(initial);
    else retarget();
    measuredContent.current = contentNode;
    const observer = new ResizeObserver(retarget);
    observer.observe(contentNode);
    window.addEventListener("resize", retarget);
    window.addEventListener("scroll", retarget, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", retarget);
      window.removeEventListener("scroll", retarget, true);
    };
  }, [expanded, displayed, contentNode]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const anchor = useRef({ getBoundingClientRect: () => new DOMRect() });
  anchor.current.getBoundingClientRect = () =>
    new DOMRect(motion.value[0], motion.value[1], motion.value[3], 0);
  return (
    <>
      {children({
        register,
        highlighted: pointed || (expanded ? displayed : ""),
        hover: (key) => {
          schedule(key);
        },
        focus: schedule,
        expanded,
        displayed,
      })}
      <Popover.Root
        open={expanded}
        onOpenChange={(next) => {
          if (!next) dismiss();
        }}
      >
        <Popover.Anchor virtualRef={anchor} />
        <Popover.Portal>
          <Popover.Content
            ref={card}
            className={`history-popover ${compact(displayed) ? "product-popover" : ""}`}
            side={compact(displayed) ? "top" : side}
            align="center"
            sideOffset={compact(displayed) ? 8 : 28}
            collisionPadding={12}
            updatePositionStrategy="always"
            style={
              {
                height: compact(displayed) ? "auto" : motion.value[2]! + 36,
                "--tail-span": `${Math.max(12, Math.min(80, motion.value[2]! - 4))}px`,
              } as CSSProperties
            }
            onInteractOutside={(e) => {
              const target = e.target;
              if (target instanceof Node && [...triggers.current.values()].some(node => node.contains(target))) e.preventDefault();
            }}
            onOpenAutoFocus={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => e.preventDefault()}
            onEscapeKeyDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              triggers.current.get(displayed)?.focus({ preventScroll: true });
              dismiss();
            }}
            onMouseEnter={() => { schedule(displayed); }}
            onMouseLeave={() => { schedule(""); }}
          >
            <div className="history-scroll">
              <div
                ref={attachContent}
                className="history-detail"
              >
                {detail(displayed)}
              </div>
            </div>
            <svg
              className="usage-detail-tail"
              viewBox="0 0 20 80"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <path d="M20 0 C20 28.8 8.4 31.2 0 40 C8.4 48.8 20 51.2 20 80 Z" />
              <path className="usage-detail-tail-outline" d="M20 0 C20 28.8 8.4 31.2 0 40 C8.4 48.8 20 51.2 20 80" vectorEffect="non-scaling-stroke" />
            </svg>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </>
  );
}
