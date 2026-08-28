# Runtime Impact Graph

Build deterministic semantic dependency graphs from real Node.js execution.

## v0.1 status

The implementation contract is frozen. The next milestone scaffolds the package against the following durable documents:

- `docs/architecture-contract-v0.1.md` — API, model, async-context, determinism, safety, packaging, export and benchmark contract.
- `docs/clean-room-provenance.md` — clean-room boundary and review guardrails.
- `docs/citation-ledger.json` — machine-owned source-to-citation mapping.

This project records consumer-defined semantic relationships from observed asynchronous work. It is not static dependency analysis, automatic call tracing, or a distributed tracing replacement.
