import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ContextMenu } from "radix-ui";
import m from "../../shared/usage-panel.json";
import { t } from "../i18n";
import { useWindowSize } from "../state/hooks";
import { subscriptions } from "../state/subscriptions";
import { navigation } from "../state/navigation";
import {
  panelPreferences,
  readPanelPreferences,
  savePanelPreferences,
} from "./preferences";
import { clamp, type Point } from "./geometry";
import type { Dock, PanelGeometry, PanelLayout, PanelState } from "./layout";
import UsageRail from "./UsageRail";
import { Notice } from "../components/ui";
function hit(points: Point[], x: number, y: number) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!,
      b = points[j]!;
    if (
      a[1] > y !== b[1] > y &&
      x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}
export default function BrowserRailPreview() {
  const prefs = panelPreferences.use(),
    { snapshot } = subscriptions.use(),
    { width, height } = useWindowSize();
  const count = snapshot?.settings.enabled
    ? snapshot.providers.filter((p) => p.eligible && p.selected).length
    : 0;
  const [position, setPosition] = useState(() => {
      try {
        return (
          JSON.parse(
            localStorage.getItem("arc-dev-usage-rail-position") || "null",
          ) || { x: innerWidth - 96, y: 96 }
        );
      } catch {
        return { x: innerWidth - 96, y: 96 };
      }
    }),
    [dock, setDock] = useState<Dock>("floating"),
    [expanded, setExpanded] = useState(true),
    [providerId, setProviderId] = useState<string | null>(null),
    [pressed, setPressed] = useState(false),
    [menu, setMenu] = useState(false),
    [menuError, setMenuError] = useState("");
  const surface = useRef<HTMLDivElement>(null),
    geometry = useRef<PanelGeometry | undefined>(undefined),
    leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    drag = useRef<
      | {
          id: number;
          startX: number;
          startY: number;
          grabX: number;
          grabY: number;
          moved: boolean;
        }
      | undefined
    >(undefined),
    suppressClick = useRef(false);
  const acceptGeometry = useCallback((value: PanelGeometry) => {
    geometry.current = value;
  }, []);
  const layout = useMemo<PanelLayout>(() => {
    const scale =
        prefs.size === "small"
          ? m.smallScale
          : prefs.size === "large"
            ? m.largeScale
            : 1,
      horizontal = dock === "top" || dock === "bottom",
      floating = dock === "floating",
      percentages = !horizontal || prefs.horizontalPercentages,
      item = (horizontal ? (percentages ? 38 : 36) : m.groupHeight) * scale;
    let padding = 54 * scale - (floating ? 32 * scale : 0),
      gap =
        m.groupGap *
        (prefs.spacing === "compact"
          ? 0.6
          : prefs.spacing === "roomy"
            ? 1.4
            : 1) *
        scale;
    const n = Math.max(1, count),
      available = Math.max(1, horizontal ? width : height);
    if (2 * padding + item * n + gap * (n - 1) > available) {
      if (n > 1)
        gap = Math.min(
          gap,
          Math.max(0, (available - 2 * padding - item * n) / (n - 1)),
        );
      padding = Math.min(
        padding,
        Math.max(
          (floating ? 12 : 36) * scale,
          (available - item * n - gap * (n - 1)) / 2,
        ),
      );
    }
    const footer =
        2 * padding + item * n + gap * (n - 1) > available ? 24 * scale : 0,
      visibleCount = footer
        ? Math.max(
            1,
            Math.floor((available - 2 * padding - footer) / (item + gap)),
          )
        : n,
      length =
        2 * padding + item * visibleCount + gap * (visibleCount - 1) + footer,
      thickness = (horizontal && percentages ? 78 : m.railWidth) * scale,
      railWidth = horizontal ? length : thickness,
      railHeight = horizontal ? thickness : length,
      maxX = Math.max(0, width - railWidth),
      maxY = Math.max(0, height - railHeight),
      x =
        dock === "left"
          ? 0
          : dock === "right"
            ? maxX
            : clamp(position.x, 0, maxX),
      y =
        dock === "top"
          ? 0
          : dock === "bottom"
            ? maxY
            : clamp(position.y, 0, maxY);
    return {
      width,
      height,
      rail: { x, y, width: railWidth, height: railHeight },
      edge: floating
        ? x + railWidth / 2 > width / 2
          ? "right"
          : "left"
        : (dock as Exclude<Dock, "floating">),
      metrics: {
        visibleCount,
        footer,
        scale,
        length,
        thickness,
        padding,
        pitch: item + gap,
        item,
        percentages,
        round: true,
        horizontal,
      },
    };
  }, [prefs, count, dock, width, height, position]);
  const state = useMemo<PanelState>(
    () => ({
      expanded: dock === "floating" || pressed || expanded,
      slot: null,
      providerId,
      generation: 1,
      display: "browser",
      dock,
      pressed,
      layout: count ? layout : null,
      preferences: prefs,
    }),
    [dock, pressed, expanded, providerId, layout, prefs, count],
  );
  useEffect(() => {
    const read = () => void readPanelPreferences().catch(() => {});
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, []);
  function cancelLeave() {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = undefined;
  }
  function leave() {
    if (drag.current || leaveTimer.current || menu) return;
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = undefined;
      if (drag.current) return;
      setProviderId(null);
      setExpanded(false);
    }, m.leaveMs);
  }
  function hover(event: { clientX: number; clientY: number }) {
    const g = geometry.current;
    if (!g || drag.current || menu) return;
    const x = event.clientX,
      y = event.clientY,
      ring = g.rings.find((r) => Math.hypot(x - r.x, y - r.y) <= r.radius),
      { rail, metrics } = layout,
      wakeLength = (m.collapsedLength * metrics.scale) / 2,
      wakeWidth = m.wakeWidth * metrics.scale,
      near =
        dock === "left"
          ? x <= wakeWidth
          : dock === "right"
            ? x >= width - wakeWidth
            : dock === "top"
              ? y <= wakeWidth
              : dock === "bottom"
                ? y >= height - wakeWidth
                : false,
      wake =
        near &&
        (metrics.horizontal
          ? Math.abs(x - rail.x - rail.width / 2) <= wakeLength
          : Math.abs(y - rail.y - rail.height / 2) <= wakeLength);
    if (
      ring ||
      wake ||
      hit(g.rail, x, y) ||
      hit(g.detail, x, y) ||
      hit(g.corridor, x, y)
    ) {
      cancelLeave();
      setExpanded(true);
      if (ring) setProviderId(ring.providerId);
    } else leave();
  }
  function release() {
    const current = drag.current;
    if (!current) return;
    suppressClick.current = current.moved;
    try {
      localStorage.setItem(
        "arc-dev-usage-rail-position",
        JSON.stringify({ x: layout.rail.x, y: layout.rail.y }),
      );
    } catch {
      /* Session position still works. */
    }
    drag.current = undefined;
    setPressed(false);
    if (surface.current?.hasPointerCapture(current.id))
      surface.current.releasePointerCapture(current.id);
  }
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const current = drag.current;
      if (!current || event.pointerId !== current.id) {
        hover(event);
        return;
      }
      if (
        !current.moved &&
        Math.hypot(
          event.clientX - current.startX,
          event.clientY - current.startY,
        ) < m.dragThreshold
      )
        return;
      if (!current.moved) surface.current?.setPointerCapture(event.pointerId);
      current.moved = true;
      setPressed(true);
      setProviderId(null);
      const nearest = (
        [
          { edge: "left", distance: event.clientX },
          { edge: "right", distance: width - event.clientX },
          { edge: "top", distance: event.clientY },
          { edge: "bottom", distance: height - event.clientY },
        ] as { edge: Exclude<Dock, "floating">; distance: number }[]
      ).sort((a, b) => a.distance - b.distance)[0]!;
      setDock(
        nearest.distance <
          (dock === nearest.edge ? m.undockDistance : m.dockDistance)
          ? nearest.edge
          : "floating",
      );
      setPosition({
        x: clamp(
          event.clientX - current.grabX * layout.rail.width,
          0,
          Math.max(0, width - layout.rail.width),
        ),
        y: clamp(
          event.clientY - current.grabY * layout.rail.height,
          0,
          Math.max(0, height - layout.rail.height),
        ),
      });
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId === drag.current?.id) release();
    };
    const blur = () => {
      release();
      cancelLeave();
      setProviderId(null);
      setExpanded(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("blur", blur);
    document.addEventListener("pointerleave", leave);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("blur", blur);
      document.removeEventListener("pointerleave", leave);
    };
  }, [layout, menu, width, height, dock]);
  useEffect(() => () => clearTimeout(leaveTimer.current), []);
  async function selectMenu(key: string) {
    setMenuError("");
    try {
      if (key === "settings")
        navigation.set((old) => ({ ...old, agentSettings: true }));
      else if (key === "reset") {
        await savePanelPreferences({ resetDefaults: true });
        setDock("right");
        setPosition({ x: width, y: height / 2 - layout.rail.height / 2 });
        setProviderId(null);
      } else if (key === "hide") await savePanelPreferences({ visible: false });
    } catch (e) {
      setMenuError(String(e));
    }
  }
  if (prefs.visible === false || !count) return null;
  return (
    <ContextMenu.Root
      onOpenChange={(open) => {
        setMenu(open);
        cancelLeave();
      }}
    >
      <ContextMenu.Trigger asChild>
        <div
          ref={surface}
          className="browser-rail-preview"
          onPointerDown={(event) => {
            const g = geometry.current;
            if (
              event.button !== 0 ||
              !event.isPrimary ||
              !g ||
              !hit(g.rail, event.clientX, event.clientY) ||
              hit(g.controls, event.clientX, event.clientY)
            )
              return;
            cancelLeave();
            suppressClick.current = false;
            setExpanded(true);
            drag.current = {
              id: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              grabX: (event.clientX - layout.rail.x) / layout.rail.width,
              grabY: (event.clientY - layout.rail.y) / layout.rail.height,
              moved: false,
            };
          }}
          onLostPointerCapture={release}
          onClickCapture={(event) => {
            if (suppressClick.current) {
              event.preventDefault();
              event.stopPropagation();
              suppressClick.current = false;
            }
          }}
          onFocusCapture={(event) => {
            const id = (event.target as HTMLElement).dataset.providerId;
            if (id) {
              cancelLeave();
              setExpanded(true);
              setProviderId(id);
            }
          }}
          onBlur={leave}
          onKeyDown={(e) => {
            if (e.key === "Escape") setProviderId(null);
          }}
        >
          {menuError && (
            <div className="rail-menu-error">
              <Notice>{menuError}</Notice>
            </div>
          )}
          <UsageRail
            state={state}
            onGeometry={acceptGeometry}
            onOpen={(id) => {
              if (!suppressClick.current)
                navigation.set((old) => ({ ...old, providerId: id }));
            }}
          />
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu" collisionPadding={12}>
          {[
            { id: "settings", label: t("settings") },
            { id: "reset", label: t("usageRestoreDefaults") },
            { id: "hide", label: t("usageHide") },
          ].map((item) => (
            <ContextMenu.Item
              key={item.id}
              className="menu-item"
              onSelect={() => void selectMenu(item.id)}
            >
              {item.label}
            </ContextMenu.Item>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
