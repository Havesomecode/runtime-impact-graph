import { createHash, createHmac } from 'node:crypto';

import { compareCanonical } from './canonical.js';
import type {
  MetadataRule,
  MetadataSchema,
  MetadataValue,
  NodeV1,
  SnapshotMetadataPolicyV1,
} from './types.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const RULE_KEYS = new Set([
  'type',
  'mode',
  'maxDistinct',
  'maxStringLength',
  'redact',
]);

function assertRecord(value: unknown, name: string): asserts value is object {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain record.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain record.`);
  }
}

function capturedEntries(
  value: object,
  name: string,
): readonly (readonly [string, unknown])[] {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries: Array<readonly [string, unknown]> = [];
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') {
      throw new TypeError(`${name} must not contain symbol keys.`);
    }
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw new TypeError(
        `${name} must contain enumerable data properties only.`,
      );
    }
    entries.push([key, descriptor.value]);
  }
  return entries.sort(([left], [right]) => compareCanonical(left, right));
}

export function assertSafeMetadataKey(key: string): void {
  if (key.length === 0 || key.length > 64 || FORBIDDEN_KEYS.has(key)) {
    throw new TypeError(`Unsafe metadata key ${JSON.stringify(key)}.`);
  }
}

function normalizeRule(value: unknown, key: string): MetadataRule {
  const name = `Metadata rule ${JSON.stringify(key)}`;
  assertRecord(value, name);
  const entries = capturedEntries(value, name);
  for (const [property] of entries) {
    if (!RULE_KEYS.has(property)) {
      throw new TypeError(
        `Unknown metadata rule property ${JSON.stringify(property)}.`,
      );
    }
  }
  const rule = value as Record<string, unknown>;
  const ownProperties = new Set(entries.map(([property]) => property));
  const read = (property: string): unknown =>
    ownProperties.has(property) ? rule[property] : undefined;
  const type = read('type');
  const mode = read('mode');
  const maxDistinct = read('maxDistinct');
  const declaredMaxStringLength = read('maxStringLength');
  const declaredRedact = read('redact');
  if (type !== 'string' && type !== 'number' && type !== 'boolean') {
    throw new TypeError(`Invalid metadata type for ${JSON.stringify(key)}.`);
  }
  if (mode !== 'constant' && mode !== 'set') {
    throw new TypeError(`Invalid metadata mode for ${JSON.stringify(key)}.`);
  }
  if (
    mode === 'set' &&
    (typeof maxDistinct !== 'number' ||
      !Number.isSafeInteger(maxDistinct) ||
      maxDistinct < 1 ||
      maxDistinct > 32)
  ) {
    throw new TypeError(`Invalid maxDistinct for ${JSON.stringify(key)}.`);
  }
  if (mode === 'constant' && maxDistinct !== undefined) {
    throw new TypeError(`constant metadata cannot declare maxDistinct.`);
  }
  const maxStringLength = declaredMaxStringLength ?? 128;
  if (
    typeof maxStringLength !== 'number' ||
    !Number.isSafeInteger(maxStringLength) ||
    maxStringLength < 1 ||
    maxStringLength > 512
  ) {
    throw new TypeError(`Invalid maxStringLength for ${JSON.stringify(key)}.`);
  }
  const redact = declaredRedact ?? 'drop';
  if (
    redact !== 'none' &&
    redact !== 'drop' &&
    redact !== 'replace' &&
    redact !== 'sha256'
  ) {
    throw new TypeError(`Invalid redaction for ${JSON.stringify(key)}.`);
  }

  return Object.freeze({
    type,
    mode,
    ...(mode === 'set' ? { maxDistinct } : {}),
    maxStringLength,
    redact,
  } as MetadataRule);
}

export function normalizeMetadataSchema(
  schema: MetadataSchema,
): MetadataSchema {
  assertRecord(schema, 'metadataSchema');
  const normalized: Record<string, MetadataRule> = {};
  for (const [key, value] of capturedEntries(schema, 'metadataSchema')) {
    assertSafeMetadataKey(key);
    normalized[key] = normalizeRule(value, key);
  }
  return Object.freeze(normalized);
}

export function createSnapshotMetadataPolicy(
  schema: MetadataSchema,
  salt: string | undefined,
): SnapshotMetadataPolicyV1 {
  const usesSha256 = Object.values(schema).some(
    (rule) => rule.redact === 'sha256',
  );
  if (!usesSha256) return Object.freeze({ schema });
  if (salt === undefined || salt.length === 0) {
    throw new TypeError('A non-empty metadataSalt is required for sha256.');
  }
  return Object.freeze({
    schema,
    sha256SaltFingerprint: createHash('sha256')
      .update('runtime-impact-graph/metadata-salt/v0.1\0')
      .update(salt)
      .digest('hex'),
  });
}

export function fingerprintMetadataPolicy(
  policy: SnapshotMetadataPolicyV1,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        format: 'runtime-impact-graph/metadata-policy',
        version: '0.1',
        schema: policy.schema,
        ...(policy.sha256SaltFingerprint === undefined
          ? {}
          : { sha256SaltFingerprint: policy.sha256SaltFingerprint }),
      }),
    )
    .digest('hex');
}

function assertMetadataValue(
  value: unknown,
  rule: MetadataRule,
  key: string,
): asserts value is MetadataValue {
  if (
    typeof value !== rule.type ||
    (typeof value === 'number' &&
      (!Number.isFinite(value) || Object.is(value, -0))) ||
    (typeof value === 'string' && value.length > (rule.maxStringLength ?? 128))
  ) {
    throw new TypeError(
      `Invalid metadata value for key ${JSON.stringify(key)}.`,
    );
  }
}

function redactValue(
  value: MetadataValue,
  rule: MetadataRule,
  salt: string | undefined,
): MetadataValue | undefined {
  switch (rule.redact ?? 'drop') {
    case 'drop':
      return undefined;
    case 'replace':
      return '[REDACTED]';
    case 'sha256':
      if (salt === undefined || salt.length === 0) {
        throw new TypeError('A non-empty metadataSalt is required for sha256.');
      }
      return createHmac('sha256', salt)
        .update(JSON.stringify(value))
        .digest('hex');
    case 'none':
      return value;
  }
}

export function processMetadata(
  input: Readonly<Record<string, unknown>> | undefined,
  schema: MetadataSchema,
  salt: string | undefined,
): NodeV1['metadata'] {
  if (input === undefined) return Object.freeze({});
  assertRecord(input, 'metadata');
  capturedEntries(input, 'metadata');

  const output: Record<string, MetadataValue | readonly MetadataValue[]> = {};
  for (const [key, value] of Object.entries(input).sort(([left], [right]) =>
    compareCanonical(left, right),
  )) {
    assertSafeMetadataKey(key);
    const rule = schema[key];
    if (rule === undefined) {
      throw new TypeError(`Undeclared metadata key ${JSON.stringify(key)}.`);
    }
    assertMetadataValue(value, rule, key);
    const redacted = redactValue(value, rule, salt);
    if (redacted === undefined) continue;
    output[key] = rule.mode === 'set' ? Object.freeze([redacted]) : redacted;
  }
  return Object.freeze(output);
}

function assertSnapshotMetadataValue(
  value: MetadataValue,
  rule: MetadataRule,
  key: string,
): void {
  switch (rule.redact) {
    case 'drop':
      throw new TypeError(
        `Dropped metadata key ${JSON.stringify(key)} must not be present.`,
      );
    case 'replace':
      if (value !== '[REDACTED]') {
        throw new TypeError(
          `Invalid replaced metadata for key ${JSON.stringify(key)}.`,
        );
      }
      return;
    case 'sha256':
      if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
        throw new TypeError(
          `Invalid hashed metadata for key ${JSON.stringify(key)}.`,
        );
      }
      return;
    case 'none':
      assertMetadataValue(value, rule, key);
      return;
  }
}

export function validateSnapshotNodeMetadata(
  node: NodeV1,
  schema: MetadataSchema,
): void {
  for (const [key, value] of Object.entries(node.metadata)) {
    const rule = schema[key];
    if (rule === undefined) {
      throw new TypeError(`Undeclared metadata key ${JSON.stringify(key)}.`);
    }
    if (rule.mode === 'constant') {
      if (Array.isArray(value)) {
        throw new TypeError(
          `Invalid constant metadata for key ${JSON.stringify(key)}.`,
        );
      }
      assertSnapshotMetadataValue(value as MetadataValue, rule, key);
      continue;
    }
    if (!Array.isArray(value) || value.length > (rule.maxDistinct ?? 0)) {
      throw new TypeError(
        `Invalid set metadata for key ${JSON.stringify(key)}.`,
      );
    }
    for (const member of value as readonly MetadataValue[]) {
      assertSnapshotMetadataValue(member, rule, key);
    }
  }

  if (node.kind === 'custom') {
    const customKind = node.metadata.customKind;
    if (typeof customKind !== 'string' || customKind.length === 0) {
      throw new TypeError('Custom snapshot nodes require customKind metadata.');
    }
  }
}

function compareValues(left: MetadataValue, right: MetadataValue): number {
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

export function mergeMetadata(
  left: NodeV1['metadata'],
  right: NodeV1['metadata'],
  schema: MetadataSchema,
): NodeV1['metadata'] {
  const output: Record<string, MetadataValue | readonly MetadataValue[]> = {};
  for (const key of Object.keys(schema).sort(compareCanonical)) {
    const rule = schema[key];
    if (rule === undefined) continue;
    const leftValue = left[key];
    const rightValue = right[key];
    if (leftValue === undefined && rightValue === undefined) continue;
    if (leftValue === undefined) {
      output[key] = rightValue as MetadataValue | readonly MetadataValue[];
      continue;
    }
    if (rightValue === undefined) {
      output[key] = leftValue;
      continue;
    }
    if (rule.mode === 'constant') {
      if (
        Array.isArray(leftValue) ||
        Array.isArray(rightValue) ||
        !Object.is(leftValue, rightValue)
      ) {
        throw new TypeError(
          `Conflicting constant metadata for key ${JSON.stringify(key)}.`,
        );
      }
      output[key] = leftValue;
      continue;
    }
    if (!Array.isArray(leftValue) || !Array.isArray(rightValue)) {
      throw new TypeError(
        `Invalid set metadata for key ${JSON.stringify(key)}.`,
      );
    }
    const leftValues = leftValue as readonly MetadataValue[];
    const rightValues = rightValue as readonly MetadataValue[];
    const values = [...leftValues, ...rightValues].sort(compareValues);
    const deduplicated = values.filter(
      (value, index) => index === 0 || !Object.is(value, values[index - 1]),
    );
    if (deduplicated.length > (rule.maxDistinct ?? 0)) {
      throw new TypeError(
        `Metadata cardinality exceeded for key ${JSON.stringify(key)}.`,
      );
    }
    output[key] = Object.freeze(deduplicated);
  }
  return Object.freeze(output);
}
