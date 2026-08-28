# Clean-room provenance record — v0.1 architecture contract

Status: frozen for the v0.1 scaffold handoff

## Boundary

The architecture contract was created from the approved product programme and public documentation only. It does not import, quote, inspect, request, or depend on any pre-existing private application source, identifiers, fixtures, schemas, documents, infrastructure, credentials, or domain terminology.

The contract uses neutral example vocabulary only: route, capability, loader, resource, derived data and custom semantic unit. These terms define the product API; they are not evidence about any external system.

## Evidence set

The authoritative public evidence set is mechanically recorded in `docs/citation-ledger.json`; the rendered citations in `docs/architecture-contract-v0.1.md` are generated from that ledger. It covers Node asynchronous-context and package behavior, Node support dates, standard graph/export formats, a static module-graph reference, and an observability-tracing reference.

## Implementation guardrails

Scaffold work must preserve these constraints:

1. Use the architecture contract as the sole behavior authority for v0.1.
2. Keep examples synthetic and neutral; do not add real system names, routes, identifiers, values, fixtures, or copied schemas.
3. Add only public upstream references necessary to verify Node/package/runtime behavior, and register each one in the citation ledger before citing it.
4. Treat labels, IDs and metadata as consumer supplied. The safety contract must reject unsafe shapes and make no claim to classify all sensitive data.
5. Stop and escalate a proposed change that would require external private material rather than attempting to reconstruct it.

## Review checklist

- [ ] No private material appears in paths, code, test names, fixtures, examples, benchmarks, documentation, commits or generated output.
- [ ] Every external factual claim in the architecture contract has an inline ledger citation.
- [ ] The package remains framework-independent and dependency-free at runtime.
- [ ] The public API and semantic model match `architecture-contract-v0.1.md`.
