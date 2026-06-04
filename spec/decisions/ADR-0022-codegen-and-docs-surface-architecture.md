# ADR-0022: Codegen & documentation surface architecture (consolidated)

**Status:** Accepted
**Date:** 2026-06-04
**Supersedes:** ADR-0020 (codegen tiering), ADR-0021 (codegen surface coherence)
**Relates to:** ADR-0015 (single shared migrate engine)

> This ADR consolidates ADR-0020 + ADR-0021 and adds the documentation-surface
> boundary, because the decisions were split across files in a way that read as a
> conflict the moment the deferred SDK/API docs were built. ADR-0020/0021 remain
> as historical records, marked *Superseded by ADR-0022*. **This is the single
> canonical statement of the codegen + documentation surface architecture.**

## Context

A 5-language metadata standard (TS/Python/C#/Java/Kotlin) accrues many generation
concerns — native code (entities, payloads, validators, render-helpers, ORM
bindings, API routes), schema migrations, documentation. Every new concern
reopens the same questions: *build it once and share it, or per-port? one front
door or many? where do docs go?* Benchmarking (protoc/Buf plugin model, Smithy
directed-codegen, Prisma's engine split, jOOQ, vs OpenAPI Generator's
"Java-like" non-idiomatic output) converges on a clear shape, captured below.

## Decision

### Part 1 — Tiering: native-per-port vs neutral-shared

Tier generation by **what the artifact IS, not which language is convenient.**

- **Tier 1 — native code generators: per-port, idiomatic.** Output is source code
  in the target language that must be idiomatic *and* run in the developer's own
  build (entities, payloads, validators, render-helpers, ORM bindings, API
  routes). Stays per-port; collapsing to one tool is the OpenAPI-Generator trap
  (non-idiomatic output + forced foreign toolchain). The N implementations are
  the product's differentiator.
- **Tier 2 — neutral artifact generators: one shared engine.** Output is
  language-neutral text — identical regardless of port: schema migrations (SQL,
  `migrate-ts` per ADR-0015), **neutral metadata documentation** (Markdown),
  future OpenAPI/Mermaid/JSON-schema. One TS implementation, shipped in the
  standalone binary; a per-port reimplementation is N× maintenance for 0 benefit.

**Dividing test:** *Does the output depend on the implementing language?*
**Yes → Tier 1 (per-port).  No → Tier 2 (shared).**

### Part 2 — Surface coherence (one vocabulary)

The per-port generator *count* (~71) is principled mirroring (one concept × N
languages). The confusion was the cross-cutting surface. Resolved:

- **D1 — `meta docs` is the single door for *neutral metadata* documentation.**
  The neutral metadata-doc engine (Part 3) is reached only via `meta docs`, never
  the `meta gen` pipeline. (`docsFile`/`mermaid-er` stay deprecated from the gen
  suite.) *This rule governs the neutral docs category only — see Part 3 for
  SDK/API docs.*
- **D2 — `verify` is unified to subverbs** `--db` (schema drift) / `--codegen`
  (regen-and-diff) / `--templates` (template/prompt drift), the same meaning in
  every port; bare `verify` keeps each port's historical default. `--db` is
  TS-only (migrate engine); others reject it.
- **D3 — Generators are selected by a stable name** via a per-port registry +
  `gen --list`, conformance-gated against the canonical manifest
  (`fixtures/generator-registry-conformance/registry.json`). Shared concepts
  (`entity`, `routes`, `output-parser`, …) spell identically across ports. Java/
  Kotlin Maven resolve `<name>` via a `GeneratorRegistryProvider` ServiceLoader
  SPI; TS config accepts stable-name strings; `<classname>` back-compat.
- **D4 — The legacy Java `MustacheTemplateGenerator` is deprecated** in favor of
  the conformance-pinned `render/templategen/TemplateGenerator`.

### Part 3 — Documentation surfaces: `meta docs` vs `api-docs`

There are **two distinct documentation surfaces** — do not conflate them:

- **`meta docs` — neutral METADATA docs (Tier 2).** Documents the *model*:
  entities, fields, constraints, identities, relationships, `template.output`
  contracts, the Mermaid ER diagram. **Language-neutral**, one shared **TS**
  engine, Mustache-rendered, no `--target`, single door (D1). A neutral doc must
  not name a language artifact ("see `OrderInsertSchema` (Zod)" is a leak).
- **`api-docs` — per-project SDK/API REFERENCE (Tier 1).** Documents *the API the
  codegen produced* for this project: per entity/template, the concrete symbols,
  signatures, endpoints, and usage **in the target language** (`createAuthor`,
  the REST routes, `extractAuthor`, `renderWelcomeEmail`). **Language-specific →
  Tier 1 → per-port**, emitted by the port that owns that API (accurate by
  construction — reuses the real generators' naming/signature logic). It is a
  **generator** (D3 registry; `api-docs`), in the `meta gen` world — **not** a
  `meta docs` mode, because `meta docs` is neutral/TS-only and cannot produce a
  C#/Java API reference. Renders two forms from one model: a human docs-site form
  (per-entity pages + index) and an agent/LLM form (condensed, token-budgeted).

**Shared mechanism:** both surfaces render Markdown through the same `render()`
Mustache engine + canonical byte-identity-gated `templates/`. The *rendering
mechanism* is consistent; the *command*, *tier*, and *neutral-vs-language-specific*
nature differ.

**Documentation dividing test:** *Does the documented content depend on the
implementing language?* **No** (the model) → `meta docs`. **Yes** (the generated
API surface) → `api-docs`.

## Consequences

- One canonical place for the codegen + docs architecture (this ADR). A
  contributor unsure where work goes consults Parts 1–3 and the two dividing
  tests.
- Neutral artifacts (migrations, metadata docs, OpenAPI, Mermaid) are Tier 2,
  shared, single-engine. Native code and the per-language SDK reference are
  Tier 1, per-port, registry-selected.
- `meta docs` stays purely neutral; SDK/API docs ride the generator surface as
  `api-docs` — resolving the apparent D1-vs-Tier-1 conflict.
- ADR-0020 and ADR-0021 are superseded by this ADR; their numbers remain as
  pointers so existing references resolve.
