# Docs Site — Design

**Status:** approved-direction, phase-decomposed · **Date:** 2026-07-04 · **Branch:** `feat/docs-site`

## Problem

`meta docs` today emits Tier-2 neutral documentation as **markdown** surfaces (`--model` entity/template
pages, `--api` surface, `--metamodel`) plus `mermaid-er` diagrams. That is ideal for the in-repo / GitHub /
agent surface (README-rendered, token-frugal `AGENT-API.md`). It is **not** a browsable, web-publishable
reference: no navigation shell, no search, no rich per-object pages, and the ER diagrams don't distinguish
object kinds or cover the full relationship model.

A rich, multi-page **HTML documentation site** generator was prototyped end-to-end in a downstream adopter and
proven at ~650 pages: a 3-region shell (package nav tree · grouped collapsible content sections · sticky
"on this page" TOC + legend), Cmd+K fuzzy search, per-object/package/prompt/output pages that surface
validators, index tuning detail, relationships, inheritance, and field provenance, and a diagram system that
encodes **domain by fill color** and **object kind by shape/glyph** (rectangle=entity, stadium=value object,
parallelogram=view), fit-to-width in bounded scrollable boxes. Output is deterministic and link-checked.

This design brings that generator into the metaobjects monorepo as a first-class, reusable capability that any
metaobjects project can adopt — a new **web-publishing** doc surface that sits alongside (does not replace)
the markdown surfaces.

## Goals / Non-goals

**Goals:** a versioned `@metaobjectsdev/docs-site` package + a `meta docs --site` surface; the rich HTML site
available to any metaobjects model; the diagrams eventually cover **every relationship the metamodel supports**
(built on the shared relationship IR, not a hand-rolled subset); hybrid ownership per ADR-0034 (engine as a
dependency; thin config + templates + assets scaffolded into the consumer and owned there); deterministic,
link-checked output; a generic `acme` fixture + tests.

**Non-goals:** replacing the markdown `--model`/`--api`/`--metamodel` surfaces or `api-docs` (they serve the
GitHub/agent surface and stay); a runtime/server component (this is a static generator); non-mustache theming
engines. No consumer-specific content ships in the package (public repo).

## Architecture — where it lands

- **Package:** `server/typescript/packages/docs-site` → `@metaobjectsdev/docs-site`, sibling to
  `codegen-ts-react` / `-angular` / `-tanstack`. Depends on workspace packages `@metaobjectsdev/metadata` +
  `@metaobjectsdev/render` and on `yaml`.
- **Public engine API:** `generateSite(opts: SiteOptions): Promise<SiteResult>` — `SiteOptions = { sourceDirs:
  string[]; outDir: string; title: string; stamp: string; commit: string; core?: { n?: number };
  templatesDir?: string }`. The `templatesDir` override is the scaffold-and-own seam (a consumer copy wins over
  the bundled template of the same name).
- **CLI surface:** a new `--site` surface on `meta docs` (sibling to `--model`/`--api`/`--metamodel`). When
  requested, the command loads the model, resolves the source dirs, and calls `generateSite`. Markdown surfaces
  and `mermaid-er` are untouched — `--site` is additive (a consumer can emit markdown for GitHub AND a site for
  the web).
- **Doctrine fit (ADR-0022):** the site is a **Tier-2 neutral** documentation output owned by `meta docs`, not
  a native `meta gen` generator (it documents the model, not the generated code's API surface).

## Phase decomposition

This is delivered in three phases on one branch (`feat/docs-site`), each an independent, testable unit.

### Phase 1 — Port as `meta docs --site` (this spec's primary deliverable)

Bring the proven generator in **as-is** (keeping its current graph), wired as the `--site` surface.

- Create `server/typescript/packages/docs-site` with the ported `src/` (loader, link-graph, page builders,
  mermaid emitters, site orchestrator, link-check), `templates/`, `assets/`, the **generic `acme` fixture**,
  and the **byte-identical golden test + unit tests** (they are already model-agnostic — verbatim port).
- Wire the `--site` surface into `meta docs` (`server/typescript/packages/cli/src/commands/docs.ts`): parse
  `--site`, thread `outDir`/`title`, call `generateSite`.
- **Keep the current LinkGraph/builders/mermaid** — the shared-IR consolidation is Phase 2. Phase 1 ships the
  proven output, now living in metaobjects and runnable by any project.
- **Success:** `@metaobjectsdev/docs-site` builds in the monorepo; its ported tests pass (golden byte-identical
  + deterministic on double-generate, link-check green); `meta docs --site --out <dir>` on the `acme` fixture
  emits a working site.

Detailed steps live in the Phase-1 implementation plan.

### Phase 2 — Consolidate the graph onto the shared relationship IR

Keep the **presentation layer** (templates, assets, mermaid theming, the kind-shape/domain-color diagram
doctrine, page structure) and **replace the graph/derivation layer** so the diagrams cover every relationship
the metamodel supports.

- metaobjects' relationship engine (`derive-m2m-fields`, and the relations IR that `buildApiModel` exposes)
  already models what the ported LinkGraph does not: M:N through junction entities (`@through`), belongs-to vs
  has-many directions (1:N inverse), self-joins (directed via `@sourceRefField`, symmetric via `@symmetric`),
  `@cardinality`/`@onDelete`, and attributes resolved through `extends` (ADR-0039).
- Source the site's edges from that shared derivation instead of the hand-rolled `LinkGraph` edge set; keep the
  raw-metadata reads the neutral pages need (fields, indexes, validators, identities) that the API-surface IR
  may not expose — extend the shared IR where a neutral-doc datum is missing rather than re-deriving
  relationships.
- **Success:** the site's neighborhood + core diagrams render M:N-through-junction, direction, and self-join
  relationships; a fixture exercising each; golden regenerated + deterministic; presentation output unchanged
  except for the newly-covered edges. New metamodel relationship types flow into the docs automatically.

### Phase 3 — Scaffold-and-own wiring + first consumers

- Per ADR-0034, `meta init` (or `meta docs --scaffold-site`) copies the thin config + the mustache templates +
  CSS/JS assets into the consumer's `codegen/` (or `docs/`) so the app owns its theme; the engine stays a
  versioned dependency. The bundled templates are the fallback; a consumer copy of the same name wins via
  `templatesDir`.
- Convert the prototyping adopter from its private copy of the generator to consuming `@metaobjectsdev/docs-site`
  (dogfood), and document the adoption in the agent-context docs surface.
- **Success:** a fresh `meta init`-scaffolded project can run `meta docs --site` and re-theme by editing its
  owned templates; the reference adopter builds its site from the package with no local generator copy.

## Testing & determinism

- The ported unit + golden tests run in the monorepo's bun test suite. The golden fixture site is byte-identical
  across regenerations; a link checker fails generation on any dangling link.
- Escaping invariant (carried from the prototype): `@metaobjectsdev/render`'s `render()` does not HTML-escape,
  so every authored/free-text value reaching a single-stache slot or HTML attribute passes through the single
  canonical `esc` at the builder boundary; triple-stache slots receive only builder-produced escaped HTML.
- Deterministic output: all emitted lists/edges/nodes/classDefs sort; no Map/Set insertion-order leakage.

## Constraints

- **Public repo:** metaobjects is public. No consumer/client names, no absolute local paths, no private content
  — the package ships only the generic `acme` fixture and generic docs. Verify the diff before every commit.
- **Node IDs / labels:** diagram node IDs are sanitized to valid mermaid identifiers; flowchart edge labels
  strip parser-breaking chars; large attribute-ERDs are capped (kind/detail) since they are fragile in mermaid.
- **Additive:** markdown `--model`/`--api`/`--metamodel` + `api-docs` + `mermaid-er` are unchanged.

## Risks

- The shared relationship IR (`buildApiModel`) is API-surface-oriented; Phase 2 may need to extend it to expose
  neutral-doc data (indexes/validators/per-field) — scoped as "extend, don't re-derive."
- Mermaid `securityLevel: "loose"` is enabled for HTML labels; labels are identifier-derived and sanitized, but
  any future free-text label must be escaped first (tracked follow-up).
- Diagram node IDs are keyed by simple name (rare same-name cross-package collision) — key by fqn if it surfaces.

## Rollout

All three phases land on `feat/docs-site` (metaobjects worktree). Implemented via superpowers writing-plans →
subagent-driven-development, one plan per phase, preserving the golden/link-check gates. A PR opens when the
branch is ready; a subsequent session may complete later phases.
