import { useImperativeHandle, useLayoutEffect, useRef, type Ref } from 'react';
import { CheckCheck, Minus, Plus } from 'lucide-react';
import { Button, Icon } from '../components/ui';
import { notify } from '../state/connector';
import { t } from '../i18n';
import { arcActionPositions, arcPath, type ArcActionGeometry } from './geometry';

export interface ArcActionsHandle { place(geometry: ArcActionGeometry, visible: boolean): void }
export default function ArcActions({ label, side, open, collapsed, canCollapse, unread, onCollapse, onRead, onOpen, onDismiss, ref }: {
  label: string; side: -1 | 1; open: boolean; collapsed: boolean; canCollapse: boolean; unread: boolean;
  onCollapse?: () => void; onRead?: () => void; onOpen: (open: boolean) => void; onDismiss: () => void; ref: Ref<ArcActionsHandle>;
}) {
  const root = useRef<HTMLDivElement>(null), hit = useRef<SVGPathElement>(null);
  const frame = useRef<{ geometry: ArcActionGeometry; visible: boolean } | undefined>(undefined);
  const actions = [
    ...(onCollapse ? [{ id: 'collapse', icon: collapsed ? Plus : Minus, label: `${t(collapsed ? 'topology.expand' : 'topology.collapse')} ${label}`, disabled: !canCollapse, run: onCollapse }] : []),
    ...(unread && onRead ? [{ id: 'read', icon: CheckCheck, label: t('activity.markAllRead'), disabled: false, run: onRead }] : []),
  ];
  const place = (geometry: ArcActionGeometry, visible: boolean) => {
    frame.current = { geometry, visible };
    if (!root.current || !hit.current) return;
    root.current.hidden = !visible; root.current.inert = !visible;
    hit.current.setAttribute('d', geometry.kind === 'arc' ? arcPath(geometry.x, geometry.y, geometry.radius, geometry.lo, geometry.hi, geometry.side)
      : `M${geometry.start.x},${geometry.start.y} L${geometry.end.x},${geometry.end.y}`);
    const positions = arcActionPositions(geometry, actions.length);
    root.current.querySelectorAll<HTMLElement>('[data-arc-action]').forEach((slot, index) => {
      const point = positions[index];
      if (!point) return;
      Object.assign(slot.style, { left: `${point.x - 14}px`, top: `${point.y - 14}px` });
      slot.style.setProperty('--action-dx', `${point.dx}px`); slot.style.setProperty('--action-dy', `${point.dy}px`);
      const bridge = slot.querySelector<HTMLElement>('.arc-action-bridge');
      if (bridge) Object.assign(bridge.style, { left: `${Math.min(0, point.dx)}px`, top: `${Math.min(0, point.dy)}px`,
        width: `${28 + Math.abs(point.dx)}px`, height: `${28 + Math.abs(point.dy)}px` });
    });
  };
  useImperativeHandle(ref, () => ({ place }));
  useLayoutEffect(() => { if (frame.current) place(frame.current.geometry, frame.current.visible); });
  return <div ref={root} className="topology-arc-actions" data-side={side} data-open={open || undefined} role="group" aria-label={label}
    onPointerEnter={event => { if (event.pointerType !== 'touch') onOpen(true); }} onPointerLeave={event => { if (event.pointerType !== 'touch') onOpen(false); }} onPointerCancel={() => onOpen(false)}
    onFocusCapture={() => onOpen(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) onOpen(false); }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onOpen(false); onDismiss(); } }}>
    <svg className="arc-action-hit" aria-hidden="true"><path ref={hit} onPointerDown={event => {
      if (event.pointerType === 'touch') { event.preventDefault(); onOpen(!open); }
    }} /></svg>
    {actions.map(action => <div key={action.id} data-arc-action={action.id} className="arc-action-slot">
      <span className="arc-action-bridge" aria-hidden="true" />
      <Button variant="ghost" className="arc-action-button" aria-label={action.label} disabled={action.disabled}
        aria-expanded={action.id === 'collapse' ? !collapsed : undefined} onPointerDown={event => event.stopPropagation()} onClick={() => {
          try { action.run(); onOpen(false); requestAnimationFrame(onDismiss); } catch (error) { notify(String(error), true); }
        }}><svg className="arc-action-glyph" viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10" r="10" fill="var(--account-color)" />
          <g transform="translate(2 2)" color="var(--canvas)"><Icon icon={action.icon} /></g>
        </svg></Button>
    </div>)}
  </div>;
}
