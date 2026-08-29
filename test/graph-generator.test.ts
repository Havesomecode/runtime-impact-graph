import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createGraph,
  mergeSnapshots,
  toCanonicalJson,
  toDot,
  type GraphSnapshotV1,
} from '../src/index.js';

function permutations<T>(values: readonly T[]): readonly (readonly T[])[] {
  if (values.length === 0) return [[]];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map(
      (rest) => [value, ...rest],
    ),
  );
}

function cyclicSnapshot(region: string, reverse: boolean): GraphSnapshotV1 {
  const graph = createGraph({
    metadataSchema: {
      region: {
        type: 'string',
        mode: 'set',
        maxDistinct: 3,
        redact: 'none',
      },
    },
  });
  const descriptors = [
    {
      id: 'resource:a',
      kind: 'resource' as const,
      label: 'Resource A',
      metadata: { region },
    },
    {
      id: 'derived:b',
      kind: 'derived' as const,
      label: 'Derived B',
      metadata: { region },
    },
    {
      id: 'capability:c',
      kind: 'capability' as const,
      label: 'Capability C',
      metadata: { region },
    },
  ];

  graph.run(() => {
    for (const descriptor of reverse
      ? [...descriptors].reverse()
      : descriptors) {
      graph.observe(descriptor);
    }
    graph.dependsOn('resource:a', 'derived:b');
    graph.dependsOn('resource:a', 'derived:b');
    graph.dependsOn('derived:b', 'resource:a');
    graph.dependsOn('capability:c', 'capability:c');
  });
  return graph.snapshot();
}

describe('deterministic v0.1 graph generator', () => {
  it('produces byte-identical JSON for equivalent executions and every merge order', () => {
    assert.equal(
      toCanonicalJson(cyclicSnapshot('eu-west', false)),
      toCanonicalJson(cyclicSnapshot('eu-west', true)),
    );

    const snapshots = [
      cyclicSnapshot('zeta', false),
      cyclicSnapshot('alpha', true),
      cyclicSnapshot('middle', false),
    ];
    const outputs = permutations(snapshots).map((order) =>
      toCanonicalJson(mergeSnapshots(order)),
    );

    assert.equal(new Set(outputs).size, 1);
    const merged = mergeSnapshots(snapshots);
    assert.deepEqual(merged.cycles, [
      ['capability:c'],
      ['derived:b', 'resource:a'],
    ]);
    assert.equal(
      merged.edges.find(
        (edge) =>
          edge.from === 'resource:a' &&
          edge.to === 'derived:b' &&
          edge.kind === 'dependsOn',
      )?.observations,
      6,
    );
    assert.deepEqual(merged.nodes[0]?.metadata.region, [
      'alpha',
      'middle',
      'zeta',
    ]);
  });

  it('filters allowlisted metadata and redacts secret and PII-shaped values', () => {
    const rawEmail = 'alice@example.test';
    const rawAuthorization = 'Bearer sk_live_DO_NOT_EXPORT';
    const rawAccountId = 'customer-1987-06-05-8292';
    const rawCard = '4111 1111 1111 1111';
    const metadataSalt = 'high-entropy-test-salt';
    const graph = createGraph({
      metadataSalt,
      metadataSchema: {
        accountId: {
          type: 'string',
          mode: 'constant',
          redact: 'sha256',
        },
        authorization: {
          type: 'string',
          mode: 'constant',
          redact: 'replace',
        },
        email: { type: 'string', mode: 'constant', redact: 'drop' },
        environment: {
          type: 'string',
          mode: 'constant',
          redact: 'none',
        },
      },
    });

    graph.run(() => {
      graph.observe({
        id: 'resource:account',
        kind: 'resource',
        label: 'Account resource',
        metadata: {
          accountId: rawAccountId,
          authorization: rawAuthorization,
          email: rawEmail,
          environment: 'test',
        },
      });
      assert.throws(
        () =>
          graph.observe({
            id: 'resource:payment',
            kind: 'resource',
            label: 'Payment resource',
            metadata: { card: rawCard },
          }),
        (error: unknown) => {
          assert.ok(error instanceof TypeError);
          assert.doesNotMatch(error.message, new RegExp(rawCard, 'u'));
          return true;
        },
      );
    });

    const json = toCanonicalJson(graph.snapshot());
    assert.match(json, /"authorization":"\[REDACTED\]"/u);
    assert.match(json, /"environment":"test"/u);
    assert.match(json, /"accountId":"[0-9a-f]{64}"/u);
    for (const sensitive of [
      rawEmail,
      rawAuthorization,
      rawAccountId,
      rawCard,
      metadataSalt,
    ]) {
      assert.doesNotMatch(json, new RegExp(sensitive, 'u'));
    }
    assert.deepEqual(
      graph.snapshot().nodes.map((node) => node.id),
      ['resource:account'],
    );
  });

  it('bounds graph explosion without retaining dynamic identifiers', () => {
    const graph = createGraph({
      metadataSchema: {},
      maxNodes: 2,
      maxEdges: 1,
      onLimit: 'drop',
    });

    graph.run(() => {
      graph.withNode(
        { id: 'route:stable', kind: 'route', label: 'Stable route' },
        () => {
          graph.withNode(
            {
              id: 'capability:stable',
              kind: 'capability',
              label: 'Stable capability',
            },
            () => undefined,
          );
          for (let index = 0; index < 100; index += 1) {
            graph.observe({
              id: `request:${String(index).padStart(4, '0')}:user@example.test`,
              kind: 'resource',
              label: 'Rejected dynamic resource',
            });
          }
        },
      );
      for (let index = 0; index < 50; index += 1) {
        graph.dependsOn('capability:stable', 'route:stable');
      }
    });

    const snapshot = graph.snapshot();
    assert.deepEqual(
      snapshot.nodes.map((node) => node.id),
      ['capability:stable', 'route:stable'],
    );
    assert.deepEqual(snapshot.edges, [
      {
        from: 'route:stable',
        to: 'capability:stable',
        kind: 'contains',
        observations: 1,
      },
    ]);
    assert.deepEqual(snapshot.warnings, [
      { code: 'edge-limit', count: 50 },
      { code: 'node-limit', count: 100 },
    ]);
    assert.doesNotMatch(toCanonicalJson(snapshot), /request:|user@example/u);
  });

  it('represents dependency cycles and rejects malformed graph projections', () => {
    const snapshot = cyclicSnapshot('eu-west', false);
    assert.deepEqual(snapshot.cycles, [
      ['capability:c'],
      ['derived:b', 'resource:a'],
    ]);

    assert.throws(
      () => toCanonicalJson({ ...snapshot, cycles: [] }),
      /cycles do not match/u,
    );
    assert.throws(
      () =>
        toCanonicalJson({
          ...snapshot,
          edges: [
            ...snapshot.edges,
            {
              from: 'unknown',
              to: 'resource:a',
              kind: 'dependsOn',
              observations: 1,
            },
          ],
        }),
      /unknown node/u,
    );
    assert.throws(
      () =>
        toCanonicalJson({
          ...snapshot,
          edges: [
            {
              from: 'resource:a',
              to: 'derived:b',
              kind: 'contains',
              observations: 1,
            },
            {
              from: 'derived:b',
              to: 'resource:a',
              kind: 'contains',
              observations: 1,
            },
          ],
          cycles: [],
        }),
      /containment cycle/u,
    );
  });

  it('rejects conflicting metadata in either merge order without input mutation', () => {
    const makeSnapshot = (environment: string): GraphSnapshotV1 => {
      const graph = createGraph({
        metadataSchema: {
          environment: {
            type: 'string',
            mode: 'constant',
            redact: 'none',
          },
        },
      });
      graph.run(() => {
        graph.observe({
          id: 'resource:shared',
          kind: 'resource',
          label: 'Shared resource',
          metadata: { environment },
        });
      });
      return graph.snapshot();
    };
    const first = makeSnapshot('production');
    const second = makeSnapshot('staging');
    const before = [toCanonicalJson(first), toCanonicalJson(second)];
    const messages = [
      [first, second],
      [second, first],
    ].map((snapshots) => {
      try {
        mergeSnapshots(snapshots);
        assert.fail('Expected conflicting metadata to be rejected.');
      } catch (error) {
        assert.ok(error instanceof TypeError);
        return error.message;
      }
    });

    assert.deepEqual(messages, [
      'Conflicting constant metadata for key "environment".',
      'Conflicting constant metadata for key "environment".',
    ]);
    assert.deepEqual([toCanonicalJson(first), toCanonicalJson(second)], before);
  });

  it('renders deterministic DOT without exposing metadata', () => {
    const snapshot = cyclicSnapshot('private-region', false);
    const reordered = {
      ...snapshot,
      nodes: [...snapshot.nodes].reverse(),
      edges: [...snapshot.edges].reverse(),
      cycles: [...snapshot.cycles].reverse(),
    };

    assert.equal(toDot(reordered), toDot(snapshot));
    assert.match(toDot(snapshot), /^strict digraph RuntimeImpactGraph \{/u);
    assert.doesNotMatch(toDot(snapshot), /private-region/u);
  });
});
