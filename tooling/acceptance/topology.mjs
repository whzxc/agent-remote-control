// A root is represented either by its real node or by a folded root capsule.
// Child groups describe accounts, not additional root Agents or sources.
export function representedTopologyRoots(topology, side) {
  const visible = (topology?.nodes ?? []).filter(node => node.side === side && !node.parent && !node.group && node.position).map(node => node.id);
  const folded = (topology?.groups ?? []).filter(group => group.side === side && !group.parent && group.folded && group.position).flatMap(group => group.members);
  return [...new Set([...visible, ...folded])];
}
