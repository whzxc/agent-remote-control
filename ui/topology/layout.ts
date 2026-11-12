import type { Side } from './geometry';

export interface ConfigurationNode { id: string; account?: boolean; deviceId?: string; children?: ConfigurationNode[] }
export type PlacedNode<N> = N & { side: Side; x: number; y: number; parent?: string };
export const nodeKey = (side: Side, id: string) => JSON.stringify(['node', side, id]);

export function layoutTopology<N extends ConfigurationNode>(left: N[], right: N[], options: {
  compact: boolean; pitch: number; hubX: number; hubY: number; expanded: ReadonlySet<string>;
}) {
  const { compact, pitch, hubX, hubY, expanded } = options;
  const nodes: PlacedNode<N>[] = [];
  const groups: { key: string; node: PlacedNode<N>; members: N[] }[] = [];
  function place(items: N[], side: Side, depth: number, centerY: number, parent?: string, rowPitch = compact ? 118 : 134) {
    const span = Math.max(1, items.length) * rowPitch;
    items.forEach((item, index) => {
      const y = centerY - span / 2 + (index + .5) * span / items.length;
      const x = compact ? side === -1 ? hubX - 80 - depth * pitch : hubX + (depth + 1) * pitch : hubX + side * (210 + depth * pitch);
      const node = { ...item, side, x, y, parent };
      nodes.push(node);
      const children = (item.children ?? []) as N[];
      if (children.every(child => child.account) && (children.length > 3 || compact && children.length > 1) && !expanded.has(item.id)) {
        const group = { ...node, id: `group:${item.id}`, x: x + side * pitch, parent: item.id };
        groups.push({ key: group.id, node: group, members: children });
      } else if (children.length) place(children, side, depth + 1, y, item.id);
    });
  }
  place(left, -1, 0, compact ? 110 : hubY);
  const firstDevice = right.findIndex(node => !!node.deviceId);
  if (compact) place(right, 1, 0, 400 + Math.max(0, right.length - 2) * 60);
  else if (firstDevice >= 0) {
    right.forEach((node, index) => place([node], 1, 0, 24 + index * 110 + (index >= firstDevice ? 40 : 0)));
  } else {
    const center = Math.max(hubY - (right.length > 1 ? 29 : 0), (right.length - 1) * 210 / 2 + 24);
    place(right, 1, 0, center, undefined, 210);
  }
  return { nodes, groups };
}
