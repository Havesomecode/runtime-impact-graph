import {
  createGraph,
  toCanonicalJson,
  type NodeDescriptor,
} from '../src/index.js';

const scenarioNames = [
  'baseline-callback',
  'graph-run',
  'one-node',
  'ten-nested-nodes',
  'two-interleaved-roots',
] as const;
type ScenarioName = (typeof scenarioNames)[number];

const [scenarioArgument, warmupArgument, measuredArgument] =
  process.argv.slice(2);
if (!scenarioNames.includes(scenarioArgument as ScenarioName)) {
  throw new Error(`Unknown benchmark scenario: ${String(scenarioArgument)}`);
}
const scenario = scenarioArgument as ScenarioName;
const warmupIterations = Number.parseInt(String(warmupArgument), 10);
const measuredIterations = Number.parseInt(String(measuredArgument), 10);
if (
  !Number.isSafeInteger(warmupIterations) ||
  warmupIterations < 0 ||
  !Number.isSafeInteger(measuredIterations) ||
  measuredIterations <= 0
) {
  throw new Error('Iteration counts must be safe non-negative integers.');
}

const graph = createGraph({ metadataSchema: {} });
let sink = 0;
const callback = (): number => {
  sink = (sink + 1) % 1_000_000_007;
  return sink;
};

function descriptors(prefix: string): readonly NodeDescriptor[] {
  return Array.from({ length: 10 }, (_, index) => ({
    id: `${prefix}:${String(index + 1).padStart(2, '0')}`,
    kind: 'loader' as const,
    label: `${prefix} node ${String(index + 1)}`,
  }));
}

const singleNodes = descriptors('benchmark:single');
const leftNodes = descriptors('benchmark:left');
const rightNodes = descriptors('benchmark:right');

function nested(
  nodes: readonly NodeDescriptor[],
  index = 0,
): number | Promise<number> {
  const node = nodes[index];
  if (node === undefined) return callback();
  return graph.withNode(node, () => nested(nodes, index + 1));
}

async function interleavedRoot(
  nodes: readonly NodeDescriptor[],
): Promise<void> {
  await graph.run(async () => {
    await graph.withNode(nodes[0]!, async () => {
      await Promise.resolve();
      await nested(nodes.slice(1));
    });
  });
}

async function runIterations(iterations: number): Promise<void> {
  switch (scenario) {
    case 'baseline-callback':
      for (let index = 0; index < iterations; index += 1) callback();
      return;
    case 'graph-run':
      for (let index = 0; index < iterations; index += 1) {
        void graph.run(callback);
      }
      return;
    case 'one-node':
      for (let index = 0; index < iterations; index += 1) {
        void graph.run(() => graph.withNode(singleNodes[0]!, callback));
      }
      return;
    case 'ten-nested-nodes':
      for (let index = 0; index < iterations; index += 1) {
        void graph.run(() => nested(singleNodes));
      }
      return;
    case 'two-interleaved-roots':
      for (let index = 0; index < iterations; index += 1) {
        await Promise.all([
          interleavedRoot(leftNodes),
          interleavedRoot(rightNodes),
        ]);
      }
  }
}

await runIterations(warmupIterations);
const gc = (globalThis as { gc?: () => void }).gc;
gc?.();
const heapBeforeBytes = process.memoryUsage().heapUsed;
const startedAt = process.hrtime.bigint();
await runIterations(measuredIterations);
const elapsedNanoseconds = Number(process.hrtime.bigint() - startedAt);
gc?.();
const heapAfterBytes = process.memoryUsage().heapUsed;
const outputBytes =
  scenario === 'baseline-callback'
    ? 0
    : Buffer.byteLength(toCanonicalJson(graph.snapshot()));

process.stdout.write(
  `${JSON.stringify({
    scenario,
    elapsedNanoseconds,
    nanosecondsPerOperation: elapsedNanoseconds / measuredIterations,
    heapBeforeBytes,
    heapAfterBytes,
    heapDeltaBytes: heapAfterBytes - heapBeforeBytes,
    outputBytes,
    explicitGc: gc !== undefined,
    sink,
  })}\n`,
);
