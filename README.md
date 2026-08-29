# Runtime Impact Graph

Capture the dependencies that matter during real Node.js execution, then turn
them into a deterministic graph you can inspect, diff, and merge.

Runtime Impact Graph is a small, framework-independent TypeScript library. You
name semantic units such as routes, capabilities, loaders, external resources,
and derived data. The library preserves their asynchronous execution context,
aggregates repeated observations, and emits canonical JSON or Graphviz DOT.

It does not trace every function call, inspect source imports, replace
distributed tracing, or prove that an unobserved dependency is impossible.

## See it work

The neutral showcase models two city-guide routes that share a recommendation
capability. That capability loads a place catalog and a forecast, then derives a
ranked set of places. The example uses only synthetic names and local delays; it
makes no network requests.

```text
Place catalog API ─┐
                   ├─dependsOn→ Place context loader ─dependsOn→ Ranked places
Forecast API ──────┘                                            │
                                                                └─dependsOn→ Recommend places
Discover route ─────contains→ Recommend places ─contains→ Place context loader
Weekend plan route ─contains─┘
```

Generate the checked artifacts from a fresh source checkout:

```sh
npm ci
npm run example
npm run example:check
```

The command writes:

- [`examples/generated/neutral-showcase.json`](./examples/generated/neutral-showcase.json)
  — canonical, newline-terminated graph data;
- [`examples/generated/neutral-showcase.dot`](./examples/generated/neutral-showcase.dot)
  — a deterministic, metadata-free Graphviz projection.

If Graphviz is installed separately, render the DOT file with:

```sh
dot -Tsvg examples/generated/neutral-showcase.dot \
  -o examples/generated/neutral-showcase.svg
```

The project does not install Graphviz or require it at runtime.

## Use the library

The public package is scoped as `@havesomecode/runtime-impact-graph` at version `0.1.0`.
This release candidate is not yet available from a registry. In a package
consumer, the API looks like this:

```ts
import {
  createGraph,
  toCanonicalJson,
} from '@havesomecode/runtime-impact-graph';

const graph = createGraph({ metadataSchema: {} });

await graph.run(async () => {
  await graph.withNode(
    {
      id: 'route:discover',
      kind: 'route',
      label: 'Discover route',
    },
    async () => {
      graph.observe({
        id: 'resource:catalog-api',
        kind: 'resource',
        label: 'Place catalog API',
      });
    },
  );
});

process.stdout.write(toCanonicalJson(graph.snapshot()));
```

The root entry point exports `createGraph`, `Graph`, `mergeSnapshots`,
`toCanonicalJson`, `toDot`, the v0.1 model types, and named contract errors.
Formatter-only subpaths are available at `@havesomecode/runtime-impact-graph/json`
and `@havesomecode/runtime-impact-graph/dot`. See the
[practical API guide](./docs/api-v0.1.md) and
the [frozen architecture contract](./docs/architecture-contract-v0.1.md) for the
full behavior.

## Read the graph correctly

Arrows point from prerequisite or owner to dependent or contained node:

- `A -contains-> B` means B was entered while A was the active semantic scope.
- `A -dependsOn-> B` means B declared a dependency on A.

Repeated observations update one aggregate node or edge count; this is not an
event log. Dependency cycles are preserved and reported. Containment cycles are
rejected. Snapshot merge validates compatible metadata policies, sums counts,
and returns the same canonical result regardless of input order.

An absent edge means only “not observed in these captured executions.” It does
not prove that no dependency exists.

## Keep captured data bounded

`metadataSchema` is mandatory. An empty schema rejects every metadata key. When
a key is declared, its type, aggregation mode, bounds, and redaction mode are
validated before graph mutation.

- Redaction defaults to `drop`.
- `replace` emits `[REDACTED]`.
- `sha256` requires a caller-provided non-empty salt. Snapshots export only a
  one-way salt compatibility fingerprint, not the raw salt.
- `none` exports the original primitive value and should be used only for values
  that are safe to disclose.

Do not put request IDs, user or account IDs, parameterized URLs, timestamps,
secrets, personal data, payloads, or generated keys in node IDs, labels,
metadata keys, or unredacted metadata values. The library validates shapes and
policies; it cannot determine whether a consumer-supplied string is sensitive.

Graphs default to 10,000 nodes and 50,000 aggregate edges. Consumers can lower
those limits and choose fail-closed `throw` behavior or bounded `drop` warnings;
they cannot raise the built-in ceilings.

## Compatibility and packaging

- Node.js `>=22.15 <23` or `>=24 <25`
- npm 10 or later for this source repository
- ESM, CommonJS, and TypeScript declarations
- no runtime dependencies

```sh
npm ci
npm run verify
```

`npm run verify` runs formatting, lint, strict type checks, the full test suite,
checked showcase-artifact parity, and both ESM and CommonJS builds. The separate
compatibility lane verifies clean package installation and the documented Node
matrix before release.

## Local benchmark evidence

```sh
npm run benchmark
```

The fixed harness measures five scenarios in five fresh processes each, with
1,000 warm-up and 100,000 measured operations. It records raw samples,
mean/median/p95 elapsed time per operation, GC-bounded heap delta, output bytes,
package commit, Node version, operating system, CPU, date, exact worker commands,
schema, and graph limits.

Read the [methodology](./docs/benchmark-methodology.md) before the checked
[Node 22 local result](./bench/results/local-node22.json). These synthetic local
measurements compare operations on one machine. They are not a production
latency target, throughput guarantee, or safety claim.

## Project boundaries

Runtime Impact Graph captures consumer-defined runtime semantics. It deliberately
does not include:

- automatic JavaScript call capture or monkey-patching;
- static module dependency analysis;
- a distributed executor, cache reload protocol, or impact planner;
- framework, telemetry-vendor, or hosted-service integration;
- telemetry from this package.

The project was designed under a documented
[clean-room boundary](./docs/clean-room-provenance.md). The showcase, tests,
benchmarks, and generated artifacts use neutral synthetic terminology only.

## Develop

```sh
npm ci
npm test
npm run typecheck
npm run lint
npm run format:check
npm run example:check
npm run build
```

The complete v0.1 contract and limitations live in
[`docs/architecture-contract-v0.1.md`](./docs/architecture-contract-v0.1.md).
