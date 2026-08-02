# MetaObjects Specification

The cross-language design documentation for the MetaObjects standard. This directory is the **target-agnostic source of truth** -- every language implementation (TypeScript, C#, Java, Python, Kotlin) is built against this spec and validated by the shared conformance fixtures.

## What MetaObjects defines

A typed metadata standard for declaring entity models, identities, relationships, validations, views, layouts, and storage sources -- once, in a canonical form, then consumed by:

- **Code generators** that emit idiomatic per-language code (Drizzle/Zod + Fastify on TypeScript, EF Core + ASP.NET on C#, Spring controllers + DTOs + repos via `codegen-spring` on Java, Pydantic + FastAPI on Python, KotlinPoet + Exposed + Spring on Kotlin).
- **Runtime loaders** that read the metadata at runtime to drive CRUD, validation, relationships, dynamic admin UIs, and LLM tool registration.
- **Drift checks** (`meta verify`) that flag divergence between code and metadata across entity codegen, prompt templates, output parsers and live database schema — plus the compile-time breakage the generated types cause on their own.
- **Prompt construction** *(the fourth pillar)* that makes an LLM prompt a declared, deterministic, testable artifact instead of a scattered string: a typed payload declared as a projection (so payload bloat is visible), external provider-resolved prompt text, a deterministic render that is snapshot-testable and cache-stable, and build-time prompt↔payload drift detection — conformance-gated so the guarantee holds in every language port. Render, payload value-object codegen, `verify`, parser-on-receipt and the tolerant `extract` parser ship in all five ports today; MCP exposure of declared prompts and tools is the remaining library-side piece (see [`roadmap.md`](roadmap.md)). See the FR-004 design doc under [`../docs/superpowers/specs/`](../docs/superpowers/specs/).

The substrate is local-first: typed metadata lives in your repo at `metaobjects/`, generated code is idiomatic per-language output that runs **without any MetaObjects dependency at runtime**. If `@metaobjectsdev/*` packages disappeared tomorrow, your generated code keeps working.

## The metamodel in one paragraph

The metamodel is built from 13 base types: `metadata`, `object`, `field`, `attr`, `validator`, `view`, `layout`, `identity`, `index`, `relationship`, `source`, `origin`, `template`. Each type has subtype-specific child rules and attributes. Every node is encoded as a single-key map of the shape `{ "<type>.<subType>": <body> }` -- the wrapper key fuses type and subType (there is no separate `subType` body key). Reserved structural body keys are `name`, `package`, `extends`, `abstract`, `overlay`, `isArray`, `children`, and `value`; everything else inside a node body is an `@`-prefixed attribute (e.g. `@column`, `@currency`, `@fields`). Full vocabulary in [`metamodel.md`](metamodel.md).

## The wire format in one paragraph

JSON. Metadata files live in `metaobjects/` at project root, organized by domain concept (e.g., `meta.commerce.json`). Each file declares its package on the root node. Multiple objects per file when they share a domain; projections live inline with their base entities. Files are scanned recursively. Same-package + same-name objects across files are merged by the Loader via overlay semantics -- extending or partially overriding without recompilation. The canonical serializer enforces strict body-key order so that the same loaded model produces byte-identical output in every language implementation. Full format and key-order rules in [`wire-format.md`](wire-format.md).

## How parity is enforced

Each implementation passes the same conformance fixtures under [`fixtures/conformance/`](../fixtures/conformance/) -- 258 shared test cases, plus a `CAPABILITIES.json` manifest (which optional behaviours a port declares) and an `ERROR-CODES.json` ledger (the shared error-code vocabulary). It is one of 19 shared corpora; the full corpus x port matrix is in [`docs/CONFORMANCE.md`](../docs/CONFORMANCE.md). Each fixture is a directory with `input/` metadata files and either an `expected.json` (happy-path canonical output) or `expected-errors.json` (error case). The Loader is expected to either produce byte-identical canonical output, or emit the exact set of expected error messages. Without this shared test surface, each language's Loader behavior would drift independently -- overlay merging working one way in TypeScript and a subtly different way in Java, and nobody noticing until a real consumer hit the mismatch. Conformance fixtures make parity testable, not aspirational. Format and contract in [`conformance-tests.md`](conformance-tests.md).

## Documents in this directory

| Doc | Purpose |
|---|---|
| [`metamodel.md`](metamodel.md) | The 11-type vocabulary, structural keys, subtypes, fused-key node encoding. The normative type system. |
| [`wire-format.md`](wire-format.md) | JSON shape, body-key order, package resolution, overlay merging, attribute value rules. The normative serialization contract. |
| [`conformance-tests.md`](conformance-tests.md) | How to run cross-language conformance fixtures. The contract every implementation passes. |
| [`roadmap.md`](roadmap.md) | Shipped milestones per port, active work, and the planned path to the 1.0 metamodel line. |
| [`design-docs/`](design-docs/) | Project design documents -- historical context and current in-flight design decisions. |
| [`cross-language-metadata-spike-findings.md`](cross-language-metadata-spike-findings.md) | The initial multi-language spike that informed the standard. |

## How to read this spec

- **You're implementing a Loader in a new language?** Start with [`metamodel.md`](metamodel.md) for the type vocabulary, then [`wire-format.md`](wire-format.md) for parsing and canonical output, then run your implementation against the fixtures in [`fixtures/conformance/`](../fixtures/conformance/) per the contract in [`conformance-tests.md`](conformance-tests.md). Compare your canonical output byte-for-byte against the expected outputs.
- **You're consuming MetaObjects to generate code in your project?** You don't need to read the spec end-to-end. The per-language quickstarts in the implementation directories ([`server/typescript/`](../server/typescript/), [`server/java/`](../server/java/), [`server/csharp/`](../server/csharp/)) cover the consumer path. Come back to the spec only when something behaves unexpectedly.
- **You're an AI agent working with MetaObjects?** The site at [metaobjects.dev](https://metaobjects.dev) ships an `llms.txt` and `llms-full.txt` that summarize this spec and the implementation status. Load those into your context, then reach into this directory only for normative details.

## License

Apache License 2.0. The spec is freely usable; the reference implementations are freely usable. The standard is meant to be picked up and implemented by anyone, including other organizations building competing or parallel runtimes.
