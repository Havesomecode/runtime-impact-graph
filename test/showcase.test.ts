import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { buildNeutralShowcase } from '../examples/neutral-app.js';
import { toCanonicalJson, toDot } from '../src/index.js';

const generatedDirectory = fileURLToPath(
  new URL('../examples/generated/', import.meta.url),
);
const benchmarkResult = fileURLToPath(
  new URL('../bench/results/local-node22.json', import.meta.url),
);

interface BenchmarkResult {
  readonly warmupIterations: number;
  readonly measuredIterations: number;
  readonly processesPerScenario: number;
  readonly claimBoundary: string;
  readonly scenarios: readonly {
    readonly name: string;
    readonly samples: readonly unknown[];
    readonly summary: {
      readonly medianNanosecondsPerOperation: number;
      readonly p95NanosecondsPerOperation: number;
      readonly meanNanosecondsPerOperation: number;
    };
  }[];
}

describe('neutral showcase', () => {
  it('captures a useful framework-independent graph', async () => {
    const snapshot = await buildNeutralShowcase();

    assert.deepEqual(
      snapshot.nodes.map((node) => node.id),
      [
        'capability:recommend-places',
        'derived:ranked-places',
        'loader:place-context',
        'resource:catalog-api',
        'resource:forecast-api',
        'route:discover',
        'route:weekend-plan',
      ],
    );
    assert.deepEqual(snapshot.cycles, []);
    assert.deepEqual(snapshot.warnings, []);
    assert.deepEqual(
      snapshot.edges.map(({ from, to, kind, observations }) => ({
        from,
        to,
        kind,
        observations,
      })),
      [
        {
          from: 'capability:recommend-places',
          to: 'loader:place-context',
          kind: 'contains',
          observations: 2,
        },
        {
          from: 'derived:ranked-places',
          to: 'capability:recommend-places',
          kind: 'dependsOn',
          observations: 2,
        },
        {
          from: 'loader:place-context',
          to: 'derived:ranked-places',
          kind: 'dependsOn',
          observations: 2,
        },
        {
          from: 'resource:catalog-api',
          to: 'loader:place-context',
          kind: 'dependsOn',
          observations: 2,
        },
        {
          from: 'resource:forecast-api',
          to: 'loader:place-context',
          kind: 'dependsOn',
          observations: 2,
        },
        {
          from: 'route:discover',
          to: 'capability:recommend-places',
          kind: 'contains',
          observations: 1,
        },
        {
          from: 'route:weekend-plan',
          to: 'capability:recommend-places',
          kind: 'contains',
          observations: 1,
        },
      ],
    );
  });

  it('keeps checked showcase artifacts byte-identical to formatter output', async () => {
    const snapshot = await buildNeutralShowcase();
    const [json, dot] = await Promise.all([
      readFile(`${generatedDirectory}/neutral-showcase.json`, 'utf8'),
      readFile(`${generatedDirectory}/neutral-showcase.dot`, 'utf8'),
    ]);

    assert.equal(json, toCanonicalJson(snapshot));
    assert.equal(dot, toDot(snapshot));
  });

  it('retains honest raw benchmark evidence for every required scenario', async () => {
    const result = JSON.parse(
      await readFile(benchmarkResult, 'utf8'),
    ) as BenchmarkResult;

    assert.equal(result.warmupIterations, 1_000);
    assert.equal(result.measuredIterations, 100_000);
    assert.equal(result.processesPerScenario, 5);
    assert.match(result.claimBoundary, /not production-safety evidence/u);
    assert.deepEqual(
      result.scenarios.map((scenario) => scenario.name),
      [
        'baseline-callback',
        'graph-run',
        'one-node',
        'ten-nested-nodes',
        'two-interleaved-roots',
      ],
    );
    for (const scenario of result.scenarios) {
      assert.equal(scenario.samples.length, 5);
      assert.ok(scenario.summary.medianNanosecondsPerOperation > 0);
      assert.ok(scenario.summary.p95NanosecondsPerOperation > 0);
      assert.ok(scenario.summary.meanNanosecondsPerOperation > 0);
    }
  });
});
