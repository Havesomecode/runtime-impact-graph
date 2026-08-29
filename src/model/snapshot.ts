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
): Readonly<Record<string, PropertyDescriptor>> {
  const allowed = new Set(allowedKeys);
  const descriptors = captureDataProperties(value, name);
  for (const key of Object.keys(descriptors)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${name} contains an unknown property.`);
    }
  }
  return descriptors;
}

function capturedField(
  value: Record<string, unknown>,
  descriptors: Readonly<Record<string, PropertyDescriptor>>,
  key: string,
): unknown {
  return Object.hasOwn(descriptors, key) ? value[key] : undefined;
}

function captureDataProperties(
  value: object,
  name: string,
): Readonly<Record<string, PropertyDescriptor>> {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') {
      throw new TypeError(`${name} must not contain symbol keys.`);
    }
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    ) {
      throw new TypeError(
        `${name} properties must be enumerable data properties.`,
      );
    }
  }
  return descriptors;
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
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain object.`);
  }
}

function assertCount(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

function captureArray(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array.`);
  }
  const array: object = value;
  const descriptors = Object.getOwnPropertyDescriptors(array);
  const keys = Reflect.ownKeys(descriptors);
  const lengthDescriptor = descriptors.length;
  if (
    lengthDescriptor === undefined ||
    !('value' in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    (lengthDescriptor.value as number) < 0 ||
    keys.length !== (lengthDescriptor.value as number) + 1
  ) {
    throw new TypeError(`${name} has an invalid array length.`);
  }
  const length = lengthDescriptor.value as number;
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw new TypeError(
        `${name} must contain enumerable data properties only.`,
      );
    }
    output.push(descriptor.value);
  }
  return output;
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
  const descriptors = captureDataProperties(value, 'Node metadata');
  const keys = Object.keys(descriptors).sort(compareCanonical);
  for (const key of keys) {
    assertSafeMetadataKey(key);
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError(
        'Node metadata properties must be enumerable data properties.',
      );
    }
    const item: unknown = descriptor.value;
    if (Array.isArray(item)) {
      const capturedItems = captureArray(item, 'Metadata set');
      if (capturedItems.length === 0)
        throw new TypeError('Metadata sets cannot be empty.');
      const members = capturedItems.map(canonicalScalar);
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
  const descriptors = assertAllowedKeys(value, 'Snapshot node', [
    'id',
    'kind',
    'label',
    'metadata',
    'observations',
  ]);
  const id = capturedField(value, descriptors, 'id');
  const kind = capturedField(value, descriptors, 'kind');
  const label = capturedField(value, descriptors, 'label');
  const metadata = capturedField(value, descriptors, 'metadata');
  const observations = capturedField(value, descriptors, 'observations');
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > 128 ||
    hasControlCharacter(id) ||
    typeof kind !== 'string' ||
    !NODE_KINDS.has(kind as NodeKind) ||
    typeof label !== 'string' ||
    label.length === 0
  ) {
    throw new TypeError('Snapshot node is invalid.');
  }
  assertCount(observations, 'Node observations');
  return {
    id,
    kind: kind as NodeKind,
    label,
    metadata: canonicalMetadata(metadata),
    observations,
  };
}

function canonicalEdge(value: unknown): EdgeV1 {
  assertRecord(value, 'Snapshot edge');
  const descriptors = assertAllowedKeys(value, 'Snapshot edge', [
    'from',
    'to',
    'kind',
    'observations',
  ]);
  const from = capturedField(value, descriptors, 'from');
  const to = capturedField(value, descriptors, 'to');
  const kind = capturedField(value, descriptors, 'kind');
  const observations = capturedField(value, descriptors, 'observations');
  if (
    typeof from !== 'string' ||
    typeof to !== 'string' ||
    typeof kind !== 'string' ||
    !EDGE_KINDS.has(kind as EdgeKind)
  ) {
    throw new TypeError('Snapshot edge is invalid.');
  }
  assertCount(observations, 'Edge observations');
  return {
    from,
    to,
    kind: kind as EdgeKind,
    observations,
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
  const descriptors = assertAllowedKeys(value, 'Snapshot warning', [
    'code',
    'count',
  ]);
  const code = capturedField(value, descriptors, 'code');
  const count = capturedField(value, descriptors, 'count');
  if (code !== 'node-limit' && code !== 'edge-limit') {
    throw new TypeError('Snapshot warning code is invalid.');
  }
  assertCount(count, 'Warning count');
  return { code, count };
}

function canonicalMetadataPolicy(value: unknown): SnapshotMetadataPolicyV1 {
  assertRecord(value, 'Snapshot metadata policy');
  const descriptors = assertAllowedKeys(value, 'Snapshot metadata policy', [
    'schema',
    'sha256SaltFingerprint',
  ]);
  const schemaValue = capturedField(value, descriptors, 'schema');
  const sha256SaltFingerprint = capturedField(
    value,
    descriptors,
    'sha256SaltFingerprint',
  );
  const schema = normalizeMetadataSchema(schemaValue as never);
  const usesSha256 = Object.values(schema).some(
    (rule) => rule.redact === 'sha256',
  );
  if (
    (usesSha256 &&
      (typeof sha256SaltFingerprint !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(sha256SaltFingerprint))) ||
    (!usesSha256 && sha256SaltFingerprint !== undefined)
  ) {
    throw new TypeError('Snapshot metadata policy salt identity is invalid.');
  }
  return {
    schema,
    ...(usesSha256
      ? { sha256SaltFingerprint: sha256SaltFingerprint as string }
      : {}),
  };
}

export function canonicalizeSnapshot(value: unknown): GraphSnapshotV1 {
  assertRecord(value, 'Snapshot');
  const descriptors = assertAllowedKeys(value, 'Snapshot', [
    'format',
    'schemaFingerprint',
    'metadataPolicy',
    'nodes',
    'edges',
    'cycles',
    'warnings',
  ]);
  const format = capturedField(value, descriptors, 'format');
  const schemaFingerprint = capturedField(
    value,
    descriptors,
    'schemaFingerprint',
  );
  const metadataPolicyValue = capturedField(
    value,
    descriptors,
    'metadataPolicy',
  );
  const nodesValue = capturedField(value, descriptors, 'nodes');
  const edgesValue = capturedField(value, descriptors, 'edges');
  const cyclesValue = capturedField(value, descriptors, 'cycles');
  const warningsValue = capturedField(value, descriptors, 'warnings');
  if (
    format !== 'runtime-impact-graph/v0.1' ||
    typeof schemaFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(schemaFingerprint) ||
    !Array.isArray(nodesValue) ||
    !Array.isArray(edgesValue) ||
    !Array.isArray(cyclesValue) ||
    !Array.isArray(warningsValue)
  ) {
    throw new TypeError('Snapshot envelope is invalid.');
  }
  const metadataPolicy = canonicalMetadataPolicy(metadataPolicyValue);
  const derivedSchemaFingerprint = fingerprintMetadataPolicy(metadataPolicy);
  if (derivedSchemaFingerprint !== schemaFingerprint) {
    throw new TypeError('Snapshot metadata policy fingerprint is invalid.');
  }

  const nodes = captureArray(nodesValue, 'Snapshot nodes')
    .map(canonicalNode)
    .sort((left, right) => compareCanonical(left.id, right.id));
  for (const node of nodes) {
    validateSnapshotNodeMetadata(node, metadataPolicy.schema);
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (nodeIds.size !== nodes.length)
    throw new TypeError('Duplicate snapshot node.');

  const edges = captureArray(edgesValue, 'Snapshot edges')
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

  const cycles = captureArray(cyclesValue, 'Snapshot cycles')
    .map((cycle) => {
      const capturedCycle = captureArray(cycle, 'Snapshot cycle');
      if (capturedCycle.length === 0) {
        throw new TypeError('Snapshot cycle is invalid.');
      }
      const members = capturedCycle.map((member) => {
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

  const warnings = captureArray(warningsValue, 'Snapshot warnings')
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
