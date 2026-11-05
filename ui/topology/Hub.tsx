import { useId, useRef, useEffect, useState } from "react";
import { animate } from "motion";
import { reducedMotion } from "../motion/surface";
import { t } from "../i18n";
import { hubMarkGeometry } from "./geometry";
import { Plus, Power } from 'lucide-react';
import { Button, Icon, Tooltip } from '../components/ui';
import type { ConnectionReadiness } from '../connectionReadiness';

export default function Hub({ readOnly = false, sourceEmpty, agentEmpty, connectionEmpty, connectionState, onConnections, accessState, accessRunning, accessDisabled, onAccess, onAddSource, onManageAgents }: {
  readOnly?: boolean; connectionEmpty: boolean; connectionState: ConnectionReadiness; onConnections: () => void;
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
    <svg className="graph-brand" viewBox="4 4 92 92" role="img" aria-label="Agent Remote Control" />
    <div ref={top} className="hub-arc-motion"><div className="hub-arc-orbit"><Tooltip text={connectionEmpty && !readOnly ? t('source.newConnection') : `${t('connections.title')} · ${t(`connectionState.${connectionState}`)}`}>
      <button type="button" className="hub-connections hub-arc" data-state={connectionEmpty ? 'empty' : connectionState} aria-label={t(connectionEmpty && !readOnly ? "source.newConnection" : "connections.title")} aria-description={t(`connectionState.${connectionState}`)} aria-haspopup="dialog"
      tabIndex={connectionEmpty && !readOnly ? -1 : undefined} aria-hidden={connectionEmpty && !readOnly || undefined}
      data-panel-anchor onClick={onConnections} {...interaction('top')}>
      <svg viewBox="4 4 92 92" aria-hidden="true">
        <path data-hub-arc="top" d={mark.top} fill="none" stroke="transparent" strokeWidth="18" />
        <path className="hub-arc-stroke" data-hub-arc="top" data-panel-visual d={mark.top} fill="none" stroke="var(--topology-source)" strokeWidth="9" strokeLinecap="round" pathLength="100" />
      </svg>
    </button></Tooltip>
      {!readOnly && connectionEmpty && <Button className="hub-connection-add" data-panel-anchor aria-haspopup="dialog" onClick={onConnections} {...interaction('top')}>
        <Icon icon={Plus} />{t("source.newConnection")}
      </Button>}
    </div></div>
    <div ref={bottom} className="hub-arc-motion"><div className="hub-arc-orbit"><Tooltip side="bottom" text={readOnly || accessDisabled ? accessDescription : `${accessDescription} · ${action}`}>
      <button type="button" className="hub-power hub-arc" data-state={accessState} aria-label={readOnly ? accessDescription : action} aria-description={accessDescription}
        disabled={readOnly} aria-pressed={accessRunning} aria-busy={pending} aria-disabled={readOnly || accessDisabled} {...interaction('bottom')} onClick={() => { if (!readOnly && !accessDisabled) onAccess(); }}>
        <svg viewBox="4 4 92 92" aria-hidden="true">
          <path data-hub-arc="bottom" d={mark.bottom} fill="none" stroke="transparent" strokeWidth="18" />
          <path className="hub-arc-stroke" data-hub-arc="bottom" d={mark.bottom} fill="none" stroke="var(--topology-agent)" strokeWidth="9" strokeLinecap="round" pathLength="100" />
        </svg>
        {!readOnly && <span className="hub-power-action" aria-hidden="true"><Icon size={14} icon={Power} /></span>}
      </button></Tooltip></div></div>
    {(["source", "agent"] as const).map(side => {
      const source = side === "source", empty = source ? sourceEmpty : agentEmpty;
      const label = t(source ? "addControlSource" : empty ? "addAgent" : "manageAgents");
      return <button key={side} type="button" className={`hub-entry hub-${side}`} data-empty={empty || undefined}
        data-panel-anchor aria-label={label} onClick={source ? onAddSource : onManageAgents}>
        <span className="hub-dot" data-panel-visual>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <defs>
              <mask id={`${id}-${side}-mask`} maskUnits="userSpaceOnUse" x="0" y="0" width="20" height="20" style={{ maskType: "luminance" }}>
                <rect width="20" height="20" fill="white" />
                <g className="hub-symbol" fill="black" stroke="black" strokeWidth=".67" strokeLinecap="round">
                  <g>
                    {source || empty ? <g transform="translate(3.866667 3.866667) scale(.68148148)" color="black"><Icon className="hub-plus" icon={Plus} size={18} /></g>
                      : <g stroke="none"><circle cx="4" cy="10" r="1.5" /><circle cx="10" cy="10" r="1.5" /><circle cx="16" cy="10" r="1.5" /></g>}
                  </g>
                </g>
              </mask>
            </defs>
            <circle cx="10" cy="10" r="10" fill={source ? "var(--topology-source)" : "var(--topology-agent)"} mask={`url(#${id}-${side}-mask)`} />
          </svg>
        </span>
      </button>;
    })}
  </>;
}
