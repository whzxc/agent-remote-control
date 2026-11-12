import type { Point, Side } from './geometry';

export interface ConfigurationNode { id: string; account?: boolean; deviceId?: string; children?: ConfigurationNode[] }
export type PlacedNode<N> = N & { side: Side; x: number; y: number; parent?: string };
export const nodeKey = (side: Side, id: string) => JSON.stringify(['node', side, id]);

export function layoutTopology<N extends ConfigurationNode>(left: N[], right: N[], options: {
  width: number; height: number; expanded: ReadonlySet<string>;
}) {
  const compact = options.width < 1000 || options.height > options.width;
  const availableHeight = Math.max(0, options.height - 246);
  const pitch = compact ? 152 : 260;
  const row = compact ? 92 : Math.min(110, Math.max(92, (availableHeight - 96) / Math.max(1, left.length, right.length)));
  const hubSize = compact ? options.width < 500 ? 106 : 144 : right.some(node => node.deviceId) ? 180 : 240;
  const nodes: PlacedNode<N>[] = [];
  const groups: { key: string; node: PlacedNode<N>; members: N[] }[] = [];
  const folded = (node: N) => !!node.children?.length && node.children.every(child => child.account)
    && node.children.length > 1 && !options.expanded.has(node.id);
  const span = (node: N): number => Math.max(row, folded(node) ? row : (node.children ?? []).reduce((sum, child) => sum + span(child as N), 0));
  const leftSpan = left.reduce((sum, node) => sum + span(node), 0);
  const rightSpan = right.reduce((sum, node) => sum + span(node), 0);
  const hubY = compact ? leftSpan + 32 + hubSize / 2 : Math.max((availableHeight - 72) / 2, Math.max(leftSpan, rightSpan) / 2 + 16);
  function place(items: N[], side: Side, depth: number, top: number, parent?: string) {
    let cursor = top;
    for (const item of items) {
      const height = span(item), y = cursor + height / 2;
      const x = side * ((compact ? 0 : 210) + depth * pitch);
      const node = { ...item, side, x, y, parent };
      nodes.push(node);
      const children = (item.children ?? []) as N[];
      if (folded(item)) {
        const group = { ...node, id: `group:${item.id}`, x: x + side * pitch, parent: item.id };
        groups.push({ key: group.id, node: group, members: children });
      } else if (children.length) place(children, side, depth + 1, cursor, item.id);
      cursor += height;
    }
  }
  place(left, -1, 0, compact ? 0 : hubY - leftSpan / 2);
  const rightTop = compact ? hubY + hubSize / 2 + 24 : hubY - rightSpan / 2;
  place(right, 1, 0, rightTop);
  const all = [...nodes, ...groups.map(group => group.node)];
  const groupIds = new Set(groups.map(group => group.key));
  const bounds = (side: Side) => {
    const wing = all.filter(node => node.side === side);
    const cap = compact ? 80 : 164;
    return {
      min: Math.min(0, ...wing.map(node => node.x - (groupIds.has(node.id) ? side === -1 ? 108 : 24 : side === -1 ? cap : 70))),
      max: Math.max(0, ...wing.map(node => node.x + (groupIds.has(node.id) ? side === 1 ? 108 : 24 : side === 1 ? cap : 70))),
    };
  };
  const source = bounds(-1), agent = bounds(1);
  const width = Math.max(options.width, compact ? Math.max(source.max - source.min, agent.max - agent.min) + 48 : agent.max - source.min + 48);
  const offset = compact ? { [-1]: (width - source.min - source.max) / 2, [1]: (width - agent.min - agent.max) / 2 }
    : { [-1]: (width - source.min - agent.max) / 2, [1]: (width - source.min - agent.max) / 2 };
  for (const node of all) node.x += offset[node.side];
  const hub = { x: compact ? width / 2 : offset[1], y: hubY, size: hubSize };
  const add = { x: nodes.find(node => node.side === 1 && !node.parent)?.x ?? hub.x + (compact ? 0 : 210), y: rightTop + rightSpan + 48 };
  const height = Math.max(availableHeight, add.y + 24, ...all.map(node => node.y + 80));
  return { nodes, groups, compact, hub, add, width, height };
}

export function topologyRoute(node: { x: number; y: number; side: Side }, parent: Point | undefined,
  hub: { x: number; y: number; size: number }, compact: boolean, parentWidth = 48, endpoint = false): Point[] {
  const side = node.side, rail = node.x - side * (compact ? 72 : 88);
  const end = { x: node.x - side * (endpoint ? 0 : 24), y: node.y };
  if (parent) return [{ x: parent.x + side * (parentWidth - 24), y: parent.y }, { x: rail, y: parent.y }, { x: rail, y: node.y }, end];
  const start = { x: hub.x + side * hub.size * 83.48 / 240, y: hub.y };
  if (!compact) return [start, { x: rail, y: hub.y }, { x: rail, y: node.y }, end];
  const outside = hub.x + side * (hub.size / 2 + 24);
  const junction = hub.y + side * (hub.size / 2 + (side === -1 ? 12 : 24));
  return [start, { x: outside, y: hub.y }, { x: outside, y: junction }, { x: rail, y: junction }, { x: rail, y: node.y }, end];
}

export function topologyPath(points: Point[]) {
  const clean = points.filter((point, index) => !index || point.x !== points[index - 1].x || point.y !== points[index - 1].y);
  let path = `M${clean[0].x} ${clean[0].y}`;
  for (let index = 1; index < clean.length - 1; index++) {
    const previous = clean[index - 1], point = clean[index], next = clean[index + 1];
    const radius = Math.min(12, Math.hypot(point.x - previous.x, point.y - previous.y) / 2, Math.hypot(next.x - point.x, next.y - point.y) / 2);
    const before = { x: point.x - Math.sign(point.x - previous.x) * radius, y: point.y - Math.sign(point.y - previous.y) * radius };
    const after = { x: point.x + Math.sign(next.x - point.x) * radius, y: point.y + Math.sign(next.y - point.y) * radius };
    path += `L${before.x} ${before.y}Q${point.x} ${point.y} ${after.x} ${after.y}`;
  }
  return `${path}L${clean.at(-1)!.x} ${clean.at(-1)!.y}`;
}
