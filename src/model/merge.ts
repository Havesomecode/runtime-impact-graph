import { compareCanonical } from './canonical.js';
import { findDependencyCycles, hasContainmentCycle } from './cycles.js';
import { mergeMetadata, registeredMetadataSchema } from './metadata.js';
import { canonicalizeSnapshot } from './snapshot.js';
import type {
  EdgeV1,
  GraphSnapshotV1,
  NodeV1,
  MetadataValue,
  MetadataSchema,
  SnapshotWarningV1,
} from './types.js';
import { CountOverflowError } from '../runtime/errors.js';

function addCounts(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new CountOverflowError();
  return result;
}

function mergeNodeMetadata(
  left: NodeV1['metadata'],
  right: NodeV1['metadata'],
  schema: MetadataSchema | undefined,
): NodeV1['metadata'] {
  if (schema !== undefined) return mergeMetadata(left, right, schema);
  const output: Record<string, MetadataValue | readonly MetadataValue[]> = {};
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort(
    compareCanonical,
  );
  for (const key of keys) {
    const leftValue = left[key];
    const rightValue = right[key];
    if (leftValue === undefined) {
      if (rightValue !== undefined) output[key] = rightValue;
      continue;
    }
    if (rightValue === undefined) {
      output[key] = leftValue;
      continue;
    }
    if (!Array.isArray(leftValue) || !Array.isArray(rightValue)) {
      if (
        Array.isArray(leftValue) ||
        Array.isArray(rightValue) ||
        !Object.is(leftValue, rightValue)
      ) {
        throw new TypeError('Conflicting constant snapshot metadata.');
      }
      output[key] = leftValue;
      continue;
    }
    throw new TypeError(
      'Set metadata cannot be merged without a registered metadata policy.',
    );
  }
  return output;
}

export function mergeSnapshots(
  snapshots: readonly GraphSnapshotV1[],
): GraphSnapshotV1 {
  if (snapshots.length === 0) {
    throw new TypeError('At least one snapshot is required.');
  }
  const canonicalSnapshots = snapshots.map(canonicalizeSnapshot);
  const first = canonicalSnapshots[0];
  if (first === undefined)
    throw new TypeError('At least one snapshot is required.');
  const metadataSchema = registeredMetadataSchema(first.schemaFingerprint);

  const nodes = new Map<string, NodeV1>();
  const edges = new Map<string, EdgeV1>();
  const warnings = new Map<SnapshotWarningV1['code'], number>();

  for (const snapshot of canonicalSnapshots) {
    if (
      snapshot.format !== 'runtime-impact-graph/v0.1' ||
      snapshot.schemaFingerprint !== first.schemaFingerprint
    ) {
      throw new TypeError(
        'Snapshots have incompatible format or metadata policy.',
      );
    }

    for (const node of snapshot.nodes) {
      if (!Number.isSafeInteger(node.observations) || node.observations < 1) {
        throw new TypeError(
          'Snapshot node counts must be positive safe integers.',
        );
      }
      const existing = nodes.get(node.id);
      if (existing === undefined) {
        nodes.set(node.id, {
          ...node,
          metadata: { ...node.metadata },
        });
      } else {
        if (existing.kind !== node.kind || existing.label !== node.label) {
          throw new TypeError('Conflicting snapshot node descriptor.');
        }
        nodes.set(node.id, {
          ...existing,
          metadata: mergeNodeMetadata(
            existing.metadata,
            node.metadata,
            metadataSchema,
          ),
          observations: addCounts(existing.observations, node.observations),
        });
      }
    }

    for (const edge of snapshot.edges) {
      if (!Number.isSafeInteger(edge.observations) || edge.observations < 1) {
        throw new TypeError(
          'Snapshot edge counts must be positive safe integers.',
        );
      }
      const key = JSON.stringify([edge.from, edge.to, edge.kind]);
      const existing = edges.get(key);
      edges.set(
        key,
        existing === undefined
          ? { ...edge }
          : {
              ...existing,
              observations: addCounts(existing.observations, edge.observations),
            },
      );
    }

    for (const warning of snapshot.warnings) {
      if (!Number.isSafeInteger(warning.count) || warning.count < 1) {
        throw new TypeError(
          'Snapshot warning counts must be positive safe integers.',
        );
      }
      warnings.set(
        warning.code,
        addCounts(warnings.get(warning.code) ?? 0, warning.count),
      );
    }
  }

  const orderedNodes = [...nodes.values()].sort((left, right) =>
    compareCanonical(left.id, right.id),
  );
  const orderedEdges = [...edges.values()].sort(
    (left, right) =>
      compareCanonical(left.from, right.from) ||
      compareCanonical(left.to, right.to) ||
      compareCanonical(left.kind, right.kind),
  );
  if (
    hasContainmentCycle(
      orderedNodes.map((node) => node.id),
      orderedEdges,
    )
  ) {
    throw new TypeError('Merged snapshots contain a containment cycle.');
  }

  return {
    format: 'runtime-impact-graph/v0.1',
    schemaFingerprint: first.schemaFingerprint,
    nodes: orderedNodes,
    edges: orderedEdges,
    cycles: findDependencyCycles(
      orderedNodes.map((node) => node.id),
      orderedEdges,
    ),
    warnings: [...warnings.entries()]
      .sort(([left], [right]) => compareCanonical(left, right))
      .map(([code, count]) => ({ code, count })),
  };
}
