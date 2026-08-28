# Runtime Impact Graph v0.1 architecture contract

Status: implementation-ready, clean-room contract
Audience: scaffold builder and independent reviewer
Scope: TypeScript library for Node.js; implementation starts only after this document is accepted.

## 1. Product boundary and decision

Runtime Impact Graph records consumer-defined semantic components observed during one or more real asynchronous Node.js executions, then produces a deterministic directed graph. It does not infer meaning from source files, function names, stack traces, or monkey-patching. This makes the graph a reusable dependency artifact rather than a timing trace or a static import map.

A static module-dependency tool such as Madge reads module relationships and reports circular dependencies.[4] OpenTelemetry traces instead model request paths as spans with timing, context, attributes and status, including cross-process use cases.[3] This product is deliberately narrower: it records the consumer's named semantic units and two explicit relationship types, aggregates repeat observations, and exports a canonical graph suitable for review and CI. It does not replace either category.

The public runtime substrate is Node `AsyncLocalStorage`: Node documents that it keeps stores coherent through async operations and recommends `run()` over `enterWith()` in ordinary use because `enterWith()` affects the rest of synchronous execution.[1]

## 2. Normative vocabulary and graph model

### 2.1 Graph

A `GraphSnapshotV1` is a directed labelled multigraph represented canonically as:

```ts
type NodeKind = 'route' | 'capability' | 'loader' | 'resource' | 'derived' | 'custom';
type EdgeKind = 'contains' | 'dependsOn';

type MetadataValue = string | number | boolean;

type NodeV1 = {
  id: string;
  kind: NodeKind;
  label: string;
  metadata: Record<string, MetadataValue | readonly MetadataValue[]>;
  observations: number;
};

type EdgeV1 = {
  from: string;
  to: string;
  kind: EdgeKind;
  observations: number;
};

type SnapshotMetadataPolicyV1 = {
  schema: MetadataSchema;
  sha256SaltFingerprint?: string;
};

type GraphSnapshotV1 = {
  format: 'runtime-impact-graph/v0.1';
  schemaFingerprint: string;
  metadataPolicy: SnapshotMetadataPolicyV1;
  nodes: readonly NodeV1[];
  edges: readonly EdgeV1[];
  cycles: readonly (readonly string[])[];
  warnings: readonly SnapshotWarningV1[];
};
```

Direction is **prerequisite/owner → dependent/contained**. Therefore `A -> B` means either “B was observed while A was the active semantic scope” (`contains`) or “B declares it depends on A” (`dependsOn`). A reader can follow arrows from an upstream change candidate to possible downstream impact; the library makes no claim that the relationship proves a reload, invalidation, or execution outcome.

A node has exactly one consumer-owned stable `id`, one semantic `kind`, a human `label`, declared metadata, and an aggregate observation count. `id` is the identity key; `kind` and `label` must be identical on every observation of that id. A node descriptor is rejected when `id` is empty, exceeds 128 UTF-16 code units, contains control characters, or conflicts with an existing descriptor. IDs must be stable names, not request IDs, user data, URLs with parameters, timestamps, or generated keys.

The initial kinds are intentionally small. `custom` requires `customKind` in declared metadata and does not create an unbounded kind namespace. A consumer should use the neutral kinds in the demonstration domain (route, capability, loader, resource, derived) before adding `custom`.

### 2.2 Two edge types; no implicit dependency inference

`contains` is an execution-containment observation. Calling `withNode(child, work)` while node `parent` is active registers `parent -> child` and increments its count once for each entered child scope. The root scope has no synthetic node and therefore creates no edge.

`dependsOn` is an explicit semantic dependency. Calling `dependsOn(fromId, toId)` registers `fromId -> toId` and increments it once. Both nodes must already be registered in the same graph. Explicit edges are never guessed from nesting; implicit containment is never reclassified as a dependency.

The graph stores one aggregate record per `(from, to, kind)`, not parallel raw events. This is a deliberate semantic graph with observation counts, not an event log. Graphviz supports directed edges and a `strict digraph` disallows multi-edges, which matches the DOT projection of this aggregated representation.[5]

### 2.3 Cycles

`dependsOn` cycles, including self-dependencies, are valid and serialize. `contains` must be acyclic: a self-containment edge or an edge that would close a containment cycle throws `ContainmentCycleError` before mutation. On snapshot and merge, the implementation computes strongly connected components over `dependsOn` edges only. `cycles` contains each component with two or more IDs, plus a singleton for a self-loop, with IDs and components canonically sorted. Cycles are facts to inspect, not automatic errors.

## 3. Runtime API and asynchronous boundary

The public v0.1 API is:

```ts
createGraph(options): Graph;
graph.run<T>(work: () => T | Promise<T>): T | Promise<T>;
graph.withNode<T>(node: NodeDescriptor, work: () => T | Promise<T>): T | Promise<T>;
graph.observe(node: NodeDescriptor): void;
graph.dependsOn(fromId: string, toId: string, options?: { metadata?: EdgeMetadata }): void;
graph.snapshot(): GraphSnapshotV1;
mergeSnapshots(snapshots: readonly GraphSnapshotV1[]): GraphSnapshotV1;
toCanonicalJson(snapshot: GraphSnapshotV1): string;
toDot(snapshot: GraphSnapshotV1): string;
```

`graph.run` creates an isolated execution root through one private `AsyncLocalStorage<ExecutionContext>` owned by that `Graph` instance. It must use `asyncLocalStorage.run(context, work)`, never `enterWith`. Node documents that separate `AsyncLocalStorage` instances are independent and that `run()` propagates its store to async operations created inside its callback.[1] Every `withNode` creates a new immutable context `{ graph, stack }`; the parent context is never mutated.

Rules:

1. `withNode` and `observe` require an active `graph.run`; otherwise they throw `NoActiveExecutionError` and make no graph mutation.
2. `withNode` pushes the descriptor only for `work`; its `finally` path returns the caller's context even when `work` rejects.
3. Two concurrent `graph.run` calls, including `Promise.all` siblings, have independent stacks and can aggregate into the same graph without cross-linking. Tests must prove this with intentionally interleaved timers and promises.
4. Work created inside a scope inherits that scope according to Node's async-context rules; work created before or after the scope is outside the contract. Detached callbacks, event emitters, manually constructed `AsyncResource`s, worker threads, child processes, and remote calls are observation boundaries. Node documents binding tools for event-driven work, but v0.1 does not wrap or patch them.[1]
5. A Graph instance is process-local and not thread-safe across worker threads. Each worker creates a graph and sends only snapshots for merge.
6. `dependsOn` requires an active execution in v0.1 so the observation count means “declared during a real observed execution”; it does not add an implicit containment edge.

`observe` registers a node and increments its observation count without changing the active stack or creating an edge. It is for meaningful leaf observations, not arbitrary function calls.

## 4. Determinism, identity, metadata and merge

### 4.1 Canonical order and serialization

Canonical JSON uses UTF-8, no insignificant whitespace, a fixed field order exactly as in `GraphSnapshotV1`, and a local bytewise Unicode code-point comparator (not `localeCompare`). The metadata policy schema and its rule fields are canonicalized before the graph fields. Nodes sort by `id`; edges by `from`, then `to`, then `kind`; metadata keys sort by the same comparator; string-array metadata sorts and deduplicates before serialization; cycles sort by first ID then lexicographically by their full member list. Numbers must be finite safe integers where a count is expected and finite JSON numbers in metadata. Serialization rejects `NaN`, infinities, `-0`, `undefined`, bigint, functions, symbols and object values.

A same-version equivalent snapshot must produce byte-identical JSON regardless of registration, completion, or merge order. Every snapshot carries its normalized `metadataPolicy`, making it self-contained across processes, workers, ESM/CJS module instances, and restarts. The `schemaFingerprint` is a SHA-256 digest of that canonical policy document, encoded as lowercase hexadecimal, so incompatible policy configurations cannot merge silently. When any rule uses `sha256`, the policy document also carries `sha256SaltFingerprint`, a domain-separated SHA-256 commitment to the salt; it never carries the salt itself. Thus identical schemas with different salts are incompatible rather than producing meaningless mixed digests.

### 4.2 Counts and merge

`observations` starts at zero only internally and is at least one in a snapshot. A successful node scope or `observe` increments its node count once. A successfully admitted edge call increments that edge count once. The counter maximum is `Number.MAX_SAFE_INTEGER`; an increment or merge sum beyond that throws `CountOverflowError` without partial mutation.

`mergeSnapshots` accepts a non-empty array with the same `format` and `schemaFingerprint`. It independently normalizes every carried policy, recomputes its fingerprint, and validates every node's metadata against that policy before any reduction, including when the input array contains only one snapshot. Validation rejects undeclared keys, constant/set shape mismatches, wrong represented types, length or set-cardinality violations, invalid `drop`/`replace`/`sha256` representations, and custom nodes without a represented non-empty string `customKind`. The merger then unions nodes by id and edges by key, sums counts exactly, merges metadata using the carried policy below, recomputes cycles, and canonically sorts the result. It is associative, commutative and idempotent only for an identical set of unique source snapshots; it is not a deduplicating transport protocol. Passing the same snapshot twice intentionally doubles observations. A caller that needs exactly-once ingestion must deduplicate outside this package using its own run identifier; v0.1 does not serialize run identifiers.

### 4.3 Metadata safety contract

Metadata is opt-in. `createGraph` requires a `metadataSchema` that declares every permitted key before the first observation:

```ts
type MetadataRule = {
  type: 'string' | 'number' | 'boolean';
  mode: 'constant' | 'set';
  maxDistinct?: number; // required for set; 1..32
  maxStringLength?: number; // default 128; 1..512
  redact?: 'none' | 'drop' | 'replace' | 'sha256'; // default drop
};
```

The implementation must reject undeclared keys, keys longer than 64 characters, nested objects, arrays supplied by callers, non-finite numbers, strings beyond the rule limit, and metadata operations that would exceed a declared set cardinality. It must not include a rejected value in an error message, warning, or export.

`constant` accepts a first value then requires byte-for-byte equality on every later observation and merge. `set` holds a sorted deduplicated set up to its required `maxDistinct`; all accepted values are rendered as arrays. Thus no policy depends on arrival order. `drop` removes the value before any cardinality accounting; `replace` stores the literal `"[REDACTED]"`; `sha256` stores a deterministic HMAC digest only when the graph has a caller-supplied non-empty salt. The raw salt is never exported, but its one-way compatibility fingerprint is. The complete normalized policy, including declared key names, types, limits, and redaction modes, is exported in every snapshot so another process can validate and merge it without ambient registration. Policy key names are therefore public interchange metadata and must not themselves contain secrets. Use a high-entropy salt: hashing is not anonymization, the salt fingerprint permits offline salt guesses, and neither fingerprinting nor HMAC makes low-entropy secrets or identifiers safe to export.

Graph limits default to 10,000 nodes and 50,000 aggregate edges per Graph. Limits are configurable downward only in v0.1. The default `onLimit` is `throw`; an explicit `onLimit: 'drop'` omits only the new node/edge, increments a fixed warning counter, and never records its identifier or metadata. This permits bounded best-effort demonstrations without leaking rejected values.

## 5. Packaging and compatibility

v0.1 is one dependency-free runtime package, with source boundaries rather than public subpackages:

- `src/runtime/`: `Graph`, AsyncLocalStorage adapter, and admission checks.
- `src/model/`: immutable snapshot types, canonical comparison, merge, cycle analysis.
- `src/format/`: canonical JSON and DOT pure formatters.
- `src/metadata/`: schema validation, redaction and cardinality reducers.
- `src/index.ts`: the only supported runtime entry point.
- `src/internal/`: unexported helpers; consumers may not deep-import it.
- `examples/`: neutral demonstration only; `bench/`: harness and raw result files; `test/`: unit, adversarial, concurrency and compatibility tests.

The published package is ESM-first with `type: "module"`. Its `exports` field exposes only `.` and the documented pure formatter subpaths, using conditional `import`, `require`, and `types` targets. Node documents that `exports` encapsulates undeclared subpaths and that conditional exports can serve different `import` and `require` implementations.[7] ESM and CJS builds must be generated from the same TypeScript source and run the same contract suite. Snapshot merge semantics must not depend on a mutable module-local registry: a snapshot created by ESM, CJS, a worker, or a previous process must be mergeable in a fresh module instance using only snapshot bytes. The build must include `.d.ts` declarations.

Supported runtime matrix: Node.js 22.15.x and later 22.x releases, plus Node.js 24.x; no other runtime is promised in v0.1. Node recommends production applications use Active or Maintenance LTS releases.[2] The release schedule lists Node 22 support through 2027-04-30 and Node 24 through 2028-04-30.[6] Node 20, browser runtimes, edge isolates, Deno, Bun, and worker-thread propagation are explicitly unsupported. The version floor avoids relying on experimental AsyncLocalStorage helpers; v0.1 only needs stable `run` and `getStore` semantics.[1]

Tests use `node:test`, which Node marks stable from v20.0.0.[8] The CI matrix runs the package's packed tarball under both supported lines with ESM and CJS smoke consumers. No framework, tracing SDK, graph renderer, native addon, network call, or telemetry dependency belongs in the runtime package.

## 6. Export contracts

`toCanonicalJson` returns the complete canonical snapshot described above, ending with exactly one newline. It is the interchange and golden-file format.

`toDot` returns a deterministic `strict digraph RuntimeImpactGraph` with a fixed graph/node/edge attribute preamble, quoted and escaped IDs and labels, one node statement per sorted node, and one edge statement per sorted edge. Each edge label is `kind × observations`; node labels contain `label` and `kind`, never metadata by default. DOT is deliberately the sole human-readable v0.1 export: Graphviz defines directed edges with `->` and accepts quoted IDs, making it a stable text projection.[5] A Mermaid adapter is deferred; Mermaid flowcharts also consist of nodes and edges and can represent subgraphs, but its authoring syntax is not the v0.1 interchange contract.[9]

Formatters are pure: they must not mutate snapshots, consult ambient context, render raw rejected metadata, or introduce timestamps, machine paths, random IDs, locale output, or line-ending variability. DOT always uses `\n` regardless of host OS.

## 7. Verification and benchmark contract

Required automated tests before a release candidate:

- unit tests for descriptor conflicts, edge aggregation, canonical ordering, DOT escaping, merge algebra, self loops, SCC ordering and count overflow;
- adversarial metadata tests for undeclared keys, constant/set shape mismatches, wrong types, long strings, dynamic-id examples, nested values, cardinality exhaustion, redaction representations, custom-node requirements, different-salt incompatibility, raw hash-salt non-export, and rejected-value non-disclosure, including malformed singleton snapshots;
- concurrency tests using at least two interleaved roots with nested promises and timers, proving no cross-root containment edges;
- error tests proving context restoration after synchronous throw and async rejection;
- ESM and CJS import/require smoke tests from a packed tarball on Node 22 and 24, plus a fresh-process merge that created neither input graph;
- golden tests that compare byte-for-byte canonical JSON from differently ordered equivalent executions and merges.

Benchmarks are not production-safety proof. The harness records: package commit, Node full version, OS, CPU model, architecture, run date, exact command, warm-up count, measured iteration count, graph limits and metadata schema. It reports raw JSON plus median, p95 and mean elapsed time per operation, heap delta before/after an explicit GC-enabled run where available, and output bytes. It includes five scenarios: baseline callback, `graph.run` only, one `withNode`, ten nested nodes, and two interleaved roots with ten nodes each. Run five fresh processes per scenario after 1,000 warm-up operations and 100,000 measured operations; retain all raw samples. Compare against the same Node command without instrumentation and publish absolute times, not only percentages.

## 8. Non-goals and observation limits

v0.1 does not do static dependency analysis, automatic function-call capture, source parsing, framework instrumentation, distributed propagation, remote exporters, trace timing/status/events, persistence, visualization layout, impact planning, cache behavior, or automatic remediation. It does not infer that an absent edge is impossible, that an observed edge is exhaustive, or that an edge predicts performance, freshness, correctness, security, cost, or a safe execution order.

An observed graph is only the named semantic work that ran under an active `graph.run` and passed admission rules. Consumers own the meaning and stability of their node IDs. The library is safe-by-default about declared metadata but cannot prove that a consumer selected safe identities or labels; review of consumer instrumentation remains mandatory.

## 9. Scaffold-builder handoff

Build in this order: (1) immutable model plus canonical comparator and serializer; (2) metadata admission/redaction reducer; (3) `Graph` with private AsyncLocalStorage and failure-safe scopes; (4) explicit edges, merge and SCC analysis; (5) DOT formatter; (6) neutral example, packed-package compatibility consumers and benchmark harness. Do not add an adapter, framework integration, visual UI, or planner API while this contract is being scaffolded.

The only intentionally deferred decision is the public package name/scope, because no name is reserved in this milestone. All other v0.1 API, behavior, compatibility, test, and export decisions are frozen by this document.

## Sources

[1] https://nodejs.org/api/async_context.html
[2] https://nodejs.org/en/about/previous-releases
[3] https://opentelemetry.io/docs/concepts/signals/traces
[4] https://github.com/pahen/madge
[5] https://graphviz.org/doc/info/lang.html
[6] https://github.com/nodejs/Release/blob/main/schedule.json
[7] https://nodejs.org/api/packages.html
[8] https://nodejs.org/api/test.html
[9] https://mermaid.js.org/syntax/flowchart.html
