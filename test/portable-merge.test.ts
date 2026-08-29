import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import {
  createGraph,
  type GraphSnapshotV1,
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

  it('compares normalized policies even when canonical fingerprints match', async () => {
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
