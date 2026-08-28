import { canonicalizeSnapshot } from '../model/snapshot.js';
import type { GraphSnapshotV1 } from '../model/types.js';

function quote(value: string): string {
  return JSON.stringify(value);
}

export function toDot(snapshot: GraphSnapshotV1): string {
  const canonical = canonicalizeSnapshot(snapshot);
  const lines = [
    'strict digraph RuntimeImpactGraph {',
    '  graph [rankdir="LR"];',
    '  node [shape="box"];',
    '  edge [];',
  ];
  for (const node of canonical.nodes) {
    lines.push(
      `  ${quote(node.id)} [label=${quote(`${node.label}\n${node.kind}`)}];`,
    );
  }
  for (const edge of canonical.edges) {
    lines.push(
      `  ${quote(edge.from)} -> ${quote(edge.to)} [label=${quote(
        `${edge.kind} × ${String(edge.observations)}`,
      )}];`,
    );
  }
  lines.push('}', '');
  return lines.join('\n');
}
