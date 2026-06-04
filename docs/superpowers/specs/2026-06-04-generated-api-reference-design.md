# Per-project generated-API reference — design

**Date:** 2026-06-04
**Status:** Design (pending review)
**Relates to:** ADR-0020 (codegen tiering — this is the deferred Tier-1 SDK-docs
layer), ADR-0021 (generator registry / `--list`), the neutral `meta docs`
engine, the downstream agent-context effort (separate, sibling-owned).

## Goal

Generate, from an adopter's metadata, a reference of **the API their codegen
actually produced** — for each entity and `template.output`, the concrete
symbols, signatures, and usage *in their language* — and render it **two ways
from one source**:

1. a **human** docs-site form (per-entity reference pages + a consolidated
   index), and
2. an **agent/LLM** form (a single condensed, token-budgeted reference) that the
   coding agent installed by `meta init` can read to call the generated API
   correctly.

This is the per-language **SDK reference** that ADR-0020 deferred (Tier-1,
language-specific) — distinct from the neutral `meta docs` (which describes the
*model*, not how to call the generated code), and distinct from agent-context
(which teaches the *framework* in general, not the adopter's specific API).

**Pilot scope: TypeScript only.** Prove the shape + value on a real model, then
decide the cross-port fan-out mechanism. Full generated surface (not a subset).

## Why this fits cleanly

- It is a **new generator** (`api-docs`) → slots into the ADR-0021 stable-name
  registry + `--list` + conformance machinery. Its own files; no collision with
  the agent-context core.
- **Tier-1 by ADR-0020** (content is language-specific) → emitted by the port
  that owns the API, **accurate by construction**: it reuses the *actual*
  generators' naming/signature logic, so the docs cannot drift from the code.
- It meets the agent surface only at the **output files** — agent-context's
  `meta init` can reference the generated agent-form file; this design does NOT
  edit the sibling's install/assembly code.

## What it documents (full generated surface, per the default TS suite)

For each **entity** (`object.entity` / value object):
- **Model** — the generated type/module (`<Entity>.ts`): fields + TS types.
- **Data access** — the query helpers (`<Entity>.queries.ts`): `findById`,
  `create`, `updateById`, `deleteById`, `list`/find-many (exactly what
  `queries-file` emits — skips helpers it legitimately omits, e.g. no PK → no
  `findById`).
- **REST** — the routes (`<Entity>.routes.ts`): method + path + body/response
  per endpoint (Fastify `routes-file` and/or Hono `routes-file-hono`).
- **Validation** — the generated input validators (insert/update schemas) and
  what they enforce.
- **Callable/service** surface where generated (`callable-file`).

For each **`template.output`**:
- **Extractor** (`<Template>.extractor.ts`): `extract<Name>(text)` /
  `extractLenient` — input, return type, throws.
- **Render helper** (`<Template>.render.ts`): `render<Name>(payload, provider)`
  → `string` (document) / `EmailDocument` (email).
- **Output parser / prompt** where generated.

Coverage **tracks the default generator suite** — document exactly what a normal
`meta gen` produces, nothing speculative. (The api-docs generator inspects which
generators are configured/registered and documents their output.)

## Architecture

### One API model, two renderers
1. **Build an `ApiModel`** (intermediate representation) per entity/template:
   a neutral-ish data structure of `{ symbol, kind (function/type/endpoint),
   signature, params, returns, throws, oneLineUsage, example }`. Derived from the
   metadata + **the same naming/signature helpers the real generators use**
   (imported, not re-derived) so it is accurate by construction.
2. **Two renderers** consume the `ApiModel`:
   - **Human renderer** → `docs/api/<Entity>.md` per entity + `docs/api/README.md`
     consolidated index (sections, signatures, examples, cross-links — mirrors the
     neutral docs' page+index shape but Tier-1/TS-specific).
   - **Agent renderer** → one condensed `docs/api/AGENT-API.md` (or
     `.metaobjects/api-reference.md`): a compact, token-budgeted symbol list
     (signature + one-line usage per symbol, grouped by entity) sized for an
     agent's context window; omits prose/examples humans want but agents infer.

### Accuracy / drift-proofing
The `ApiModel` is built from the generators' own naming/signature functions
(e.g. `templates/queries-file.ts`, `templates/routes-file.ts`,
`render-helper-file`, `extractor-file`). A **conformance gate** asserts every
symbol the api-docs reference claims actually appears in the corresponding
generated output for a fixture model (grep the emitted `.ts` for the documented
symbol names) — so a generator rename breaks the gate, not the adopter's docs.

### Delivery / how it plugs into surfaces
- It is a generator: `meta gen` with `api-docs` in the suite emits the files;
  or `meta docs` could surface it. (Decide during planning whether it rides
  `meta gen` or `meta docs`; leaning `meta gen` since it's Tier-1 per-port and
  tracks the codegen output.)
- The **agent-form** file is a plain markdown artifact at a known path. The
  agent-context surface (sibling) can *reference* it from the installed
  `.metaobjects/` docs ("your project's generated API is in `<path>`"). We do not
  modify agent-context code; we just produce the file it can point at.

## File structure (TS pilot)
- `server/typescript/packages/codegen-ts/src/generators/api-docs-file.ts` — the
  `api-docs` generator (registered in `generator-registry.ts`).
- `.../generators/api-model.ts` — the `ApiModel` IR + the builder that reuses the
  real generators' naming/signature helpers.
- `.../templates/api-doc-human.ts` + `api-doc-agent.ts` — the two renderers.
- registry entry `api-docs` (stable name) + `--list` description + the
  generator-registry-conformance manifest gains `api-docs` for `typescript`.
- Tests: a golden fixture model → both renderings byte-pinned; the drift gate
  (documented symbols ∈ generated output); registry conformance.

## Open questions (for review)
1. **Ride `meta gen` or `meta docs`?** Leaning `meta gen` (Tier-1, tracks the
   generated suite). `meta docs` is the neutral engine; mixing Tier-1 there
   muddies ADR-0020. Confirm.
2. **Agent-form location/name** — `docs/api/AGENT-API.md` vs `.metaobjects/…`.
   The latter lands where the agent looks but overlaps agent-context's managed
   dir; the former is neutral and referenced. Lean `docs/api/` + let
   agent-context point at it.
3. **Cross-port fan-out** (after the pilot): per-port `api-docs` generators
   (each reuses its own naming logic — accurate, ADR-0020-consistent) vs a shared
   metadata+conventions engine (DRY, drift-gated). Defer until the pilot proves
   the shape.
4. **Examples** — agent-form: signature + one-line usage only (token budget) vs a
   short runnable snippet per symbol. Lean one-line for agent, fuller for human.
