import { compareCanonical } from './canonical.js';
import { findDependencyCycles, hasContainmentCycle } from './cycles.js';
import {
  assertSafeMetadataKey,
  fingerprintMetadataPolicy,
  normalizeMetadataSchema,
  validateSnapshotNodeMetadata,
} from './metadata.js';
import type {
  EdgeKind,
  EdgeV1,
  GraphSnapshotV1,
  MetadataValue,
  NodeKind,
  NodeV1,
  SnapshotWarningV1,
  SnapshotMetadataPolicyV1,
} from './types.js';

const NODE_KINDS = new Set<NodeKind>([
  'route',
  'capability',
  'loader',
  'resource',
  'derived',
  'custom',
]);
const EDGE_KINDS = new Set<EdgeKind>(['contains', 'dependsOn']);

function assertAllowedKeys(
  value: Record<string, unknown>,
  name: string,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set(allowedKeys);
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!allowed.has(key)) {
      throw new TypeError(`${name} contains an unknown property.`);
    }
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(
        `${name} properties must be enumerable data properties.`,
      );
    }
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function assertRecord(
  value: unknown,
  name: string,
): asserts value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw new TypeError(`${name} must be a plain object.`);
  }
}

function assertCount(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

function canonicalScalar(value: unknown): MetadataValue {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    !Object.is(value, -0)
  ) {
    return value;
  }
  throw new TypeError('Snapshot metadata contains a forbidden value.');
}

function compareMetadataValue(
  left: MetadataValue,
  right: MetadataValue,
): number {
  if (typeof left === 'string' && typeof right === 'string') {
    return compareCanonical(left, right);
  }
  if (typeof left === 'number' && typeof right === 'number')
    return left - right;
  if (typeof left === 'boolean' && typeof right === 'boolean') {
    return Number(left) - Number(right);
  }
  return compareCanonical(typeof left, typeof right);
}

function canonicalMetadata(value: unknown): NodeV1['metadata'] {
  assertRecord(value, 'Node metadata');
  const output = Object.create(null) as Record<
    string,
    MetadataValue | readonly MetadataValue[]
  >;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).sort(compareCanonical);
  for (const key of keys) {
    assertSafeMetadataKey(key);
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    ) {
      throw new TypeError(
        'Node metadata properties must be enumerable data properties.',
      );
    }
    const item: unknown = descriptor.value;
    if (Array.isArray(item)) {
      if (item.length === 0)
        throw new TypeError('Metadata sets cannot be empty.');
      const members = item.map(canonicalScalar);
      const memberType = typeof members[0];
      if (members.some((member) => typeof member !== memberType)) {
        throw new TypeError('Metadata sets must contain one scalar type.');
      }
      const sorted = members.sort(compareMetadataValue);
      output[key] = sorted.filter(
        (member, index) => index === 0 || !Object.is(member, sorted[index - 1]),
      );
      continue;
    }
    output[key] = canonicalScalar(item);
  }
  return output;
}

function canonicalNode(value: unknown): NodeV1 {
  assertRecord(value, 'Snapshot node');
  assertAllowedKeys(value, 'Snapshot node', [
    'id',
    'kind',
    'label',
    'metadata',
    'observations',
  ]);
  if (
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    value.id.length > 128 ||
    hasControlCharacter(value.id) ||
    typeof value.kind !== 'string' ||
    !NODE_KINDS.has(value.kind as NodeKind) ||
    typeof value.label !== 'string' ||
    value.label.length === 0
  ) {
    throw new TypeError('Snapshot node is invalid.');
  }
  assertCount(value.observations, 'Node observations');
  return {
    id: value.id,
    kind: value.kind as NodeKind,
    label: value.label,
    metadata: canonicalMetadata(value.metadata),
    observations: value.observations,
  };
}

function canonicalEdge(value: unknown): EdgeV1 {
  assertRecord(value, 'Snapshot edge');
  assertAllowedKeys(value, 'Snapshot edge', [
    'from',
    'to',
    'kind',
    'observations',
  ]);
  if (
    typeof value.from !== 'string' ||
    typeof value.to !== 'string' ||
    typeof value.kind !== 'string' ||
    !EDGE_KINDS.has(value.kind as EdgeKind)
  ) {
    throw new TypeError('Snapshot edge is invalid.');
  }
  assertCount(value.observations, 'Edge observations');
  return {
    from: value.from,
    to: value.to,
    kind: value.kind as EdgeKind,
    observations: value.observations,
  };
}

function compareCycles(
  left: readonly string[],
  right: readonly string[],
): number {
  const first = compareCanonical(left[0] ?? '', right[0] ?? '');
  if (first !== 0) return first;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const compared = compareCanonical(left[index] ?? '', right[index] ?? '');
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

function canonicalWarning(value: unknown): SnapshotWarningV1 {
  assertRecord(value, 'Snapshot warning');
  assertAllowedKeys(value, 'Snapshot warning', ['code', 'count']);
  if (value.code !== 'node-limit' && value.code !== 'edge-limit') {
    throw new TypeError('Snapshot warning code is invalid.');
  }
  assertCount(value.count, 'Warning count');
  return { code: value.code, count: value.count };
}

function canonicalMetadataPolicy(value: unknown): SnapshotMetadataPolicyV1 {
  assertRecord(value, 'Snapshot metadata policy');
  assertAllowedKeys(value, 'Snapshot metadata policy', [
    'schema',
    'sha256SaltFingerprint',
  ]);
  const schema = normalizeMetadataSchema(value.schema as never);
  const usesSha256 = Object.values(schema).some(
    (rule) => rule.redact === 'sha256',
  );
  if (
    (usesSha256 &&
      (typeof value.sha256SaltFingerprint !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(value.sha256SaltFingerprint))) ||
    (!usesSha256 && value.sha256SaltFingerprint !== undefined)
  ) {
    throw new TypeError('Snapshot metadata policy salt identity is invalid.');
  }
  return {
    schema,
    ...(usesSha256
      ? { sha256SaltFingerprint: value.sha256SaltFingerprint as string }
      : {}),
  };
}

export function canonicalizeSnapshot(value: unknown): GraphSnapshotV1 {
  assertRecord(value, 'Snapshot');
  assertAllowedKeys(value, 'Snapshot', [
    'format',
    'schemaFingerprint',
    'metadataPolicy',
    'nodes',
    'edges',
    'cycles',
    'warnings',
  ]);
  const schemaFingerprint = value.schemaFingerprint;
  if (
    value.format !== 'runtime-impact-graph/v0.1' ||
    typeof schemaFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(schemaFingerprint) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges) ||
    !Array.isArray(value.cycles) ||
    !Array.isArray(value.warnings)
  ) {
    throw new TypeError('Snapshot envelope is invalid.');
  }
  const metadataPolicy = canonicalMetadataPolicy(value.metadataPolicy);
  const derivedSchemaFingerprint = fingerprintMetadataPolicy(metadataPolicy);
  if (derivedSchemaFingerprint !== schemaFingerprint) {
    throw new TypeError('Snapshot metadata policy fingerprint is invalid.');
  }

  const nodes = value.nodes
    .map(canonicalNode)
    .sort((left, right) => compareCanonical(left.id, right.id));
  for (const node of nodes) {
    validateSnapshotNodeMetadata(node, metadataPolicy.schema);
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (nodeIds.size !== nodes.length)
    throw new TypeError('Duplicate snapshot node.');

  const edges = value.edges
    .map(canonicalEdge)
    .sort(
      (left, right) =>
        compareCanonical(left.from, right.from) ||
        compareCanonical(left.to, right.to) ||
        compareCanonical(left.kind, right.kind),
    );
  const edgeKeys = new Set(
    edges.map((edge) => JSON.stringify([edge.from, edge.to, edge.kind])),
  );
  if (edgeKeys.size !== edges.length)
    throw new TypeError('Duplicate snapshot edge.');
  if (edges.some((edge) => !nodeIds.has(edge.from) || !nodeIds.has(edge.to))) {
    throw new TypeError('Snapshot edge references an unknown node.');
  }
  if (
    hasContainmentCycle(
      nodes.map((node) => node.id),
      edges,
    )
  ) {
    throw new TypeError('Snapshot contains a containment cycle.');
  }

  const cycles = value.cycles
    .map((cycle) => {
      if (!Array.isArray(cycle) || cycle.length === 0) {
        throw new TypeError('Snapshot cycle is invalid.');
      }
      const members = cycle.map((member) => {
        if (typeof member !== 'string' || !nodeIds.has(member)) {
          throw new TypeError('Snapshot cycle member is invalid.');
        }
        return member;
      });
      const sorted = [...members].sort(compareCanonical);
      if (new Set(sorted).size !== sorted.length) {
        throw new TypeError('Snapshot cycle contains a duplicate member.');
      }
      return sorted;
    })
    .sort(compareCycles);
  if (
    new Set(cycles.map((cycle) => JSON.stringify(cycle))).size !== cycles.length
  ) {
    throw new TypeError('Duplicate snapshot cycle.');
  }
  const expectedCycles = findDependencyCycles(
    nodes.map((node) => node.id),
    edges,
  );
  if (JSON.stringify(cycles) !== JSON.stringify(expectedCycles)) {
    throw new TypeError('Snapshot cycles do not match dependency edges.');
  }

  const warnings = value.warnings
    .map(canonicalWarning)
    .sort((left, right) => compareCanonical(left.code, right.code));
  if (
    new Set(warnings.map((warning) => warning.code)).size !== warnings.length
  ) {
    throw new TypeError('Duplicate snapshot warning.');
  }

  return {
    format: 'runtime-impact-graph/v0.1',
    schemaFingerprint: derivedSchemaFingerprint,
    metadataPolicy,
    nodes,
    edges,
    cycles,
    warnings,
  };
}
