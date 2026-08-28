import { compareCanonical } from './canonical.js';
import type { EdgeV1 } from './types.js';

function compareLists(
  left: readonly string[],
  right: readonly string[],
): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = compareCanonical(left[index] ?? '', right[index] ?? '');
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function append(map: Map<string, string[]>, from: string, to: string): void {
  const values = map.get(from);
  if (values === undefined) map.set(from, [to]);
  else values.push(to);
}

export function hasContainmentCycle(
  nodeIds: readonly string[],
  edges: readonly EdgeV1[],
): boolean {
  const indegree = new Map<string, number>(
    nodeIds.map((id) => [id, 0] as const),
  );
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== 'contains') continue;
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const queue = nodeIds
    .filter((id) => (indegree.get(id) ?? 0) === 0)
    .sort(compareCanonical);
  let visited = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current === undefined) continue;
    visited += 1;
    for (const neighbor of adjacency.get(current) ?? []) {
      const next = (indegree.get(neighbor) ?? 0) - 1;
      indegree.set(neighbor, next);
      if (next === 0) queue.push(neighbor);
    }
  }
  return visited !== nodeIds.length;
}

export function findDependencyCycles(
  nodeIds: readonly string[],
  edges: readonly EdgeV1[],
): readonly (readonly string[])[] {
  const nodes = [...new Set(nodeIds)].sort(compareCanonical);
  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  const selfLoops = new Set<string>();
  for (const edge of edges) {
    if (edge.kind !== 'dependsOn') continue;
    append(forward, edge.from, edge.to);
    append(reverse, edge.to, edge.from);
    if (edge.from === edge.to) selfLoops.add(edge.from);
  }
  for (const values of [...forward.values(), ...reverse.values()]) {
    values.sort(compareCanonical);
  }

  const visited = new Set<string>();
  const finishingOrder: string[] = [];
  for (const start of nodes) {
    if (visited.has(start)) continue;
    visited.add(start);
    const stack: Array<{ readonly id: string; index: number }> = [
      { id: start, index: 0 },
    ];
    while (stack.length > 0) {
      const frame = stack.at(-1);
      if (frame === undefined) break;
      const neighbors = forward.get(frame.id) ?? [];
      const neighbor = neighbors[frame.index];
      if (neighbor !== undefined) {
        frame.index += 1;
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          stack.push({ id: neighbor, index: 0 });
        }
      } else {
        finishingOrder.push(frame.id);
        stack.pop();
      }
    }
  }

  const assigned = new Set<string>();
  const cycles: string[][] = [];
  for (let index = finishingOrder.length - 1; index >= 0; index -= 1) {
    const start = finishingOrder[index];
    if (start === undefined || assigned.has(start)) continue;
    const component: string[] = [];
    const stack = [start];
    assigned.add(start);
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) continue;
      component.push(current);
      for (const neighbor of reverse.get(current) ?? []) {
        if (!assigned.has(neighbor)) {
          assigned.add(neighbor);
          stack.push(neighbor);
        }
      }
    }
    component.sort(compareCanonical);
    if (component.length > 1 || selfLoops.has(component[0] ?? '')) {
      cycles.push(component);
    }
  }
  return cycles.sort(compareLists);
}
