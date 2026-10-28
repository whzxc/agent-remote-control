import { useEffect, useRef, useState } from 'react';
import { Popover } from 'radix-ui';
import { t } from '../i18n';
import { Button } from '../components/ui';
import type { NodeView } from './Topology';
import type { Side } from './solve';

export default function OverflowStack({ nodes, side }: { nodes: NodeView[]; side: Side }) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), chosen = useRef(false), pointerOpened = useRef(false);
  const cancel = () => { clearTimeout(closeTimer.current); };
  const enter = () => { cancel(); pointerOpened.current = true; setOpen(true); };
  const leave = () => { cancel(); closeTimer.current = setTimeout(() => setOpen(false), 200); };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const rows = (list: NodeView[]): NodeView[] => list.flatMap(n => [n, ...rows(n.children ?? [])]);
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild><Button variant="ghost" className="topology-overflow-trigger"
      aria-label={t('topology.moreNodes', { count: nodes.length })}
      onPointerEnter={event => { if (event.pointerType !== 'touch') enter(); }} onPointerLeave={event => { if (event.pointerType !== 'touch') leave(); }}
      onPointerDown={() => { pointerOpened.current = false; }} onKeyDown={() => { pointerOpened.current = false; }}>
      <span className="topology-overflow-icons" aria-hidden="true">{nodes.slice(0, 3).map((node, index) => <span key={node.id} style={{ transform: `translate(${index * 7 - 7}px, ${index * -5 + 5}px)` }}>{node.icon}</span>)}</span>
      <span className="topology-overflow-count">{nodes.length}</span>
    </Button></Popover.Trigger>
    <Popover.Portal><Popover.Content className={`topology-overflow-popover ${side === -1 ? 'sources' : 'agents'}`} side={side === -1 ? 'right' : 'left'} sideOffset={16} collisionPadding={16}
      aria-label={t('topology.moreNodes', { count: nodes.length })}
      onPointerEnter={cancel} onPointerLeave={event => { if (event.pointerType !== 'touch') leave(); }} onFocusCapture={cancel}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) leave(); }}
      onOpenAutoFocus={event => { if (pointerOpened.current) event.preventDefault(); }}
      onCloseAutoFocus={event => { if (chosen.current || pointerOpened.current) event.preventDefault(); chosen.current = false; }}
      onEscapeKeyDown={event => event.stopPropagation()} onClick={event => {
        if ((event.target as Element).closest('button')) { chosen.current = true; setOpen(false); }
      }}>
      {nodes.map(node => <div key={node.id} className="topology-overflow-group">{rows([node]).map(item => <div key={item.id} className="topology-overflow-item">{item.content}</div>)}</div>)}
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
