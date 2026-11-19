export const sourcePlatformNodeId = (platform: string) => `platform:${platform}`;

interface PathNode { id: string; side: -1 | 1; parent?: string }
export function highlightedPaths(nodes: PathNode[], target: { side: -1 | 1; id: string } | null) {
  if (!target) return null;
  const key = (node: PathNode) => JSON.stringify([node.side, node.id]);
  const selected = nodes.find(node => node.side === target.side && node.id === target.id);
  if (!selected) return null;
  const lit = new Set<string>();
  const add = (node: PathNode | undefined) => {
    if (!node || lit.has(key(node))) return;
    lit.add(key(node));
    if (node.parent) add(nodes.find(parent => parent.side === node.side && parent.id === node.parent));
  };
  const descendants = (node: PathNode): boolean => node === selected || !!node.parent && nodes.some(parent => parent.side === node.side && parent.id === node.parent && descendants(parent));
  nodes.filter(descendants).forEach(add);
  return lit;
}
