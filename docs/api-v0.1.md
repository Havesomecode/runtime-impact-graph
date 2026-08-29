# Runtime Impact Graph v0.1 API

This page is the practical API guide. The normative behavior, validation rules,
and support policy remain frozen in
[`architecture-contract-v0.1.md`](./architecture-contract-v0.1.md).

## Create a graph

```ts
import { createGraph } from '@havesomecode/runtime-impact-graph';

const graph = createGraph({ metadataSchema: {} });
```

`metadataSchema` is required. An empty schema is the safest starting point:
every metadata key is rejected, so no values can enter the graph by accident.

`createGraph(options)` accepts:

- `metadataSchema`: the complete allowlist of metadata keys and rules.
- `metadataSalt`: required when any rule uses `redact: 'sha256'`. The raw salt is
  never exported.
- `maxNodes`: at most 10,000; defaults to 10,000.
- `maxEdges`: at most 50,000 aggregate edges; defaults to 50,000.
- `onLimit`: `throw` by default, or `drop` to count a warning without retaining
  an over-limit identifier.

Limits can be lowered, not raised.

## Capture execution

```ts
await graph.run(async () => {
  await graph.withNode(route, async () => {
    await graph.withNode(loader, loadContext);
  });
});
```

- `graph.run(work)` creates an isolated root execution context. It does not add a
  synthetic node.
- `graph.withNode(descriptor, work)` observes the node, makes it active for
  `work`, and records `activeParent -> descriptor` as a `contains` edge.
- `graph.observe(descriptor)` observes a node without changing the active scope.
- `graph.dependsOn(fromId, toId)` records `fromId -> toId`. Read it as “the node
  at `toId` depends on the node at `fromId`.” Both nodes must already exist.
- `graph.snapshot()` returns the current portable v0.1 aggregate.

`run`, `withNode`, `observe`, and `dependsOn` record observations. They do not
wrap arbitrary functions, infer imports, or collect timings and request events.

## Describe nodes

```ts
const loader = {
  id: 'loader:place-context',
  kind: 'loader',
  label: 'Place context loader',
};
```

Supported kinds are `route`, `capability`, `loader`, `resource`, `derived`, and
`custom`. A `custom` node also needs a declared constant `customKind` metadata
rule.

IDs are consumer-owned stable names. Do not use request IDs, account IDs,
parameterized URLs, timestamps, generated keys, or values copied from payloads.
A repeated ID must keep the same kind, label, and constant metadata.

## Declare metadata deliberately

```ts
const graph = createGraph({
  metadataSchema: {
    environment: {
      type: 'string',
      mode: 'constant',
      maxStringLength: 16,
      redact: 'none',
    },
  },
});
```

A rule declares a primitive type, aggregation mode, optional bounds, and
redaction mode:

- `drop` is the default and exports no value.
- `replace` exports `[REDACTED]`.
- `sha256` exports a salted one-way digest and requires `metadataSalt`.
- `none` exports the original primitive value and therefore needs deliberate
  review.

`set` rules require a bounded `maxDistinct`. Policy key names and rule details
are exported in snapshots, so key names themselves must not contain secrets.

## Serialize and merge

```ts
import {
  mergeSnapshots,
  toCanonicalJson,
  toDot,
} from '@havesomecode/runtime-impact-graph';

const merged = mergeSnapshots([firstSnapshot, secondSnapshot]);
const json = toCanonicalJson(merged);
const dot = toDot(merged);
```

`mergeSnapshots` validates portable policies, sums safe observation counts,
and returns a canonical aggregate independent of input order. Conflicting node
facts, incompatible metadata policies, count overflow, malformed snapshots, and
containment cycles are rejected.

`toCanonicalJson` writes newline-terminated deterministic JSON. `toDot` writes a
metadata-free Graphviz projection. Formatter-only imports are also available at
`@havesomecode/runtime-impact-graph/json` and
`@havesomecode/runtime-impact-graph/dot`.

Dependency cycles are valid graph facts and appear as sorted strongly connected
components in `snapshot.cycles`. Containment cycles throw
`ContainmentCycleError` before mutation.

## Named errors

The root entry point exports:

- `NoActiveExecutionError`: a capture call required `graph.run(...)`.
- `ContainmentCycleError`: a containment edge would create a cycle.
- `CountOverflowError`: an aggregate count would exceed
  `Number.MAX_SAFE_INTEGER`.

Other malformed inputs and policy conflicts use `TypeError` or `RangeError`.
Callers should not parse error messages for rejected input values; validation
messages intentionally avoid echoing consumer data.
