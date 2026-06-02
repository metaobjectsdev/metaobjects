# Neutral metadata documentation — design

**Date:** 2026-06-02
**Status:** Design (pending review)
**Relates to:** ADR-0020 (codegen tiering), the render pillar, `template.output`
render-helper codegen (shipped all 5 ports 2026-06-01).

## Goal

Generate **neutral metadata documentation** — Markdown that describes the
metadata model (entities and `template.output` templates) and makes **no
assumption about the implementing language**. One shared engine (Tier 2 per
ADR-0020), runnable by any adopter via the standalone `meta` binary. No
`--target`.

Two concrete outcomes:

1. A **`template.output` documentation page** whose shape is distinct from the
   entity page — it documents a *render contract*, not a persistence shape.
2. The existing entity page **neutralized** — the language-specific sections
   removed so "metadata docs" actually contain only metadata.

Plus the structural fix you approved: a **single shared canonical template
source** with a per-port byte-identity gate, so doc templates can never be
duplicated/forked per language.

## Background — what exists today

- Only TypeScript ships a docs generator:
  `server/typescript/packages/codegen-ts/src/generators/docs-file.ts` →
  `templateGenerator({ ref: "docs/entity-page.md", ... })`, one Markdown page
  per entity.
- The Mustache template lives once at
  `server/typescript/packages/codegen-ts/templates/docs/entity-page.md.mustache`
  and resolves through `FrameworkTemplatesProvider` (framework default) with
  adopter override via a project `templates/` dir (ProviderChain).
- `EntityDocData` (`generators/docs-data.ts`) sections: **Storage**,
  **Identity**, **Relationships**, **Validation**, **Used by**,
  **Generated code**.
- `template.output` is **not documented anywhere**. The entity page's "Used by"
  bullets reference templates that have **no page to link to** (dangling).
- The render engine (`render()` + `verify()`), the `templateGenerator()`
  factory, and the doc common-attributes (`DOC_ATTR_*`) already exist in all
  five ports — but only TS has a docs *data-builder*.

## What is neutral vs. what leaks

Applying the ADR-0020 test (does the output depend on the implementing
language?) to the current entity page:

| Section | Neutral? | Decision |
|---|---|---|
| Storage (column name, **TypeScript type**, **Drizzle ORM DDL**) | **No** — the "TypeScript type" column and the `integer("id")` / `text(..., { enum: [...] as const })` cells are TS-codegen output, not metadata facts | **Neutralized** → keep the section (physical persistence mapping IS neutral) but render declared facts only: **Column / Type / Nullable / Key** (`@column` name, `@dbColumnType` override else logical type, nullability, PK/FK role). No TS type, no DDL, no ANSI re-derivation. |
| Identity (primary/secondary/reference keys) | **Yes** | Keep |
| Relationships (cardinality, composition) | **Yes** | Keep |
| Validation (`OrderInsertSchema` / `OrderUpdateSchema` — **Zod**) | **No** — names a TS artifact | **Neutralize** → document the constraint metadata (required, maxLength, ranges, enum membership, validators) |
| Used by (templates referencing this entity) | **Yes** | Keep + make the links resolve to template pages |
| Generated code (lists TS filenames) | **No** — language-specific SDK concern | **Drop** from neutral docs |

The neutralized Validation section is *better*, not just smaller: it surfaces
the actual declared constraints from the metadata instead of pointing at a
generated TS schema.

## Design

### 1. Shared canonical template source + byte-identity gate

Move the canonical doc templates out of the TS package into one shared,
language-agnostic location and add a conformance gate.

- **Canonical location:** a new root **`templates/`** directory. Rationale:
  `fixtures/` is specifically for **conformance corpora** (shared *test inputs*:
  render-conformance, verify-conformance, extract-conformance, …). Doc templates
  are shipped **product assets** that merely carry a byte-identity gate — not
  test inputs — so they get their own canonical home. Holds:
  - `templates/docs/entity-page.md.mustache` (moved + neutralized)
  - `templates/docs/template-page.md.mustache` (new)
- **Each consuming port** ships its framework-default copy in its own package
  resources (as today for TS), but a **byte-identity conformance test** asserts
  the shipped copy equals the canonical `templates/` source byte-for-byte. Only
  TS consumes today; the gate exists so a future consumer cannot fork the
  template.
- This mirrors how `render-conformance` pins byte-identical engine behavior —
  here it pins byte-identical *template source*.

> Note: the templates are plain language-neutral Mustache. They are **not**
> "ported" per language — there is one source of truth; each port that emits
> docs reads the same text. The byte-identity gate enforces that.

### 2. Neutral entity page (`docs/entity-page.md.mustache` + `EntityDocData`)

- **Drop** the `generated` section and field from `EntityDocData` + the
  `## Generated code` block from the template.
- **Replace** the `validation` section: instead of `insertSchema`/`updateSchema`
  Zod names, emit a neutral **Constraints** view derived from field metadata.
  **Rendering: a table** (matches the Storage section style; scannable for
  many-field entities) with columns: field | required | type |
  limits (maxLength/min/max/pattern) | enum/validators.
- **Neutralize Storage**: keep the section (the physical persistence MAPPING is
  neutral, useful metadata) but drop the language-specific **TypeScript type**
  column and the **Drizzle ORM DDL** cell. Render declared physical facts only —
  columns: **Column** (`@column` override else field name) | **Type**
  (`@dbColumnType` override uppercased, else the same neutral logical type the
  Constraints table uses — no ANSI/ORM SQL re-derivation) | **Nullable** | **Key**
  (PK / `foreign key → <Target>`). This is distinct from (not duplicative of) the
  Constraints table, whose value is validation rules; Storage's value is the
  physical field→column mapping + physical-type override + key role.
- Keep Identity / Relationships / Used by unchanged (already neutral).
- Make **Used by** bullets link to the new template page (`./<Template>.md`).
- The TS golden (`test/golden/docs-file-conformance.test.ts`) updates to the
  neutralized output — this is an intentional improvement, not a regression.

### 3. New neutral template page (`docs/template-page.md.mustache` + `TemplateDocData`)

A new `TemplateDocData` builder walks `template.output` nodes. One page per
template. **Neutral** sections (no generated-helper signatures, no language
types):

- **Header** — name, **kind** (`document` | `email`), description.
- **Output** — `@format` (text/html/xml/csv/json/markdown); for `email`, the
  three logical parts (**subject**, **html body**, **text body?**) and that it
  is multipart; escaping behavior (html escaped, text/subject raw).
- **Input** — the payload VO (link to *its* entity page) and the fields the
  template is permitted to reference (the field tree / `@requiredTags`).
- **Render contract** — `@maxChars` budget (note: exceeding it fails),
  `@requiredTags`, and the drift guarantee stated **neutrally**: "every field
  referenced by the template is validated against the payload at generation
  time; an unknown field fails generation."
- **Source** — the template ref(s) it renders (`@textRef`, or the email
  `@subjectRef`/`@htmlBodyRef`/`@textBodyRef`) — these are metadata refs, not
  language artifacts.
- **Capability** (neutral, replaces "generated helper signature") — "A render
  helper is generated for this template: it takes the payload and returns the
  rendered output — `document` → a single rendered string; `email` → subject +
  html body + optional text body." No language type names.

### 4. Positioning as the shared Tier-2 engine

- The doc model must be built from **neutral metadata** only (the loaded
  metadata model — entities, fields, identities, relationships, templates — not
  any TS-codegen-specific data). The TS metadata loader is an implementation
  detail; what it loads is the neutral metadata.
- **Finding:** there is **no** `meta docs` command today. `docsFile()` runs only
  as a generator wired into the TS codegen generator list — docs are a byproduct
  of the full codegen pipeline, not a standalone capability. To make metadata
  docs a true Tier-2 capability (runnable by a non-TS adopter against metadata
  alone, no codegen run, no Node toolchain), we wire a **`meta docs <metadata>
  --out <dir>`** command into the CLI and the standalone `meta` binary (same
  delivery as `migrate-ts`). It emits entity + template pages from neutral
  metadata only.
- **Out of scope (explicitly):** porting the docs data-builder to
  C#/Python/Java/Kotlin (ADR-0020 Tier 2 — single engine); SDK/API docs
  (Tier 1, separate future effort); `--target` flavoring (not needed for neutral
  docs).

## Testing

- **Byte-identity gate:** a test per consuming port asserting its shipped
  framework template equals `fixtures/doc-templates/...` byte-for-byte (TS now;
  the gate is reusable).
- **Entity page golden:** update `docs-file-conformance.test.ts` to the
  neutralized output (no Generated-code, neutral Constraints); add a case with
  declared constraints to prove the Constraints view.
- **Template page golden:** new conformance fixture + golden covering a
  `document` template and an `email` template (subject/html/text parts), the
  render-contract section, and the entity↔template cross-links resolving.
- **Neutrality assertion:** a test that the generated metadata docs contain no
  language-specific tokens (no "Zod", no generated `.ts`/`.cs`/`.kt` filenames,
  no language type names) — guards the ADR-0020 boundary.

## File structure (TS, the single engine)

- `fixtures/doc-templates/docs/entity-page.md.mustache` — moved + neutralized
- `fixtures/doc-templates/docs/template-page.md.mustache` — new
- `server/typescript/packages/codegen-ts/templates/docs/*.mustache` — framework
  copy, byte-identity-gated against the fixtures
- `generators/docs-data.ts` — drop `generated`; replace `validation` with
  neutral `constraints`
- `generators/docs-data-builder.ts` — build constraints from field metadata;
  drop generated-files walk
- `generators/template-doc-data.ts` — new `TemplateDocData` shape
- `generators/template-doc-builder.ts` — new builder walking `template.output`
- `generators/docs-file.ts` — emit template pages alongside entity pages;
  resolve Used-by links
- CLI: ensure `meta docs` emits both page types

## Decisions (resolved 2026-06-02)

1. **Canonical location** — root **`templates/`** (not `fixtures/`, which is for
   conformance corpora / test inputs; doc templates are shipped product assets).
2. **Constraints rendering** — **table** (Storage-section style).
3. **`meta docs` command** — **in scope this pass**: wire a standalone
   `meta docs <metadata> --out <dir>` into the CLI + binary.
4. **Overall scope** — **neutral metadata docs only**. Native per-port code
   generators untouched; docs builder NOT ported to other languages; SDK/API
   docs (Tier 1) deferred.
