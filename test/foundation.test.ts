import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createGraph,
  ContainmentCycleError,
  CountOverflowError,
  mergeSnapshots,
  NoActiveExecutionError,
  toCanonicalJson,
  toDot,
} from '../src/index.js';
import { setGraphCountsForTest } from '../src/runtime/graph.js';

describe('package foundation', () => {
  it('creates a versioned deterministic empty snapshot', () => {
    const graph = createGraph({ metadataSchema: {} });

    const snapshot = graph.snapshot();

    assert.equal(snapshot.format, 'runtime-impact-graph/v0.1');
    assert.match(snapshot.schemaFingerprint, /^[0-9a-f]{64}$/u);
    assert.deepEqual(snapshot.nodes, []);
    assert.deepEqual(snapshot.edges, []);
    assert.deepEqual(snapshot.cycles, []);
    assert.deepEqual(snapshot.warnings, []);
    assert.equal(toCanonicalJson(snapshot), `${JSON.stringify(snapshot)}\n`);
  });

  it('canonicalizes equivalent snapshot order before serialization', () => {
    const graph = createGraph({ metadataSchema: {} });
    graph.run(() => {
      graph.observe({ id: 'b', kind: 'resource', label: 'B' });
      graph.observe({ id: 'a', kind: 'resource', label: 'A' });
    });
    const sorted = graph.snapshot();
    const reversed = { ...sorted, nodes: [...sorted.nodes].reverse() };

    assert.equal(toCanonicalJson(reversed), toCanonicalJson(sorted));
  });

  it('rejects non-finite metadata during serialization', () => {
    const graph = createGraph({ metadataSchema: {} });
    const snapshot = graph.snapshot();
    const malformed = {
      ...snapshot,
      nodes: [
        {
          id: 'bad',
          kind: 'resource',
          label: 'Bad',
          metadata: { value: Number.NaN },
          observations: 1,
        },
      ],
    };

    assert.throws(() => toCanonicalJson(malformed as never), TypeError);
  });

  it('records semantic nodes and containment inside an execution root', async () => {
    const graph = createGraph({ metadataSchema: {} });

    await graph.run(async () => {
      await graph.withNode(
        { id: 'route:home', kind: 'route', label: 'Home', metadata: {} },
        async () => {
          graph.observe({
            id: 'loader:settings',
            kind: 'loader',
            label: 'Settings loader',
            metadata: {},
          });
          await graph.withNode(
            {
              id: 'capability:greeting',
              kind: 'capability',
              label: 'Greeting',
              metadata: {},
            },
            async () => Promise.resolve(),
          );
        },
      );
    });

    assert.deepEqual(graph.snapshot().nodes, [
      {
        id: 'capability:greeting',
        kind: 'capability',
        label: 'Greeting',
        metadata: {},
        observations: 1,
      },
      {
        id: 'loader:settings',
        kind: 'loader',
        label: 'Settings loader',
        metadata: {},
        observations: 1,
      },
      {
        id: 'route:home',
        kind: 'route',
        label: 'Home',
        metadata: {},
        observations: 1,
      },
    ]);
    assert.deepEqual(graph.snapshot().edges, [
      {
        from: 'route:home',
        to: 'capability:greeting',
        kind: 'contains',
        observations: 1,
      },
    ]);
  });

  it('rejects observations outside an active execution without mutation', () => {
    const graph = createGraph({ metadataSchema: {} });
    const descriptor = {
      id: 'resource:theme',
      kind: 'resource' as const,
      label: 'Theme',
      metadata: {},
    };

    assert.throws(() => graph.observe(descriptor), NoActiveExecutionError);
    assert.throws(
      () => graph.withNode(descriptor, () => undefined),
      NoActiveExecutionError,
    );
    assert.deepEqual(graph.snapshot().nodes, []);
  });

  it('rejects invalid runtime node kinds before mutation', () => {
    const graph = createGraph({ metadataSchema: {} });

    assert.throws(() => {
      graph.run(() => {
        graph.observe({
          id: 'invalid',
          kind: 'invalid',
          label: 'Invalid',
        } as never);
      });
    }, TypeError);
    assert.deepEqual(graph.snapshot().nodes, []);
  });

  it('captures every descriptor scalar field exactly once', () => {
    const cases = [
      { field: 'id', valid: 'safe', invalid: 'unsafe\u0000' },
      { field: 'kind', valid: 'resource', invalid: 'invalid' },
      { field: 'label', valid: 'Safe', invalid: '' },
    ] as const;

    for (const testCase of cases) {
      const graph = createGraph({ metadataSchema: {} });
      const descriptor: Record<string, unknown> = {
        id: 'safe',
        kind: 'resource',
        label: 'Safe',
      };
      let reads = 0;
      Object.defineProperty(descriptor, testCase.field, {
        enumerable: true,
        get: () => {
          reads += 1;
          return reads === 1 ? testCase.valid : testCase.invalid;
        },
      });

      graph.run(() => graph.observe(descriptor as never));

      assert.equal(reads, 1, `${testCase.field} read count`);
      assert.equal(graph.snapshot().nodes[0]?.[testCase.field], testCase.valid);
    }

    const graph = createGraph({
      metadataSchema: {
        customKind: { type: 'string', mode: 'constant', redact: 'none' },
      },
    });
    const validMetadata = { customKind: 'plugin' };
    let metadataReads = 0;
    const descriptor: Record<string, unknown> = {
      id: 'custom',
      kind: 'custom',
      label: 'Custom',
    };
    Object.defineProperty(descriptor, 'metadata', {
      enumerable: true,
      get: () => {
        metadataReads += 1;
        return metadataReads === 1 ? validMetadata : { customKind: 7 };
      },
    });

    graph.run(() => graph.observe(descriptor as never));

    assert.equal(metadataReads, 1, 'metadata read count');
    assert.equal(graph.snapshot().nodes[0]?.metadata.customKind, 'plugin');
  });

  it('pins absent metadata against prototype-chain injection', () => {
    const graph = createGraph({
      metadataSchema: {
        tag: { type: 'string', mode: 'constant', redact: 'none' },
      },
    });
    const previous = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'metadata',
    );
    let reads = 0;
    let capturedMetadata: unknown;
    try {
      Object.defineProperty(Object.prototype, 'metadata', {
        configurable: true,
        get: () => {
          reads += 1;
          return reads === 1 ? undefined : { tag: 'injected' };
        },
      });
      graph.run(() => {
        graph.observe({ id: 'resource', kind: 'resource', label: 'Resource' });
      });
      capturedMetadata = graph.snapshot().nodes[0]?.metadata;
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(Object.prototype, 'metadata');
      } else {
        Object.defineProperty(Object.prototype, 'metadata', previous);
      }
    }

    assert.equal(reads, 1);
    assert.deepEqual(capturedMetadata, {});
  });

  it('keeps captured withNode identifiers consistent through nested work', () => {
    const graph = createGraph({ metadataSchema: {} });
    let reads = 0;
    const descriptor: Record<string, unknown> = {
      kind: 'route',
      label: 'Route',
    };
    Object.defineProperty(descriptor, 'id', {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? 'route' : 'unsafe\u0000';
      },
    });

    graph.run(() => {
      graph.withNode(descriptor as never, () => {
        graph.withNode(
          { id: 'child', kind: 'resource', label: 'Child' },
          () => undefined,
        );
      });
    });

    assert.equal(reads, 1);
    assert.deepEqual(graph.snapshot().edges, [
      { from: 'route', to: 'child', kind: 'contains', observations: 1 },
    ]);
  });

  it('rejects changing custom metadata proxies before mutation', () => {
    const graph = createGraph({
      metadataSchema: {
        customKind: { type: 'string', mode: 'constant', redact: 'none' },
      },
    });
    let reads = 0;
    const metadata = new Proxy(
      { customKind: 'plugin' },
      {
        get: (target, property, receiver): unknown => {
          if (property === 'customKind') {
            reads += 1;
            return reads === 1 ? 'plugin' : 7;
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      },
    );

    assert.throws(() => {
      graph.run(() => {
        graph.observe({
          id: 'custom',
          kind: 'custom',
          label: 'Custom',
          metadata,
        });
      });
    }, TypeError);
    assert.deepEqual(graph.snapshot().nodes, []);
  });

  it('records explicit dependencies and reports their strongly connected components', () => {
    const graph = createGraph({ metadataSchema: {} });

    graph.run(() => {
      graph.observe({ id: 'a', kind: 'resource', label: 'A' });
      graph.observe({ id: 'b', kind: 'derived', label: 'B' });
      graph.observe({ id: 'c', kind: 'resource', label: 'C' });
      graph.dependsOn('a', 'b');
      graph.dependsOn('b', 'a');
      graph.dependsOn('c', 'c');
    });

    assert.deepEqual(graph.snapshot().edges, [
      { from: 'a', to: 'b', kind: 'dependsOn', observations: 1 },
      { from: 'b', to: 'a', kind: 'dependsOn', observations: 1 },
      { from: 'c', to: 'c', kind: 'dependsOn', observations: 1 },
    ]);
    assert.deepEqual(graph.snapshot().cycles, [['a', 'b'], ['c']]);
  });

  it('requires reserved edge metadata to be an exact empty plain object', () => {
    const invalidMetadata = [
      { [Symbol('secret')]: true },
      Object.create({ inherited: true }) as object,
      new Map<string, string>(),
    ];

    for (const metadata of invalidMetadata) {
      const graph = createGraph({ metadataSchema: {} });
      graph.run(() => {
        graph.observe({ id: 'a', kind: 'resource', label: 'A' });
        graph.observe({ id: 'b', kind: 'resource', label: 'B' });
        assert.throws(
          () => graph.dependsOn('a', 'b', { metadata: metadata as never }),
          TypeError,
        );
      });
      assert.deepEqual(graph.snapshot().edges, []);
    }
  });

  it('analyzes a valid default-capacity dependency chain without stack exhaustion', () => {
    const graph = createGraph({ metadataSchema: {} });
    const count = 10_000;
    graph.run(() => {
      for (let index = 0; index < count; index += 1) {
        const id = `n${String(index).padStart(5, '0')}`;
        graph.observe({ id, kind: 'resource', label: id });
      }
      for (let index = 0; index < count - 1; index += 1) {
        const from = `n${String(index).padStart(5, '0')}`;
        const to = `n${String(index + 1).padStart(5, '0')}`;
        graph.dependsOn(from, to);
      }
    });

    assert.deepEqual(graph.snapshot().cycles, []);
  });

  it('applies allowlisted metadata rules and redaction', () => {
    const graph = createGraph({
      metadataSalt: 'fixture-salt',
      metadataSchema: {
        customKind: { type: 'string', mode: 'constant', redact: 'none' },
        public: { type: 'string', mode: 'constant', redact: 'none' },
        secret: { type: 'string', mode: 'constant', redact: 'sha256' },
        enabled: { type: 'boolean', mode: 'constant', redact: 'none' },
        omitted: { type: 'string', mode: 'constant', redact: 'drop' },
      },
    });

    graph.run(() => {
      graph.observe({
        id: 'custom:widget',
        kind: 'custom',
        label: 'Widget',
        metadata: {
          omitted: 'drop me',
          enabled: false,
          secret: 'sensitive',
          public: 'safe',
          customKind: 'widget',
        },
      });
    });

    const metadata = graph.snapshot().nodes[0]?.metadata;
    assert.deepEqual(Object.keys(metadata ?? {}), [
      'customKind',
      'enabled',
      'public',
      'secret',
    ]);
    assert.equal(metadata?.customKind, 'widget');
    assert.equal(metadata?.enabled, false);
    assert.equal(metadata?.public, 'safe');
    assert.match(String(metadata?.secret), /^[0-9a-f]{64}$/);
  });

  it('merges compatible snapshots by summing observation counts', () => {
    const first = createGraph({ metadataSchema: {} });
    const second = createGraph({ metadataSchema: {} });
    for (const graph of [first, second]) {
      graph.run(() => {
        graph.observe({
          id: 'resource:theme',
          kind: 'resource',
          label: 'Theme',
        });
      });
    }

    const merged = mergeSnapshots([first.snapshot(), second.snapshot()]);

    assert.equal(merged.nodes[0]?.observations, 2);
    assert.deepEqual(merged.edges, []);
    assert.deepEqual(merged.cycles, []);
  });

  it('merges set metadata across compatible snapshots', () => {
    const options = {
      metadataSchema: {
        tags: {
          type: 'string' as const,
          mode: 'set' as const,
          maxDistinct: 2,
          redact: 'none' as const,
        },
      },
    };
    const first = createGraph(options);
    const second = createGraph(options);
    first.run(() => {
      first.observe({
        id: 'shared',
        kind: 'resource',
        label: 'Shared',
        metadata: { tags: 'a' },
      });
    });
    second.run(() => {
      second.observe({
        id: 'shared',
        kind: 'resource',
        label: 'Shared',
        metadata: { tags: 'b' },
      });
    });

    const merged = mergeSnapshots([first.snapshot(), second.snapshot()]);

    assert.deepEqual(merged.nodes[0]?.metadata.tags, ['a', 'b']);
  });

  it('rejects merged set metadata beyond the declared cardinality', () => {
    const options = {
      metadataSchema: {
        tags: {
          type: 'string' as const,
          mode: 'set' as const,
          maxDistinct: 1,
          redact: 'none' as const,
        },
      },
    };
    const first = createGraph(options);
    const second = createGraph(options);
    first.run(() => {
      first.observe({
        id: 'shared',
        kind: 'resource',
        label: 'Shared',
        metadata: { tags: 'a' },
      });
    });
    second.run(() => {
      second.observe({
        id: 'shared',
        kind: 'resource',
        label: 'Shared',
        metadata: { tags: 'b' },
      });
    });

    assert.throws(
      () => mergeSnapshots([first.snapshot(), second.snapshot()]),
      TypeError,
    );
  });

  it('rejects containment cycles formed only by snapshot union', () => {
    const forward = createGraph({ metadataSchema: {} });
    forward.run(() => {
      forward.withNode({ id: 'a', kind: 'route', label: 'A' }, () =>
        forward.withNode(
          { id: 'b', kind: 'capability', label: 'B' },
          () => undefined,
        ),
      );
    });
    const reverse = createGraph({ metadataSchema: {} });
    reverse.run(() => {
      reverse.withNode({ id: 'b', kind: 'capability', label: 'B' }, () =>
        reverse.withNode(
          { id: 'a', kind: 'route', label: 'A' },
          () => undefined,
        ),
      );
    });

    assert.throws(
      () => mergeSnapshots([forward.snapshot(), reverse.snapshot()]),
      TypeError,
    );
  });

  it('renders deterministic Graphviz DOT from a snapshot', () => {
    const graph = createGraph({ metadataSchema: {} });
    graph.run(() => {
      graph.observe({ id: 'a', kind: 'resource', label: 'A' });
      graph.observe({ id: 'b', kind: 'derived', label: 'B' });
      graph.dependsOn('a', 'b');
    });

    assert.equal(
      toDot(graph.snapshot()),
      [
        'strict digraph RuntimeImpactGraph {',
        '  graph [rankdir="LR"];',
        '  node [shape="box"];',
        '  edge [];',
        '  "a" [label="A\\nresource"];',
        '  "b" [label="B\\nderived"];',
        '  "a" -> "b" [label="dependsOn × 1"];',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('rejects containment cycles before mutating the graph', () => {
    const graph = createGraph({ metadataSchema: {} });
    const descriptor = { id: 'route:a', kind: 'route' as const, label: 'A' };

    graph.run(() => {
      graph.withNode(descriptor, () => {
        assert.throws(
          () => graph.withNode(descriptor, () => undefined),
          ContainmentCycleError,
        );
      });
    });

    assert.equal(graph.snapshot().nodes[0]?.observations, 1);
    assert.deepEqual(graph.snapshot().edges, []);
  });

  it('rejects cross-execution containment cycles without partial mutation', () => {
    const graph = createGraph({ metadataSchema: {} });
    const a = { id: 'a', kind: 'route' as const, label: 'A' };
    const b = { id: 'b', kind: 'capability' as const, label: 'B' };

    graph.run(() => {
      graph.withNode(a, () => graph.withNode(b, () => undefined));
    });
    assert.throws(() => {
      graph.run(() => {
        graph.withNode(b, () => graph.withNode(a, () => undefined));
      });
    }, ContainmentCycleError);

    assert.deepEqual(
      graph.snapshot().nodes.map((node) => node.observations),
      [1, 2],
    );
    assert.deepEqual(graph.snapshot().edges, [
      { from: 'a', to: 'b', kind: 'contains', observations: 1 },
    ]);
  });

  it('keeps withNode transactional when a containment count overflows', () => {
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
    const parent = { id: 'parent', kind: 'route' as const, label: 'Parent' };
    const child = {
      id: 'child',
      kind: 'resource' as const,
      label: 'Child',
      metadata: { tags: 'a' },
    };
    graph.run(() => {
      graph.withNode(parent, () => graph.withNode(child, () => undefined));
    });
    setGraphCountsForTest(graph, {
      edges: [
        {
          from: parent.id,
          to: child.id,
          kind: 'contains',
          observations: Number.MAX_SAFE_INTEGER,
        },
      ],
    });

    graph.run(() => {
      graph.withNode(parent, () => {
        const before = structuredClone(graph.snapshot());
        assert.throws(
          () =>
            graph.withNode(
              { ...child, metadata: { tags: 'b' } },
              () => undefined,
            ),
          CountOverflowError,
        );
        assert.deepEqual(graph.snapshot(), before);
      });
    });
  });

  it('keeps withNode transactional when a drop warning count overflows', () => {
    const graph = createGraph({
      maxEdges: 0,
      metadataSchema: {
        tags: {
          type: 'string',
          mode: 'set',
          maxDistinct: 2,
          redact: 'none',
        },
      },
      onLimit: 'drop',
    });
    const parent = { id: 'parent', kind: 'route' as const, label: 'Parent' };
    const child = {
      id: 'child',
      kind: 'resource' as const,
      label: 'Child',
      metadata: { tags: 'a' },
    };
    graph.run(() => {
      graph.withNode(parent, () => graph.withNode(child, () => undefined));
    });
    setGraphCountsForTest(graph, {
      warnings: { 'edge-limit': Number.MAX_SAFE_INTEGER },
    });

    graph.run(() => {
      graph.withNode(parent, () => {
        const before = structuredClone(graph.snapshot());
        assert.throws(
          () =>
            graph.withNode(
              { ...child, metadata: { tags: 'b' } },
              () => undefined,
            ),
          CountOverflowError,
        );
        assert.deepEqual(graph.snapshot(), before);
      });
    });
  });

  it('rechecks node capacity after metadata reentrancy before commit', () => {
    const graph = createGraph({
      maxNodes: 1,
      metadataSchema: {
        customKind: { type: 'string', mode: 'constant', redact: 'none' },
      },
    });
    let reentered = false;
    const metadata = new Proxy(
      { customKind: 'plugin' },
      {
        get: (target, property, receiver): unknown => {
          if (property === 'customKind' && !reentered) {
            reentered = true;
            graph.observe({ id: 'nested', kind: 'resource', label: 'Nested' });
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      },
    );

    assert.throws(() => {
      graph.run(() => {
        graph.observe({
          id: 'outer',
          kind: 'custom',
          label: 'Outer',
          metadata,
        });
      });
    }, RangeError);
    assert.deepEqual(
      graph.snapshot().nodes.map((node) => node.id),
      ['nested'],
    );
  });

  it('drops over-limit nodes without retaining their identifiers', () => {
    const graph = createGraph({
      metadataSchema: {},
      maxNodes: 1,
      onLimit: 'drop',
    });

    graph.run(() => {
      graph.observe({ id: 'accepted', kind: 'resource', label: 'Accepted' });
      graph.observe({ id: 'private-id', kind: 'resource', label: 'Dropped' });
    });

    assert.deepEqual(
      graph.snapshot().nodes.map((node) => node.id),
      ['accepted'],
    );
    assert.deepEqual(graph.snapshot().warnings, [
      { code: 'node-limit', count: 1 },
    ]);
    assert.doesNotMatch(toCanonicalJson(graph.snapshot()), /private-id/);
  });

  it('keeps intentionally interleaved execution roots isolated', async () => {
    const graph = createGraph({ metadataSchema: {} });
    let releaseFirst: (() => void) | undefined;
    const firstCanContinue = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    await Promise.all([
      graph.run(async () => {
        await graph.withNode(
          { id: 'route:a', kind: 'route', label: 'Route A' },
          async () => {
            await firstCanContinue;
            await graph.withNode(
              { id: 'capability:a', kind: 'capability', label: 'A' },
              async () => Promise.resolve(),
            );
          },
        );
      }),
      graph.run(async () => {
        await graph.withNode(
          { id: 'route:b', kind: 'route', label: 'Route B' },
          async () => {
            releaseFirst?.();
            await Promise.resolve();
            await graph.withNode(
              { id: 'capability:b', kind: 'capability', label: 'B' },
              async () => Promise.resolve(),
            );
          },
        );
      }),
    ]);

    assert.deepEqual(graph.snapshot().edges, [
      {
        from: 'route:a',
        to: 'capability:a',
        kind: 'contains',
        observations: 1,
      },
      {
        from: 'route:b',
        to: 'capability:b',
        kind: 'contains',
        observations: 1,
      },
    ]);
  });
});
