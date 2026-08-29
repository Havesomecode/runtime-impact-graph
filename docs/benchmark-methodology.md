# Local benchmark methodology

The checked result in [`../bench/results/local-node22.json`](../bench/results/local-node22.json)
is a reproducible local comparison, not a production-safety claim or a supported
latency budget.

## Run it

```sh
npm ci
npm run benchmark
```

The controller launches each sample as a fresh Node.js process with
`--expose-gc`. The raw result records the exact worker command, package commit,
dirty-tree state, run date, Node version, operating system, release,
architecture, and CPU model.

## Fixed workload

Every scenario runs in five fresh processes. Each process performs 1,000 warm-up
operations followed by 100,000 measured operations.

The scenarios are:

1. `baseline-callback`: invoke the same state-changing callback without graph
   instrumentation.
2. `graph-run`: invoke the callback inside `graph.run(...)`.
3. `one-node`: enter one node inside one graph root, then invoke the callback.
4. `ten-nested-nodes`: enter ten nested nodes inside one graph root, then invoke
   the callback.
5. `two-interleaved-roots`: start two asynchronous roots together, each with ten
   nodes and a promise yield. One measured operation is the complete pair.

The benchmark uses an empty metadata schema and the default limits: 10,000
nodes, 50,000 aggregate edges, and `onLimit: 'throw'`. Stable benchmark node IDs
are reused, so the graph remains bounded while observation counts increase.

## Recorded values

For each fresh-process sample the raw file records:

- total measured elapsed nanoseconds;
- elapsed nanoseconds per operation;
- heap bytes before and after the measured batch;
- heap delta after an explicit garbage collection before and after the measured
  batch, when `global.gc` is available;
- canonical JSON output size in bytes after warm-up and measurement (`0` for the
  uninstrumented baseline);
- whether explicit GC was available.

The controller summarizes nanoseconds per operation across the five process
samples as mean, median, and p95. With five values, p95 is the highest observed
sample. Raw samples remain in the file so readers can inspect spread rather than
relying on the summary alone.

## Interpretation boundary

These numbers compare five synthetic operations on one recorded machine. They
do not establish throughput under application load, distributed behavior,
request latency, memory safety, privacy safety, or suitability for a particular
production system. The async scenario intentionally does more work per measured
operation than the single-root scenarios. There is no pass/fail performance
threshold in v0.1.

Re-run the harness on the Node and hardware combinations relevant to a proposed
adoption. Keep the raw output and environment record with any claim derived from
that run.
