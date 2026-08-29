import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const scenarios = [
  'baseline-callback',
  'graph-run',
  'one-node',
  'ten-nested-nodes',
  'two-interleaved-roots',
];
const warmupIterations = 1_000;
const measuredIterations = 100_000;
const processesPerScenario = 5;

function command(...arguments_) {
  const result = spawnSync(arguments_[0], arguments_.slice(1), {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 10 * 60 * 1_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `Command failed (${arguments_.join(' ')}):\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

function quantile(sortedValues, fraction) {
  return sortedValues[Math.ceil(fraction * sortedValues.length) - 1];
}

function summarize(samples) {
  const values = samples
    .map((sample) => sample.nanosecondsPerOperation)
    .sort((left, right) => left - right);
  return {
    medianNanosecondsPerOperation: quantile(values, 0.5),
    p95NanosecondsPerOperation: quantile(values, 0.95),
    meanNanosecondsPerOperation:
      values.reduce((total, value) => total + value, 0) / values.length,
  };
}

const packageCommit = command('git', 'rev-parse', 'HEAD');
const dirty = command('git', 'status', '--short').length > 0;
const benchmarkScenarios = [];
for (const scenario of scenarios) {
  const samples = [];
  for (
    let processIndex = 1;
    processIndex <= processesPerScenario;
    processIndex += 1
  ) {
    const workerArguments = [
      '--expose-gc',
      '--import',
      'tsx',
      'bench/worker.ts',
      scenario,
      String(warmupIterations),
      String(measuredIterations),
    ];
    const sample = JSON.parse(command(process.execPath, ...workerArguments));
    samples.push({ processIndex, ...sample });
  }
  benchmarkScenarios.push({
    name: scenario,
    command: `node --expose-gc --import tsx bench/worker.ts ${scenario} ${String(warmupIterations)} ${String(measuredIterations)}`,
    samples,
    summary: summarize(samples),
  });
}

const result = {
  format: 'runtime-impact-graph/benchmark-v0.1',
  runDate: new Date().toISOString(),
  packageCommit,
  dirty,
  command: 'npm run benchmark',
  warmupIterations,
  measuredIterations,
  processesPerScenario,
  metadataSchema: {},
  limits: {
    maxNodes: 10_000,
    maxEdges: 50_000,
    onLimit: 'throw',
  },
  environment: {
    node: process.version,
    platform: os.platform(),
    release: os.release(),
    architecture: os.arch(),
    cpu: os.cpus()[0]?.model ?? 'unknown',
  },
  claimBoundary:
    'These measurements are local comparative data, not production-safety evidence.',
  scenarios: benchmarkScenarios,
};

const resultsDirectory = path.join(root, 'bench', 'results');
await mkdir(resultsDirectory, { recursive: true });
const resultPath = path.join(resultsDirectory, 'local-node22.json');
await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
process.stdout.write(`Wrote ${path.relative(root, resultPath)}\n`);
