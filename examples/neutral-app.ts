import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createGraph,
  toCanonicalJson,
  toDot,
  type GraphSnapshotV1,
  type NodeDescriptor,
} from '../src/index.js';

const nodes = {
  catalog: {
    id: 'resource:catalog-api',
    kind: 'resource',
    label: 'Place catalog API',
  },
  discover: {
    id: 'route:discover',
    kind: 'route',
    label: 'Discover route',
  },
  forecast: {
    id: 'resource:forecast-api',
    kind: 'resource',
    label: 'Forecast API',
  },
  loader: {
    id: 'loader:place-context',
    kind: 'loader',
    label: 'Place context loader',
  },
  ranked: {
    id: 'derived:ranked-places',
    kind: 'derived',
    label: 'Ranked places',
  },
  recommend: {
    id: 'capability:recommend-places',
    kind: 'capability',
    label: 'Recommend places',
  },
  weekendPlan: {
    id: 'route:weekend-plan',
    kind: 'route',
    label: 'Weekend plan route',
  },
} as const satisfies Record<string, NodeDescriptor>;

async function captureRoute(
  graph: ReturnType<typeof createGraph>,
  route: NodeDescriptor,
  waitMilliseconds: number,
): Promise<void> {
  await graph.run(async () => {
    await graph.withNode(route, async () => {
      await graph.withNode(nodes.recommend, async () => {
        await graph.withNode(nodes.loader, async () => {
          await delay(waitMilliseconds);
          graph.observe(nodes.catalog);
          graph.observe(nodes.forecast);
        });

        graph.observe(nodes.ranked);
        graph.dependsOn(nodes.catalog.id, nodes.loader.id);
        graph.dependsOn(nodes.forecast.id, nodes.loader.id);
        graph.dependsOn(nodes.loader.id, nodes.ranked.id);
        graph.dependsOn(nodes.ranked.id, nodes.recommend.id);
      });
    });
  });
}

export async function buildNeutralShowcase(): Promise<GraphSnapshotV1> {
  const graph = createGraph({ metadataSchema: {} });

  await Promise.all([
    captureRoute(graph, nodes.discover, 2),
    captureRoute(graph, nodes.weekendPlan, 0),
  ]);

  return graph.snapshot();
}

const outputDirectory = fileURLToPath(new URL('./generated/', import.meta.url));

async function writeOrCheckArtifacts(check: boolean): Promise<void> {
  const snapshot = await buildNeutralShowcase();
  const artifacts = [
    ['neutral-showcase.json', toCanonicalJson(snapshot)],
    ['neutral-showcase.dot', toDot(snapshot)],
  ] as const;

  if (check) {
    for (const [filename, expected] of artifacts) {
      const actual = await readFile(`${outputDirectory}/${filename}`, 'utf8');
      if (actual !== expected) {
        throw new Error(
          `${filename} is stale. Run "npm run example" to regenerate it.`,
        );
      }
    }
    process.stdout.write(
      'Neutral showcase artifacts match the current source.\n',
    );
    return;
  }

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all(
    artifacts.map(([filename, content]) =>
      writeFile(`${outputDirectory}/${filename}`, content, 'utf8'),
    ),
  );
  process.stdout.write(
    `Wrote ${String(artifacts.length)} artifacts to examples/generated/.\n`,
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  await writeOrCheckArtifacts(process.argv.includes('--check'));
}
