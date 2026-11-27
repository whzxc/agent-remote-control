import { QuotaPopover, QuotaDetail } from './QuotaDetail';
import { TransientLayer } from "../components/ui/TransientLayer";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PopoverPrimitive } from "../components/kit/popover";
import { useGeometryTransition } from "../motion/geometry";

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
}: {
  children: (controls: BubbleControls) => ReactNode;
  detail: (key: string) => ReactNode;
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
  const motion = useGeometryTransition([0, 0, 80, 0]);
  const refs = useRef({ motion });
  refs.current = { motion };
  const register = (key: string, node: HTMLElement | null) => {
    if (node) triggers.current.set(key, node);
    else triggers.current.delete(key);
  };
  const geometry = (key: string) => {
    const trigger = triggers.current.get(key);
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    return [
      rect.left,
      rect.top,
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
  const isReading = (target: Node) => [...triggers.current.values()].some(node => node.contains(target));
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
  const anchorX = motion.value[0] ?? 0;
  const anchorY = motion.value[1] ?? 0;
  const anchorWidth = motion.value[3] ?? 0;
  const virtualAnchor = useMemo(
    () => ({
      getBoundingClientRect: () => new DOMRect(anchorX, anchorY, anchorWidth, 0),
    }),
    [anchorX, anchorY, anchorWidth],
  );

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
      <PopoverPrimitive.Root
        modal={false}
        open={expanded}
        onOpenChange={(next, details) => {
          if (!next) {
            if (
              details.reason === "outside-press" &&
              details.event.target instanceof Node &&
              isReading(details.event.target)
            ) {
              details.cancel();
              return;
            }
            if (details.reason === "escape-key") {
              details.event.stopPropagation();
              triggers.current.get(displayed)?.focus({ preventScroll: true });
            }
            dismiss();
          }
        }}
      >
        <PopoverPrimitive.Portal>
          <TransientLayer onDismiss={dismiss} isAnchor={isReading}>
            <PopoverPrimitive.Positioner
              anchor={virtualAnchor}
              side="top"
              align="center"
              sideOffset={8}
              collisionPadding={12}
              positionMethod="fixed"
              className="z-60"
            >
              <QuotaPopover
                ref={card}
                initialFocus={false}
                finalFocus={false}
                style={{ height: motion.value[2]! + 16 }}
                onMouseEnter={() => { schedule(displayed); }}
                onMouseLeave={() => { schedule(""); }}
              >
                <div className="history-scroll">
                  <QuotaDetail
                    ref={attachContent}
                    className="history-detail"
                  >
                    {detail(displayed)}
                  </QuotaDetail>
                </div>
              </QuotaPopover>
            </PopoverPrimitive.Positioner>
          </TransientLayer>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
    </>
  );
}
