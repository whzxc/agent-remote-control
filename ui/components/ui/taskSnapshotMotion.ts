import { animate } from 'motion/react';
import { motionTransition } from '../../motion/tokens';

export function taskSnapshotElement(key?: string) {
  return key ? document.querySelector<HTMLElement>(`[data-task-snapshot="${CSS.escape(key)}"]`) : null;
}
let pending: { key: string; rect: DOMRect; clone: HTMLElement } | undefined;
export function prepareTaskSnapshot(key: string) {
  const source = taskSnapshotElement(key);
  pending = source ? { key, rect: source.getBoundingClientRect(), clone: source.cloneNode(true) as HTMLElement } : undefined;
}
/** Morph the snapshot and the existing centered layer together; the layer registry retains dismissal ownership. */
export function morphTaskSnapshot(node: HTMLElement, key: string, opening: boolean) {
  const source = taskSnapshotElement(key);
  if (!source) return;
  const prepared = opening && pending?.key === key ? pending : undefined;
  if (opening) pending = undefined;
  const card = prepared?.rect ?? source.getBoundingClientRect(), layer = node.getBoundingClientRect();
  if (!card.width || !card.height || !layer.width || !layer.height || card.bottom < 0 || card.top > innerHeight) return;
  const clone = prepared?.clone ?? source.cloneNode(true) as HTMLElement;
  clone.removeAttribute('data-task-snapshot');
  clone.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
  clone.setAttribute('aria-hidden', 'true'); clone.inert = true;
  Object.assign(clone.style, { position: 'fixed', left: `${card.x}px`, top: `${card.y}px`, width: `${card.width}px`,
    height: `${card.height}px`, margin: '0', transformOrigin: 'top left', pointerEvents: 'none', zIndex: String((Number(getComputedStyle(node).zIndex) || 100) + 1) });
  document.body.append(clone);
  const transition = motionTransition('panel', opening ? 'enter' : 'exit');
  const small = { x: card.x - layer.x, y: card.y - layer.y, scaleX: card.width / layer.width, scaleY: card.height / layer.height };
  const large = { x: layer.x - card.x, y: layer.y - card.y, scaleX: layer.width / card.width, scaleY: layer.height / card.height };
  node.style.transformOrigin = 'top left';
  const panel = animate(node, opening ? { x: [small.x, 0], y: [small.y, 0], scaleX: [small.scaleX, 1], scaleY: [small.scaleY, 1], opacity: [0, 1] }
    : { x: [0, small.x], y: [0, small.y], scaleX: [1, small.scaleX], scaleY: [1, small.scaleY], opacity: [1, 0] }, transition);
  const snapshot = animate(clone, opening ? { x: [0, large.x], y: [0, large.y], scaleX: [1, large.scaleX], scaleY: [1, large.scaleY], opacity: [1, 0] }
    : { x: [large.x, 0], y: [large.y, 0], scaleX: [large.scaleX, 1], scaleY: [large.scaleY, 1], opacity: [0, 1] }, transition);
  const cleanup = () => { clone.remove(); node.style.transform = ''; node.style.transformOrigin = ''; };
  return { finished: Promise.all([panel, snapshot]).finally(cleanup), stop: () => { panel.stop(); snapshot.stop(); cleanup(); } };
}
