# Runtime Impact Graph

Build deterministic semantic dependency graphs from real Node.js execution.

## v0.1 package foundation

The repository now contains the reusable TypeScript package foundation for the
frozen v0.1 contract:

- `docs/architecture-contract-v0.1.md` — API, model, async-context,
  determinism, safety, packaging, export, and benchmark contract.
- `docs/clean-room-provenance.md` — clean-room boundary and review guardrails.
- `docs/citation-ledger.json` — machine-owned source-to-citation mapping.

The manifest name and `0.0.0-development` version are local development
identifiers. The package is private; they do not reserve or decide a public npm
name, scope, or release version.

This project records consumer-defined semantic relationships from observed
asynchronous work. It is not static dependency analysis, automatic call
tracing, a distributed tracing replacement, or proof that an observed
relationship caused a reload, invalidation, or execution outcome.

## Requirements

- Node.js `>=22.15 <23` or `>=24 <25`
- npm 10 or later

## Develop and verify

```sh
npm ci
npm run verify
```

`npm run verify` checks formatting, lint, strict TypeScript types, contract
behavior, and both ESM and CommonJS builds. Runtime dependencies are empty.

Focused commands are also available:

```sh
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
```

## Public API

The runtime entry point exports:

- `createGraph(options)` and `Graph`
- `mergeSnapshots(snapshots)`
- `toCanonicalJson(snapshot)`
- `toDot(snapshot)`
- the v0.1 model types and named contract errors

The formatter-only subpaths are `runtime-impact-graph/json` and
`runtime-impact-graph/dot`. Both the root and formatter subpaths provide ESM,
CommonJS, and TypeScript declaration outputs.

```ts
import {
  createGraph,
  toCanonicalJson,
} from 'runtime-impact-graph';

const graph = createGraph({ metadataSchema: {} });

await graph.run(async () => {
  await graph.withNode(
    { id: 'route:home', kind: 'route', label: 'Home' },
    async () => {
      graph.observe({
        id: 'resource:theme',
        kind: 'resource',
        label: 'Theme',
      });
    },
  );
});

process.stdout.write(toCanonicalJson(graph.snapshot()));
```

Metadata is rejected unless its key is declared. Redaction defaults to `drop`;
`sha256` requires a caller-provided non-empty salt. Graph cardinality defaults
to 10,000 nodes and 50,000 aggregate edges and can only be configured downward.
See the frozen architecture contract for the complete safety and semantics.
