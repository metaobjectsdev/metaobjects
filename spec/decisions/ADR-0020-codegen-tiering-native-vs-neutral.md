# ADR-0020: Codegen tiering — native-per-port vs neutral-shared

> **⚠️ Superseded by [ADR-0022](ADR-0022-codegen-and-docs-surface-architecture.md)**
> (consolidated codegen + documentation surface architecture). Kept as a
> historical record; ADR-0022 is the current canonical statement.

**Status:** Superseded by ADR-0022
**Date:** 2026-06-02
**Supersedes / relates to:** ADR-0015 (single shared migrate engine), ADR-0016 (build migration apply runner)

## Context

MetaObjects is a cross-language metadata standard with five ports (TypeScript,
Python, C#, Java, Kotlin). Over time we have accumulated several distinct
generation concerns: native code (entities, payloads, validators, render
helpers, ORM/persistence bindings, API routes), schema migrations, and
documentation. Each new concern has reopened the same question: *do we build it
once and share it, or implement it per port?*

We answered this ad hoc. Schema migrations were consolidated into one shared
TypeScript engine (ADR-0015/0016, `migrate-ts`) shipped as a standalone binary.
Code generation stayed per-port and idiomatic. Documentation generation exists
only in TypeScript today, and a recent review surfaced the risk that someone
would "helpfully" reimplement the docs data-builder in all five ports —
duplicating logic five times for zero benefit.

We need a single, principled rule so the next contributor does not have to
relitigate this for every artifact.

### What the industry has learned

Two architectures dominate multi-language generation:

1. **Single tool emits all languages** (OpenAPI Generator, Swagger Codegen,
   protoc + plugins, gnostic). One model parser, many template/plugin backends.
   The well-documented failure mode: output feels like the tool's host language
   ("Java-like" Python/TypeScript/Go from OpenAPI Generator), it forces a
   foreign toolchain (JVM) into every project, and it has an N×M problem
   (languages × frameworks). Generated code "tends to be generic instead of
   idiomatic" and needs manual refinement.

2. **Idiomatic per-ecosystem** (Fern, Stainless, Speakeasy; jOOQ, ent, EF). Each
   language community gets native, idiomatic output. This is what developers
   actually accept for code they live in.

Prisma is the instructive synthesis: a **single shared engine** for the
language-neutral concerns (its "schema engine" = migrations + introspection)
kept *separate* from client code generation — and it recently moved that engine
to TS/WASM so it no longer requires a native binary, runnable anywhere JS runs.

## Decision

**Tier generation by what the artifact IS, not by which language is convenient.**

### Tier 1 — Native code generators: per-port, idiomatic

Artifacts whose **output is source code in the target language** that must be
idiomatic *and* run inside the developer's own build/toolchain.

- Examples: entity models, payload/extract types, input validators, render
  helpers, ORM/persistence bindings, API routes/controllers.
- **Stay per-port.** Each port emits idiomatic code via its native builder
  (ts-poet, KotlinPoet, C# records, Python Pydantic, Java emission) and runs in
  the native build (`mvn meta:gen`, `dotnet meta gen`, bun, gradle).
- Rationale: collapsing these to one tool is the OpenAPI Generator trap —
  non-idiomatic output plus a forced foreign toolchain. Native, idiomatic,
  build-integrated code generation is the product's differentiator.
- The N implementations are justified because per-language *is* the better
  developer experience here.

### Tier 2 — Neutral artifact generators: one shared engine

Artifacts whose **output is language-neutral text** — identical regardless of
which port (if any) an adopter implements against.

- Examples: schema migrations (SQL — already `migrate-ts`), **metadata
  documentation** (Markdown describing the model), and future neutral outputs
  (OpenAPI spec, Mermaid ERD, JSON-schema export).
- **Build once, share.** A single implementation (TypeScript, consuming the
  serialized metadata) shipped as part of the standalone `meta` binary so any
  adopter runs it without a Node toolchain — the same delivery that makes
  `migrate-ts` acceptable to a C#/Java shop.
- Rationale: a per-port reimplementation produces byte-identical output for N×
  the maintenance and drift risk, and gives the developer nothing — a Java dev
  gains nothing from a Java-implemented Markdown walker.

### The dividing test

> Does the output depend on the implementing language?
> **Yes → Tier 1 (per-port).  No → Tier 2 (shared).**

"Better per-language DX" justifies Tier 1 only when the output is language code.
For neutral text it is pure cost.

### Docs are two things — do not conflate them

- **SDK / API docs** ("how to call `Order.insert()` in C#") are **language-
  specific** → Tier 1, alongside native codegen. Out of scope until/unless we
  choose to build them.
- **Metadata docs** (the entity/field/identity/relationship/template model)
  make **no assumption about the implementing language** → Tier 2, shared, no
  `--target`. This is the metadata-documentation engine.

A neutral metadata doc must not name a language artifact. Documenting a
constraint as "see `OrderInsertSchema` (Zod)" is an SDK-doc leak; the neutral
fact is the **constraint metadata itself** (required, maxLength, enum
membership, validators).

## Consequences

- The shared seam stays: all tiers read the same conformance-pinned metadata
  JSON; shared Mustache templates carry a per-port byte-identity gate.
- Documentation is Tier 2: a single engine, **not** ported to the other four
  languages. The existing TypeScript docs generator is repositioned as that
  engine and neutralized (drop the Zod/generated-file SDK sections).
- Future neutral artifacts (OpenAPI, Mermaid, JSON-schema) default to Tier 2.
- Future SDK/API docs, if built, are Tier 1 (per-port) and explicitly separate
  from metadata docs.
- A contributor proposing to reimplement a Tier 2 artifact per port should be
  pointed at this ADR.
