import { useId, useRef, useEffect, useState } from "react";
import { animate } from "motion";
import { reducedMotion } from "../motion/surface";
import { t } from "../i18n";
import { hubMarkGeometry } from "./geometry";
import { Power } from 'lucide-react';
import { Icon, Tooltip } from '../components/ui';
import type { ConnectionReadiness } from '../connectionReadiness';

export default function Hub({ sourceEmpty, agentEmpty, connectionEmpty, connectionState, onConnections, accessState, accessRunning, accessDisabled, onAccess, onAddSource, onManageAgents }: {
  connectionEmpty: boolean; connectionState: ConnectionReadiness; onConnections: () => void;
  accessState: ConnectionReadiness; accessRunning: boolean; accessDisabled: boolean; onAccess: () => void;
  sourceEmpty: boolean; agentEmpty: boolean; onAddSource: () => void; onManageAgents: () => void;
}) {
  const id = useId(), mark = hubMarkGeometry();
  const top = useRef<HTMLDivElement>(null), bottom = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<'top' | 'bottom'>(), [focused, setFocused] = useState<'top' | 'bottom'>();
  useEffect(() => {
    const animations = ([['top', top, -5], ['bottom', bottom, 5]] as const).flatMap(([side, ref, offset]) => ref.current
      ? [animate(ref.current, { y: hovered === side || focused === side ? offset : 0 }, reducedMotion() ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 22 })] : []);
    return () => animations.forEach(animation => animation.stop());
  }, [hovered, focused]);
  const action = t(accessRunning ? 'hub.stop' : 'hub.start');
  const accessDescription = t('hub.accessState', { state: t(`connectionState.${accessState}`) });
  const pending = accessState === 'starting' || accessState === 'stopping';
  const interaction = (side: 'top' | 'bottom') => ({
    onPointerEnter: (event: React.PointerEvent<HTMLButtonElement>) => { if (event.pointerType !== 'touch') setHovered(side); },
    onPointerLeave: () => setHovered(undefined),
    onFocus: (event: React.FocusEvent<HTMLButtonElement>) => { if (event.currentTarget.matches(':focus-visible')) setFocused(side); },
    onBlur: () => setFocused(undefined),
  });
  return <>
    <svg className="graph-brand" viewBox="4 4 92 92" role="img" aria-label="Agent Remote Control">
      <defs><linearGradient id={`${id}-arc`} gradientUnits="userSpaceOnUse" x1="18" y1="50" x2="92" y2="50">
        <stop stopColor="var(--mark-agent-start)" /><stop offset="1" stopColor="var(--mark-agent-end)" />
      </linearGradient></defs>
    </svg>
    <div ref={top} className="hub-arc-motion"><div className="hub-arc-orbit"><Tooltip text={connectionEmpty ? t('source.newConnection') : `${t('connections.title')} · ${t(`connectionState.${connectionState}`)}`}>
      <button type="button" className="hub-connections hub-arc" data-state={connectionEmpty ? 'empty' : connectionState} aria-label={t(connectionEmpty ? "source.newConnection" : "connections.title")} aria-description={t(`connectionState.${connectionState}`)} aria-haspopup="dialog"
      data-panel-anchor onClick={onConnections} {...interaction('top')}>
      <svg viewBox="4 4 92 92" aria-hidden="true">
        <path data-hub-arc="top" d={mark.top} fill="none" stroke="transparent" strokeWidth="18" />
        <path className="hub-arc-stroke" data-hub-arc="top" data-panel-visual d={mark.top} fill="none" stroke="var(--topology-source)" strokeWidth="9" strokeLinecap="round" pathLength="100" />
      </svg>
      {connectionEmpty && <span className="hub-connection-add rounded-full border border-solid border-border bg-background px-3 py-2 text-sm shadow-sm">+ {t("source.newConnection")}</span>}
    </button></Tooltip></div></div>
    <div ref={bottom} className="hub-arc-motion"><div className="hub-arc-orbit"><Tooltip side="bottom" text={accessDisabled ? accessDescription : `${accessDescription} · ${action}`}>
      <button type="button" className="hub-power hub-arc" data-state={accessState} aria-label={action} aria-description={accessDescription}
        aria-pressed={accessRunning} aria-busy={pending} aria-disabled={accessDisabled} {...interaction('bottom')} onClick={() => { if (!accessDisabled) onAccess(); }}>
        <svg viewBox="4 4 92 92" aria-hidden="true">
          <defs><mask id={`${id}-power`} maskUnits="userSpaceOnUse" x="4" y="4" width="92" height="92" style={{ maskType: 'luminance' }}>
            <rect x="4" y="4" width="92" height="92" fill="white" />
            <g className="hub-power-symbol" transform="translate(46 78) scale(.5)" color="black"><Icon icon={Power} /></g>
          </mask></defs>
          <path data-hub-arc="bottom" d={mark.bottom} fill="none" stroke="transparent" strokeWidth="18" />
          <path className="hub-arc-stroke" data-hub-arc="bottom" d={mark.bottom} fill="none" stroke={`url(#${id}-arc)`} strokeWidth="9" strokeLinecap="round" pathLength="100" mask={`url(#${id}-power)`} />
        </svg>
      </button></Tooltip></div></div>
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
