import { createHash, createHmac } from 'node:crypto';

import { compareCanonical } from './canonical.js';
import type {
  MetadataRule,
  MetadataSchema,
  MetadataValue,
  NodeV1,
} from './types.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const REGISTERED_SCHEMAS = new Map<string, MetadataSchema>();
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
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${name} must not contain symbol keys.`);
  }
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!('value' in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(
        `${name} must contain enumerable data properties only.`,
      );
    }
  }
}

function sortedEntries(value: object): readonly (readonly [string, unknown])[] {
  return Object.entries(value).sort(([left], [right]) =>
    compareCanonical(left, right),
  );
}

function assertSafeKey(key: string): void {
  if (key.length === 0 || key.length > 64 || FORBIDDEN_KEYS.has(key)) {
    throw new TypeError(`Unsafe metadata key ${JSON.stringify(key)}.`);
  }
}

function normalizeRule(value: unknown, key: string): MetadataRule {
  assertRecord(value, `Metadata rule ${JSON.stringify(key)}`);
  for (const property of Object.keys(value)) {
    if (!RULE_KEYS.has(property)) {
      throw new TypeError(
        `Unknown metadata rule property ${JSON.stringify(property)}.`,
      );
    }
  }
  const rule = value as Partial<MetadataRule>;
  if (!['string', 'number', 'boolean'].includes(String(rule.type))) {
    throw new TypeError(`Invalid metadata type for ${JSON.stringify(key)}.`);
  }
  if (rule.mode !== 'constant' && rule.mode !== 'set') {
    throw new TypeError(`Invalid metadata mode for ${JSON.stringify(key)}.`);
  }
  if (
    rule.mode === 'set' &&
    (!Number.isSafeInteger(rule.maxDistinct) ||
      (rule.maxDistinct ?? 0) < 1 ||
      (rule.maxDistinct ?? 0) > 32)
  ) {
    throw new TypeError(`Invalid maxDistinct for ${JSON.stringify(key)}.`);
  }
  if (rule.mode === 'constant' && rule.maxDistinct !== undefined) {
    throw new TypeError(`constant metadata cannot declare maxDistinct.`);
  }
  const maxStringLength = rule.maxStringLength ?? 128;
  if (
    !Number.isSafeInteger(maxStringLength) ||
    maxStringLength < 1 ||
    maxStringLength > 512
  ) {
    throw new TypeError(`Invalid maxStringLength for ${JSON.stringify(key)}.`);
  }
  const redact = rule.redact ?? 'drop';
  if (!['none', 'drop', 'replace', 'sha256'].includes(redact)) {
    throw new TypeError(`Invalid redaction for ${JSON.stringify(key)}.`);
  }

  return {
    type: rule.type,
    mode: rule.mode,
    ...(rule.mode === 'set' ? { maxDistinct: rule.maxDistinct } : {}),
    maxStringLength,
    redact,
  } as MetadataRule;
}

export function normalizeMetadataSchema(
  schema: MetadataSchema,
): MetadataSchema {
  assertRecord(schema, 'metadataSchema');
  const normalized: Record<string, MetadataRule> = {};
  for (const [key, value] of sortedEntries(schema)) {
    assertSafeKey(key);
    normalized[key] = normalizeRule(value, key);
  }
  return Object.freeze(normalized);
}

export function fingerprintMetadataSchema(schema: MetadataSchema): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        format: 'runtime-impact-graph/metadata-policy',
        version: '0.1',
        schema,
      }),
    )
    .digest('hex');
}

export function registerMetadataSchema(schema: MetadataSchema): string {
  const fingerprint = fingerprintMetadataSchema(schema);
  REGISTERED_SCHEMAS.set(fingerprint, schema);
  return fingerprint;
}

export function registeredMetadataSchema(
  fingerprint: string,
): MetadataSchema | undefined {
  return REGISTERED_SCHEMAS.get(fingerprint);
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

  const output: Record<string, MetadataValue | readonly MetadataValue[]> = {};
  for (const [key, value] of sortedEntries(input)) {
    assertSafeKey(key);
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
