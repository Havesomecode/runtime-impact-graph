import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  createGraph,
  toCanonicalJson,
  type GraphSnapshotV1,
  type MetadataRule,
  type MetadataValue,
  type NodeV1,
} from '../src/index.js';

const sourceEntry = new URL('../src/index.ts', import.meta.url).href;

function snapshotWithTag(tag: string) {
  const graph = createGraph({
    metadataSchema: {
      tags: {
        type: 'string',
        mode: 'set',
        maxDistinct: 2,
        redact: 'none',
      },
    },
  });
  graph.run(() => {
    graph.observe({
      id: 'shared',
      kind: 'resource',
      label: 'Shared',
      metadata: { tags: tag },
    });
  });
  return graph.snapshot();
}

function replaceFirstNode(
  snapshot: GraphSnapshotV1,
  updates: Partial<NodeV1>,
): GraphSnapshotV1 {
  const node = snapshot.nodes[0];
  assert.ok(node);
  return {
    ...snapshot,
    nodes: [{ ...node, ...updates }, ...snapshot.nodes.slice(1)],
  };
}

function adversarialSnapshot(): GraphSnapshotV1 {
  const graph = createGraph({
    metadataSchema: {},
    maxEdges: 2,
    onLimit: 'drop',
  });
  graph.run(() => {
    graph.observe({ id: 'a', kind: 'resource', label: 'A' });
    graph.observe({ id: 'b', kind: 'resource', label: 'B' });
    graph.dependsOn('a', 'b');
    graph.dependsOn('b', 'a');
    graph.dependsOn('a', 'a');
  });
  const snapshot = graph.snapshot();
  assert.equal(snapshot.nodes.length, 2);
  assert.equal(snapshot.edges.length, 2);
  assert.equal(snapshot.cycles.length, 1);
  assert.equal(snapshot.warnings.length, 1);
  return snapshot;
}

function assertSelfValidating(snapshot: GraphSnapshotV1): void {
  const json = toCanonicalJson(snapshot);
  assert.equal(toCanonicalJson(JSON.parse(json) as GraphSnapshotV1), json);
}

function changingField<T extends object>(
  target: T,
  field: PropertyKey,
  laterValue: unknown,
): { readonly proxy: T; readonly reads: () => number } {
  let reads = 0;
  return {
    proxy: new Proxy(target, {
      get: (currentTarget, property, receiver): unknown => {
        if (property === field) {
          reads += 1;
          if (reads > 1) return laterValue;
        }
        return Reflect.get(currentTarget, property, receiver);
      },
    }),
    reads: () => reads,
  };
}

describe('portable snapshot merge', () => {
  it('merges set metadata in a process that never created either graph', () => {
    const childScript = `
      import { readFileSync } from 'node:fs';
      import { mergeSnapshots } from ${JSON.stringify(sourceEntry)};
      const snapshots = JSON.parse(readFileSync(0, 'utf8'));
      process.stdout.write(JSON.stringify(mergeSnapshots(snapshots)));
    `;

    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', childScript],
      {
        cwd: new URL('..', import.meta.url),
        encoding: 'utf8',
        input: JSON.stringify([snapshotWithTag('a'), snapshotWithTag('b')]),
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const merged = JSON.parse(result.stdout) as {
      nodes: Array<{ metadata: { tags: string[] } }>;
    };
    assert.deepEqual(merged.nodes[0]?.metadata.tags, ['a', 'b']);
  });

  it('does not expose mutable policy state from a graph snapshot', () => {
    const graph = createGraph({
      metadataSchema: {
        tags: {
          type: 'string',
          mode: 'set',
          maxDistinct: 2,
          redact: 'none',
        },
      },
    });
    const rule = graph.snapshot().metadataPolicy.schema.tags;
    assert.ok(rule);

    assert.throws(() => {
      (rule as { maxDistinct: number }).maxDistinct = 32;
    }, TypeError);
    assert.equal(graph.snapshot().metadataPolicy.schema.tags?.maxDistinct, 2);
  });

  it('binds sha256 policies to non-exported salt identities', async () => {
    const { mergeSnapshots } = await import('../src/index.js');
    const makeSnapshot = (metadataSalt: string) => {
      const graph = createGraph({
        metadataSalt,
        metadataSchema: {
          secret: {
            type: 'string',
            mode: 'constant',
            redact: 'sha256',
          },
        },
      });
      graph.run(() => {
        graph.observe({
          id: 'shared',
          kind: 'resource',
          label: 'Shared',
          metadata: { secret: 'same-value' },
        });
      });
      return graph.snapshot();
    };

    const first = makeSnapshot('salt-one');
    const second = makeSnapshot('salt-two');

    assert.notEqual(first.schemaFingerprint, second.schemaFingerprint);
    assert.throws(() => mergeSnapshots([first, second]), /incompatible/u);
    assert.doesNotMatch(JSON.stringify(first), /salt-one/u);
    assert.doesNotMatch(JSON.stringify(second), /salt-two/u);
  });

  it('rejects differing policies before a proxy can forge matching fingerprints', async () => {
    const { mergeSnapshots } = await import('../src/index.js');
    const first = createGraph({
      metadataSchema: {
        first: { type: 'string', mode: 'constant', redact: 'none' },
      },
    }).snapshot();
    const second = createGraph({
      metadataSchema: {
        second: { type: 'string', mode: 'constant', redact: 'none' },
      },
    }).snapshot();
    const forgedFingerprint = '0'.repeat(64);
    const forgeCanonicalFingerprint = (
      snapshot: GraphSnapshotV1,
    ): GraphSnapshotV1 => {
      let reads = 0;
      return new Proxy(snapshot, {
        get: (target, property, receiver): unknown => {
          if (property === 'schemaFingerprint') {
            reads += 1;
            return reads <= 3 ? snapshot.schemaFingerprint : forgedFingerprint;
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
    };

    assert.throws(
      () =>
        mergeSnapshots([
          forgeCanonicalFingerprint(first),
          forgeCanonicalFingerprint(second),
        ]),
      /incompatible/u,
    );
  });

  it('rejects malformed and policy-mismatched snapshot fingerprints', async () => {
    const { mergeSnapshots } = await import('../src/index.js');
    const snapshot = createGraph({ metadataSchema: {} }).snapshot();

    assert.throws(
      () => mergeSnapshots([{ ...snapshot, schemaFingerprint: '' }]),
      /envelope is invalid/u,
    );
    assert.throws(
      () =>
        mergeSnapshots([{ ...snapshot, schemaFingerprint: '0'.repeat(64) }]),
      /policy fingerprint is invalid/u,
    );
  });

  it('captures a snapshot fingerprint once before validation', async () => {
    const { mergeSnapshots } = await import('../src/index.js');
    const snapshot = createGraph({ metadataSchema: {} }).snapshot();
    let reads = 0;
    const changingFingerprint = new Proxy(snapshot, {
      get: (target, property, receiver): unknown => {
        if (property === 'schemaFingerprint') {
          reads += 1;
          return reads === 1 ? snapshot.schemaFingerprint : 'invalid';
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const merged = mergeSnapshots([changingFingerprint]);

    assert.equal(reads, 1);
    assert.equal(merged.schemaFingerprint, snapshot.schemaFingerprint);
  });

  for (const [field, laterValue] of [
    ['format', 'forged-format'],
    ['schemaFingerprint', 'forged-fingerprint'],
    ['metadataPolicy', null],
    ['nodes', { map: () => [{ id: 'forged' }] }],
    ['edges', { map: () => [{ kind: 'forged' }] }],
    ['cycles', { map: () => [['forged']] }],
    ['warnings', { map: () => [{ code: 'forged-warning', count: 0 }] }],
  ] as const) {
    it(`captures snapshot envelope ${field} once`, () => {
      const snapshot = adversarialSnapshot();
      const changing = changingField(snapshot, field, laterValue);

      assertSelfValidating(changing.proxy);

      assert.equal(changing.reads(), 1);
    });
  }

  for (const [field, laterValue] of [
    ['id', 'forged\0id'],
    ['kind', 'forged-kind'],
    ['label', ''],
    ['metadata', { undeclared: 'forged' }],
    ['observations', 0],
  ] as const) {
    it(`captures snapshot node ${field} once`, () => {
      const snapshot = adversarialSnapshot();
      const node = snapshot.nodes[0];
      assert.ok(node);
      const changing = changingField(node, field, laterValue);
      const input = {
        ...snapshot,
        nodes: [changing.proxy, ...snapshot.nodes.slice(1)],
      };

      assertSelfValidating(input);

      assert.equal(changing.reads(), 1);
    });
  }

  for (const [field, laterValue] of [
    ['from', 'unknown'],
    ['to', 'unknown'],
    ['kind', 'forged-kind'],
    ['observations', 0],
  ] as const) {
    it(`captures snapshot edge ${field} once`, () => {
      const snapshot = adversarialSnapshot();
      const edge = snapshot.edges[0];
      assert.ok(edge);
      const changing = changingField(edge, field, laterValue);
      const input = {
        ...snapshot,
        edges: [changing.proxy, ...snapshot.edges.slice(1)],
      };

      assertSelfValidating(input);

      assert.equal(changing.reads(), 1);
    });
  }

  for (const [field, laterValue] of [
    ['code', 'forged-warning'],
    ['count', 0],
  ] as const) {
    it(`captures snapshot warning ${field} once`, () => {
      const snapshot = adversarialSnapshot();
      const warning = snapshot.warnings[0];
      assert.ok(warning);
      const changing = changingField(warning, field, laterValue);
      const input = { ...snapshot, warnings: [changing.proxy] };

      assertSelfValidating(input);

      assert.equal(changing.reads(), 1);
    });
  }

  it('does not invoke attacker-controlled map methods on snapshot arrays', () => {
    const snapshot = adversarialSnapshot();
    const cycle = snapshot.cycles[0];
    assert.ok(cycle);
    let invocations = 0;
    const proxiedCycle = new Proxy(cycle, {
      get: (target, property, receiver): unknown => {
        if (property === 'map') {
          return (): readonly string[] => {
            invocations += 1;
            return [...cycle];
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    assertSelfValidating({ ...snapshot, cycles: [proxiedCycle] });

    assert.equal(invocations, 0);
  });

  it('captures every snapshot metadata rule field once', () => {
    const graph = createGraph({
      metadataSchema: {
        tag: {
          type: 'string',
          mode: 'set',
          maxDistinct: 2,
          maxStringLength: 16,
          redact: 'none',
        },
      },
    });
    const snapshot = graph.snapshot();
    const rule = snapshot.metadataPolicy.schema.tag;
    assert.ok(rule);
    const replacements = {
      type: 'forged-type',
      mode: 'forged-mode',
      maxDistinct: 0,
      maxStringLength: 0,
      redact: 'forged-redaction',
    } as const;

    for (const field of Object.keys(replacements) as Array<
      keyof typeof replacements
    >) {
      const changing: {
        readonly proxy: MetadataRule;
        readonly reads: () => number;
      } = changingField<MetadataRule>({ ...rule }, field, replacements[field]);
      const input = {
        ...snapshot,
        metadataPolicy: {
          ...snapshot.metadataPolicy,
          schema: { tag: changing.proxy },
        },
      };

      assertSelfValidating(input);
      assert.equal(changing.reads(), 1, field);
    }
  });

  it('rejects accessor-backed nested records without invoking getters or mutating input', () => {
    const snapshot = adversarialSnapshot();
    const cases = [
      { collection: 'nodes', value: snapshot.nodes[0], field: 'id' },
      { collection: 'edges', value: snapshot.edges[0], field: 'from' },
      { collection: 'warnings', value: snapshot.warnings[0], field: 'code' },
    ] as const;

    for (const testCase of cases) {
      assert.ok(testCase.value);
      const record = { ...testCase.value } as Record<string, unknown>;
      let reads = 0;
      Object.defineProperty(record, testCase.field, {
        enumerable: true,
        get: () => {
          reads += 1;
          return undefined;
        },
      });
      const before = Object.getOwnPropertyDescriptors(record);
      const input = {
        ...snapshot,
        [testCase.collection]: [record],
      } as GraphSnapshotV1;

      assert.throws(() => toCanonicalJson(input), /data properties/u);
      assert.equal(reads, 0);
      assert.deepEqual(Object.getOwnPropertyDescriptors(record), before);
    }
  });

  it('rejects accessor-backed snapshot array elements without invoking getters', () => {
    const snapshot = adversarialSnapshot();

    for (const collection of [
      'nodes',
      'edges',
      'cycles',
      'warnings',
    ] as const) {
      const values = [...snapshot[collection]];
      const original = values[0];
      assert.ok(original);
      let reads = 0;
      Object.defineProperty(values, 0, {
        configurable: true,
        enumerable: true,
        get: () => {
          reads += 1;
          return original;
        },
      });
      const before = Object.getOwnPropertyDescriptors(values);

      assert.throws(
        () => toCanonicalJson({ ...snapshot, [collection]: values }),
        /data properties/u,
      );
      assert.equal(reads, 0, collection);
      assert.deepEqual(Object.getOwnPropertyDescriptors(values), before);
    }

    const cycle = [...(snapshot.cycles[0] ?? [])];
    const member = cycle[0];
    assert.ok(member);
    let memberReads = 0;
    Object.defineProperty(cycle, 0, {
      configurable: true,
      enumerable: true,
      get: () => {
        memberReads += 1;
        return member;
      },
    });

    assert.throws(
      () => toCanonicalJson({ ...snapshot, cycles: [cycle] }),
      /data properties/u,
    );
    assert.equal(memberReads, 0);
  });

  it('ignores a Proxy-controlled array length getter', () => {
    const snapshot = createGraph({ metadataSchema: {} }).snapshot();
    let reads = 0;
    const nodes = new Proxy([...snapshot.nodes], {
      get: (target, property, receiver): unknown => {
        if (property === 'length') {
          reads += 1;
          return Number.NaN;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    assertSelfValidating({ ...snapshot, nodes });
    assert.equal(reads, 0);
  });

  it('rejects metadata rule types that only coerce to a valid type', () => {
    const graph = createGraph({
      metadataSchema: {
        tag: { type: 'string', mode: 'constant', redact: 'none' },
      },
    });
    const snapshot = graph.snapshot();
    const rule = snapshot.metadataPolicy.schema.tag;
    assert.ok(rule);
    const invalidType = { toString: () => 'string' };
    const metadataPolicy = {
      schema: { tag: { ...rule, type: invalidType } },
    } as unknown as GraphSnapshotV1['metadataPolicy'];
    const schemaFingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          format: 'runtime-impact-graph/metadata-policy',
          version: '0.1',
          schema: metadataPolicy.schema,
        }),
      )
      .digest('hex');

    assert.throws(
      () => toCanonicalJson({ ...snapshot, metadataPolicy, schemaFingerprint }),
      /Invalid metadata type/u,
    );
  });

  it('captures a record prototype once before validating it', () => {
    const snapshot = adversarialSnapshot();
    const node = snapshot.nodes[0];
    assert.ok(node);
    let reads = 0;
    const changingPrototype = new Proxy(
      { ...node },
      {
        getPrototypeOf: () => {
          reads += 1;
          return reads === 1 ? { forged: true } : null;
        },
      },
    );

    assert.throws(
      () =>
        toCanonicalJson({
          ...snapshot,
          nodes: [changingPrototype, ...snapshot.nodes.slice(1)],
        }),
      /plain object/u,
    );
    assert.equal(reads, 1);
  });

  it('captures nested record keys once before validating fields', () => {
    const snapshot = adversarialSnapshot();
    const node = snapshot.nodes[0];
    assert.ok(node);
    const forged = Symbol('forged');
    let ownKeysCalls = 0;
    const changingKeys = new Proxy(
      { ...node },
      {
        ownKeys: (target) => {
          ownKeysCalls += 1;
          const keys = Reflect.ownKeys(target);
          return ownKeysCalls === 1 ? keys : [...keys, forged];
        },
      },
    );

    assertSelfValidating({
      ...snapshot,
      nodes: [changingKeys, ...snapshot.nodes.slice(1)],
    });
    assert.equal(ownKeysCalls, 1);
  });

  it('captures metadata rule keys once before validating fields', () => {
    const graph = createGraph({
      metadataSchema: {
        tag: { type: 'string', mode: 'constant', redact: 'none' },
      },
    });
    const snapshot = graph.snapshot();
    const rule = snapshot.metadataPolicy.schema.tag;
    assert.ok(rule);
    const forged = Symbol('forged');
    let ownKeysCalls = 0;
    const changingKeys = new Proxy(
      { ...rule },
      {
        ownKeys: (target) => {
          ownKeysCalls += 1;
          const keys = Reflect.ownKeys(target);
          return ownKeysCalls === 1 ? keys : [...keys, forged];
        },
      },
    );

    assertSelfValidating({
      ...snapshot,
      metadataPolicy: {
        schema: { tag: changingKeys },
      },
    });
    assert.equal(ownKeysCalls, 1);
  });

  it('rejects required snapshot fields supplied only by a Proxy get trap', () => {
    const snapshot = adversarialSnapshot();
    const node = snapshot.nodes[0];
    assert.ok(node);
    const withoutId = Object.fromEntries(
      Object.entries(node).filter(([property]) => property !== 'id'),
    );
    let reads = 0;
    const inheritedId = new Proxy(withoutId, {
      get: (target, property, receiver): unknown => {
        if (property === 'id') {
          reads += 1;
          return node.id;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    assert.throws(
      () =>
        toCanonicalJson({
          ...snapshot,
          nodes: [inheritedId, ...snapshot.nodes.slice(1)],
        } as GraphSnapshotV1),
      /Snapshot node is invalid/u,
    );
    assert.equal(reads, 0);
  });

  it('rejects metadata rule fields supplied only by a Proxy get trap', () => {
    const graph = createGraph({
      metadataSchema: {
        tag: { type: 'string', mode: 'constant', redact: 'none' },
      },
    });
    const snapshot = graph.snapshot();
    const rule = snapshot.metadataPolicy.schema.tag;
    assert.ok(rule);
    const withoutType = Object.fromEntries(
      Object.entries(rule).filter(([property]) => property !== 'type'),
    );
    let reads = 0;
    const inheritedType = new Proxy(withoutType, {
      get: (target, property, receiver): unknown => {
        if (property === 'type') {
          reads += 1;
          return rule.type;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    assert.throws(
      () =>
        toCanonicalJson({
          ...snapshot,
          metadataPolicy: { schema: { tag: inheritedType } },
        } as unknown as GraphSnapshotV1),
      /Invalid metadata type/u,
    );
    assert.equal(reads, 0);
  });

  it('aborts count-overflow merges without mutating any input snapshot', async () => {
    const { CountOverflowError, mergeSnapshots } =
      await import('../src/index.js');
    const graph = createGraph({ metadataSchema: {} });
    graph.run(() => {
      graph.observe({ id: 'a', kind: 'resource', label: 'A' });
      graph.observe({ id: 'z', kind: 'resource', label: 'Z' });
    });
    const base = graph.snapshot();
    const first: GraphSnapshotV1 = {
      ...base,
      nodes: base.nodes.map((node, index) => ({
        ...node,
        observations: index === 1 ? Number.MAX_SAFE_INTEGER : node.observations,
      })),
    };
    const second = structuredClone(base);
    const firstBefore = structuredClone(first);
    const secondBefore = structuredClone(second);

    assert.throws(() => mergeSnapshots([first, second]), CountOverflowError);
    assert.deepEqual(first, firstBefore);
    assert.deepEqual(second, secondBefore);
  });

  it('rejects custom nodes whose policy drops their required kind', () => {
    const graph = createGraph({
      metadataSchema: {
        customKind: { type: 'string', mode: 'constant', redact: 'drop' },
      },
    });

    assert.throws(
      () =>
        graph.run(() => {
          graph.observe({
            id: 'custom',
            kind: 'custom',
            label: 'Custom',
            metadata: { customKind: 'plugin' },
          });
        }),
      /customKind/u,
    );
    assert.deepEqual(graph.snapshot().nodes, []);
  });

  it('rejects set-valued customKind at runtime and snapshot boundaries', async () => {
    const { mergeSnapshots } = await import('../src/index.js');
    const graph = createGraph({
      metadataSchema: {
        customKind: {
          type: 'string',
          mode: 'set',
          maxDistinct: 2,
          redact: 'none',
        },
      },
    });

    assert.throws(() => {
      graph.run(() => {
        graph.observe({
          id: 'custom',
          kind: 'custom',
          label: 'Custom',
          metadata: { customKind: 'plugin' },
        });
      });
    }, /customKind/u);
    assert.deepEqual(graph.snapshot().nodes, []);

    const resource = createGraph({
      metadataSchema: {
        customKind: {
          type: 'string',
          mode: 'set',
          maxDistinct: 2,
          redact: 'none',
        },
      },
    });
    resource.run(() => {
      resource.observe({
        id: 'custom',
        kind: 'resource',
        label: 'Custom',
        metadata: { customKind: 'plugin' },
      });
    });
    const malformed = replaceFirstNode(resource.snapshot(), { kind: 'custom' });

    assert.throws(() => mergeSnapshots([malformed]), /customKind/u);
    assert.throws(
      () => mergeSnapshots([resource.snapshot(), malformed]),
      /customKind/u,
    );
  });

  it('rejects accessor properties before canonical merge construction', async () => {
    const { mergeSnapshots } = await import('../src/index.js');
    const graph = createGraph({ metadataSchema: {} });
    graph.run(() => {
      graph.observe({ id: 'a', kind: 'resource', label: 'A' });
      graph.observe({ id: 'b', kind: 'resource', label: 'B' });
    });
    const snapshot = graph.snapshot();
    const edge: Record<string, unknown> = {
      from: 'a',
      to: 'b',
      observations: 1,
    };
    let reads = 0;
    Object.defineProperty(edge, 'kind', {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads <= 2 ? 'dependsOn' : 'forged-kind';
      },
    });
    const metadata: Record<string, unknown> = {};
    let metadataReads = 0;
    Object.defineProperty(metadata, 'unsafe', {
      enumerable: true,
      get: () => {
        metadataReads += 1;
        return 'value';
      },
    });

    assert.throws(
      () =>
        mergeSnapshots([
          {
            ...snapshot,
            edges: [edge as unknown as GraphSnapshotV1['edges'][number]],
          },
        ]),
      /data properties/u,
    );
    assert.throws(
      () =>
        mergeSnapshots([
          replaceFirstNode(snapshot, {
            metadata: metadata as NodeV1['metadata'],
          }),
        ]),
      /data properties/u,
    );
    assert.equal(metadataReads, 0);
  });

  it('rejects own forbidden metadata keys in singleton and multi-snapshot merges', async () => {
    const { mergeSnapshots } = await import('../src/index.js');
    const graph = createGraph({ metadataSchema: {} });
    graph.run(() => {
      graph.observe({ id: 'safe', kind: 'resource', label: 'Safe' });
    });
    const snapshot = graph.snapshot();

    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const metadata = JSON.parse(
        `{"${key}":"forbidden"}`,
      ) as NodeV1['metadata'];
      assert.equal(Object.hasOwn(metadata, key), true);
      const malformed = replaceFirstNode(snapshot, { metadata });

      assert.throws(() => mergeSnapshots([malformed]), TypeError);
      assert.throws(() => mergeSnapshots([snapshot, malformed]), TypeError);
    }
  });

  it('rejects unknown snapshot envelope properties at every level', async () => {
    const { mergeSnapshots } = await import('../src/index.js');
    const graph = createGraph({
      metadataSchema: {},
      maxEdges: 0,
      onLimit: 'drop',
    });
    graph.run(() => {
      graph.observe({ id: 'a', kind: 'resource', label: 'A' });
      graph.observe({ id: 'b', kind: 'resource', label: 'B' });
      graph.dependsOn('a', 'b');
    });
    const snapshot = graph.snapshot();
    const node = snapshot.nodes[0];
    const warning = snapshot.warnings[0];
    assert.ok(node);
    assert.ok(warning);
    const edge = {
      from: 'a',
      to: 'b',
      kind: 'dependsOn' as const,
      observations: 1,
    };
    const withEdge = { ...snapshot, edges: [edge] };
    const withHiddenExtra = { ...snapshot };
    Object.defineProperty(withHiddenExtra, 'extra', { value: true });
    const malformedSnapshots = [
      { ...snapshot, extra: true },
      withHiddenExtra,
      {
        ...snapshot,
        metadataPolicy: { ...snapshot.metadataPolicy, extra: true },
      },
      {
        ...snapshot,
        nodes: [{ ...node, extra: true }, ...snapshot.nodes.slice(1)],
      },
      { ...withEdge, edges: [{ ...edge, extra: true }] },
      { ...snapshot, warnings: [{ ...warning, extra: true }] },
    ];

    for (const malformed of malformedSnapshots) {
      assert.throws(() => mergeSnapshots([malformed]), TypeError);
    }
  });

  it('requires cycles to exactly project the dependency edges', async () => {
    const { mergeSnapshots, toCanonicalJson, toDot } =
      await import('../src/index.js');
    const cyclic = createGraph({ metadataSchema: {} });
    cyclic.run(() => {
      cyclic.observe({ id: 'a', kind: 'resource', label: 'A' });
      cyclic.observe({ id: 'b', kind: 'resource', label: 'B' });
      cyclic.dependsOn('a', 'b');
      cyclic.dependsOn('b', 'a');
    });
    const acyclic = createGraph({ metadataSchema: {} });
    acyclic.run(() => {
      acyclic.observe({ id: 'a', kind: 'resource', label: 'A' });
    });

    const selfLoopWithOmittedCycle: GraphSnapshotV1 = {
      ...acyclic.snapshot(),
      edges: [{ from: 'a', to: 'a', kind: 'dependsOn', observations: 1 }],
      cycles: [],
    };
    const malformedSnapshots: readonly GraphSnapshotV1[] = [
      { ...cyclic.snapshot(), cycles: [] },
      { ...cyclic.snapshot(), cycles: [['a']] },
      { ...acyclic.snapshot(), cycles: [['a']] },
      selfLoopWithOmittedCycle,
    ];

    for (const malformed of malformedSnapshots) {
      assert.throws(() => toCanonicalJson(malformed), TypeError);
      assert.throws(() => toDot(malformed), TypeError);
      assert.throws(() => mergeSnapshots([malformed]), TypeError);
    }
  });

  it('identifies duplicate canonical cycles precisely', async () => {
    const { mergeSnapshots } = await import('../src/index.js');
    const graph = createGraph({ metadataSchema: {} });
    graph.run(() => {
      graph.observe({ id: 'a', kind: 'resource', label: 'A' });
      graph.observe({ id: 'b', kind: 'resource', label: 'B' });
      graph.dependsOn('a', 'b');
      graph.dependsOn('b', 'a');
    });
    const snapshot = graph.snapshot();
    const cycle = snapshot.cycles[0];
    assert.ok(cycle);

    assert.throws(
      () => mergeSnapshots([{ ...snapshot, cycles: [cycle, [...cycle]] }]),
      /Duplicate snapshot cycle/u,
    );
  });

  it('rejects containment cycles during snapshot canonicalization', async () => {
    const { mergeSnapshots, toCanonicalJson } = await import('../src/index.js');
    const graph = createGraph({ metadataSchema: {} });
    graph.run(() => {
      graph.observe({ id: 'a', kind: 'resource', label: 'A' });
      graph.observe({ id: 'b', kind: 'resource', label: 'B' });
    });
    const snapshot = graph.snapshot();
    const malformed: GraphSnapshotV1 = {
      ...snapshot,
      edges: [
        { from: 'a', to: 'b', kind: 'contains', observations: 1 },
        { from: 'b', to: 'a', kind: 'contains', observations: 1 },
      ],
    };

    assert.throws(() => toCanonicalJson(malformed), TypeError);
    assert.throws(() => mergeSnapshots([malformed]), TypeError);
  });

  it('rejects policy-invalid metadata in a singleton snapshot', async () => {
    const { mergeSnapshots } = await import('../src/index.js');
    const graph = createGraph({
      metadataSalt: 'fixture-salt',
      metadataSchema: {
        customKind: {
          type: 'string',
          mode: 'constant',
          redact: 'none',
        },
        dropped: { type: 'string', mode: 'constant', redact: 'drop' },
        hashed: { type: 'string', mode: 'constant', redact: 'sha256' },
        plain: {
          type: 'string',
          mode: 'constant',
          maxStringLength: 4,
          redact: 'none',
        },
        replaced: { type: 'number', mode: 'constant', redact: 'replace' },
        tags: {
          type: 'string',
          mode: 'set',
          maxDistinct: 2,
          redact: 'none',
        },
      },
    });
    graph.run(() => {
      graph.observe({
        id: 'shared',
        kind: 'resource',
        label: 'Shared',
        metadata: {
          dropped: 'removed',
          hashed: 'secret',
          plain: 'okay',
          replaced: 7,
          tags: 'a',
        },
      });
    });
    const snapshot = graph.snapshot();
    const numericCustomKindGraph = createGraph({
      metadataSchema: {
        customKind: { type: 'number', mode: 'constant', redact: 'none' },
      },
    });
    numericCustomKindGraph.run(() => {
      numericCustomKindGraph.observe({
        id: 'numeric-custom-kind',
        kind: 'resource',
        label: 'Numeric custom kind',
        metadata: { customKind: 7 },
      });
    });
    const numericCustomKind = replaceFirstNode(
      numericCustomKindGraph.snapshot(),
      { kind: 'custom' },
    );
    const mutateMetadata = (
      key: string,
      value: MetadataValue | readonly MetadataValue[],
    ) => {
      const node = snapshot.nodes[0];
      assert.ok(node);
      return replaceFirstNode(snapshot, {
        metadata: { ...node.metadata, [key]: value },
      });
    };
    const malformedSnapshots = [
      mutateMetadata('undeclared', 'value'),
      mutateMetadata('plain', ['okay']),
      mutateMetadata('tags', 'a'),
      mutateMetadata('plain', 7),
      mutateMetadata('plain', 'abcde'),
      mutateMetadata('dropped', 'removed'),
      mutateMetadata('replaced', 7),
      mutateMetadata('hashed', 'not-a-digest'),
      mutateMetadata('tags', ['a', 'b', 'c']),
      numericCustomKind,
      (() => {
        const node = snapshot.nodes[0];
        assert.ok(node);
        const metadata = Object.fromEntries(
          Object.entries(node.metadata).filter(([key]) => key !== 'customKind'),
        ) as NodeV1['metadata'];
        return replaceFirstNode(snapshot, { kind: 'custom', metadata });
      })(),
    ];

    for (const malformed of malformedSnapshots) {
      assert.throws(() => mergeSnapshots([malformed]), TypeError);
    }
  });
});
