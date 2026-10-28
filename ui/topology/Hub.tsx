import { useId, useRef, useEffect, useState } from "react";
import { animate } from "motion";
import { reducedMotion } from "../motion/surface";
import { t } from "../i18n";
import { hubMarkGeometry } from "./geometry";

export default function Hub({ sourceEmpty, agentEmpty, connectionEmpty, onConnections, onAddSource, onManageAgents }: {
  connectionEmpty: boolean; onConnections: () => void;
  sourceEmpty: boolean; agentEmpty: boolean; onAddSource: () => void; onManageAgents: () => void;
}) {
  const id = useId(), mark = hubMarkGeometry();
  const top = useRef<HTMLDivElement>(null), [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!top.current) return;
    const animation = animate(top.current, { y: hovered || focused ? -5 : 0 }, reducedMotion() ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 22 });
    return () => animation.stop();
  }, [hovered, focused]);
  return <>
    <svg className="graph-brand" viewBox="4 4 92 92" role="img" aria-label="Agent Remote Control">
      <defs><linearGradient id={`${id}-arc`} gradientUnits="userSpaceOnUse" x1="18" y1="50" x2="92" y2="50">
        <stop stopColor="var(--mark-agent-start)" /><stop offset="1" stopColor="var(--mark-agent-end)" />
      </linearGradient></defs>
      <path data-hub-arc="bottom" d={mark.bottom} fill="none" stroke={`url(#${id}-arc)`} strokeWidth="9" strokeLinecap="round" />
    </svg>
    <div ref={top} className="hub-connection-motion"><div className="hub-connection-orbit"><button type="button" className="hub-connections" aria-label={t(connectionEmpty ? "source.newConnection" : "connections.title")} aria-haspopup="dialog"
      data-panel-anchor onClick={onConnections} onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}>
      <svg viewBox="4 4 92 92" aria-hidden="true">
        <path data-hub-arc="top" d={mark.top} fill="none" stroke="transparent" strokeWidth="18" />
        <path data-hub-arc="top" data-panel-visual d={mark.top} fill="none" stroke="var(--topology-source)" strokeWidth="9" strokeLinecap="round" pathLength="100" strokeDasharray={connectionEmpty ? "35 30 35" : undefined} />
      </svg>
      {connectionEmpty && <span className="hub-connection-add rounded-full border border-solid border-border bg-background px-3 py-2 text-sm shadow-sm">+ {t("source.newConnection")}</span>}
    </button></div></div>
    {(["source", "agent"] as const).map(side => {
      const source = side === "source", empty = source ? sourceEmpty : agentEmpty;
      const label = t(source ? "addControlSource" : empty ? "addAgent" : "manageAgents");
      return <button key={side} type="button" className={`hub-entry hub-${side}`} data-empty={empty || undefined}
        data-panel-anchor aria-label={label} onClick={source ? onAddSource : onManageAgents}>
        <span className="hub-dot" data-panel-visual>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <defs>
              <linearGradient id={`${id}-${side}-fill`} gradientUnits="userSpaceOnUse" x1="-54" y1="10" x2="20" y2="10">
                <stop stopColor="var(--mark-agent-start)" /><stop offset="1" stopColor="var(--mark-agent-end)" />
              </linearGradient>
              <mask id={`${id}-${side}-mask`} maskUnits="userSpaceOnUse" x="0" y="0" width="20" height="20" style={{ maskType: "luminance" }}>
                <rect width="20" height="20" fill="white" />
                <g className="hub-symbol" fill="black" stroke="black" strokeWidth="2.5" strokeLinecap="round">
                  <g transform="translate(10 10) scale(.72) translate(-10 -10)">
                    {source || empty ? <path d="M3.75 10H16.25 M10 3.75V16.25" />
                      : <g stroke="none"><circle cx="4" cy="10" r="1.5" /><circle cx="10" cy="10" r="1.5" /><circle cx="16" cy="10" r="1.5" /></g>}
                  </g>
                </g>
              </mask>
            </defs>
            <circle cx="10" cy="10" r="10" fill={source ? "var(--topology-source)" : `url(#${id}-${side}-fill)`} mask={`url(#${id}-${side}-mask)`} />
          </svg>
        </span>
        {empty && <span className="hub-hint" aria-hidden="true">{label}</span>}
      </button>;
    })}
  </>;
}
