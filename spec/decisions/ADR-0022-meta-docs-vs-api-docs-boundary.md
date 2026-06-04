# ADR-0022: `meta docs` (neutral metadata docs) vs `api-docs` (SDK/API reference) — the documentation-surface boundary

**Status:** Accepted
**Date:** 2026-06-04
**Relates to / clarifies:** ADR-0020 (codegen tiering — "Docs are two things"),
ADR-0021 D1 (`meta docs` is the single door)

## Context

The project has two *different* documentation concerns, and the decisions about
them are split across two ADRs in a way that reads as a contradiction when you
build the second one:

- **ADR-0020** ("Docs are two things — do not conflate them") established:
  - **Metadata docs** (neutral, language-independent: entities/fields/
    constraints/relationships/templates) → **Tier 2**, one shared TS Mustache
    engine, no `--target` → the `meta docs` command.
  - **SDK/API docs** ("how to call `Order.insert()` in C#") → **Tier 1,
    language-specific, per-port, alongside native codegen** — explicitly
    *separate from metadata docs*, and *out of scope until/unless built*
    (ADR-0020 lines 91–114, esp. line 113).
- **ADR-0021 D1** then made `meta docs` "the single door for documentation" and
  said "documentation is a Tier-2 neutral artifact… must NOT be reachable through
  the Tier-1 `meta gen` pipeline." This deprecated `docsFile` from the gen suite.

When we now build the SDK/API docs (the per-project generated-API reference),
D1 *reads* as banning them from `meta gen`, contradicting ADR-0020's placement of
SDK docs as Tier-1 "alongside native codegen." D1's intent was the *neutral
metadata* docs (the only docs that existed when it was written), but it does not
say so crisply — so the boundary is not findable without re-deriving it. This
ADR pins it.

## Decision

There are **two distinct documentation surfaces**:

### 1. `meta docs` — neutral METADATA documentation (Tier 2)
- Documents the **model**: entities, fields, constraints, identities,
  relationships, `template.output` contracts, the Mermaid ER diagram.
- **Language-neutral** (names no language artifact), one shared **TS** engine,
  Mustache-rendered, no `--target`.
- **`meta docs` is the single door for this category** (ADR-0021 D1). The `docs`/
  `mermaid-er` generators stay deprecated from the `meta gen` suite.

### 2. `api-docs` — per-project SDK/API REFERENCE (Tier 1)
- Documents **the API the codegen produced** for *this* project: per entity/
  template, the concrete symbols, signatures, endpoints, and usage **in the
  target language** (`createAuthor`, the REST routes, `extractAuthor`,
  `renderWelcomeEmail`, …).
- **Language-specific → Tier 1 → per-port**, emitted by the port that owns that
  API (accurate by construction — it reuses the real generators' naming/signature
  logic). It is a **generator** (ADR-0021 stable-name registry; e.g. `api-docs`),
  living in the codegen/`meta gen` world — **not** a `meta docs` mode, because
  `meta docs` is neutral/TS-only and cannot produce a C#/Java API reference.
- Renders to two forms from one model: a **human** docs-site form (per-entity
  pages + index) and an **agent/LLM** form (condensed, token-budgeted).

### Shared mechanism
`api-docs` renders its Markdown through the **same shared `render()` Mustache
engine + canonical `templates/`** (byte-identity-gated) that `meta docs` uses.
The *rendering mechanism* is consistent across both surfaces; the *command*,
*tier*, and *neutral-vs-language-specific* nature differ.

### Clarification of ADR-0021 D1
"Documentation" in D1 means **neutral metadata docs**. The single-door rule and
"not through `meta gen`" apply to *that* category. **SDK/API docs are the Tier-1
carve-out from ADR-0020 and legitimately ride the generator surface** — they are
*not* what D1 governs.

## The dividing test (reuse ADR-0020's)
> Does the documented content depend on the implementing language?
> **No** (the model) → `meta docs` (Tier 2, neutral, single door).
> **Yes** (the generated API surface) → `api-docs` (Tier 1, per-port, a generator).

## Consequences
- The boundary is findable: a contributor unsure where doc work goes consults
  this ADR.
- `api-docs` is a registered generator (registry + `--list` + conformance),
  per-port, starting with a TS pilot; it does **not** pollute the neutral
  `meta docs` engine.
- `meta docs` stays purely neutral; D1 remains correct for its category.
- Both render via the shared Mustache engine + canonical templates, so the
  byte-identity/template discipline covers both.
