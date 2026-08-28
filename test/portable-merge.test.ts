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
