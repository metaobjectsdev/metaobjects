# Prompt construction as the fourth pillar — cross-surface messaging rollout

**Date:** 2026-05-22
**Status:** Design (ready for implementation plan)
**Scope:** Propagate one positioning decision — *prompt construction (FR-004) is MetaObjects' fourth pillar, landing in 7.0.0* — across four surfaces: in-repo strategy/related docs, the public landing site, the commercial site, and a new essay on the author's personal site. This is a messaging/documentation rollout, not a code change; no metamodel or runtime behavior is implemented here.

## Background

FR-003 (Java OMDB persistence + schema migration + projections, `7.0.0`) and FR-004 (cross-language prompt construction) are designed and committed as the plan of record. FR-004 reframes what MetaObjects *is*: the same three disciplines that govern entity code — codegen, runtime, drift — now extend to the artifacts that drive the AI itself. The metamodel already supplies the load-bearing pieces (projections as the typed prompt payload; the polyglot loader + canonical serializer + conformance corpus as the byte-identical-render machinery; Mustache already in the toolchain).

The decision this rollout encodes: **prompt construction is a co-equal fourth pillar** alongside codegen / runtime / drift — presented honestly as *committed and landing in 7.0.0*, not as shipping today.

## Through-line message

A single claim orbits every surface: **"the prompt is code."** Your generated *code* was drifting (the existing essay series' thesis); your *prompts* are drifting too — the same rule text restated many ways, payloads bloating unseen, a renamed field silently breaking a prompt. The fourth pillar closes the loop: metadata governs not just what the AI *produces*, but what the AI is *told*.

The embedded "why it's real" argument: the prompt payload **is** a projection (FR-004 §1 reuses FR-003 §5). The abstraction built for DB views turns out to be exactly what a prompt needs — evidence the metamodel is a genuine architectural spine, not incidental.

**Honesty constraint (load-bearing):** the fourth pillar is co-equal *in the architecture/vision* but **not yet shipped**. Every surface marks it "landing in 7.0.0" / "committed" — never present-tense "ships today." This reconciles the co-equal framing with the plan-of-record framing.

**Pillar name:** *Prompt construction* (concrete — it is what is being built). MCP / metadata-graph exposure is noted as where that pillar heads next, not bundled into the name.

## Surfaces

This rollout spans four separate git repositories. Public surfaces stay generic per public-repo hygiene; the personal and commercial sites name real projects per their own established norms.

### Surface 1 — in-repo strategy + related docs (this repo, PUBLIC)

- **`spec/roadmap.md`** — replace the vague H6 placeholder with a concrete **"H6 — Prompt construction (the fourth pillar)"** entry citing the FR-004 design, version-targeted `7.0.0`. Also surface FR-003 in the Java line (the `7.0.0` consolidation, OMDB port, projections, migration) which the current roadmap does not yet mention.
- **`spec/README.md`** — add the fourth pillar to the "consumed by" framing and a "Planned for 7.0.0" pointer to the FR-003/004 design docs.
- **`CLAUDE.md`** — update the "Three pillars" section to four (fourth marked `7.0.0`); note in Status that the FR-003/004 specs exist.
- **Restraint:** the normative specs (`metamodel.md`, `wire-format.md`, `conformance-tests.md`) get only a brief "planned: `prompt.*`" forward-pointer — **no premature normative vocabulary**, because FR-004 itself defers that until FR-003 lands. The FR-003/004 design docs are left as-is.

### Surface 2 — public landing (`metaobjects.dev`, PUBLIC, separate repo)

- **`www/index.html`** — "Three pillars" section → four; add a **Prompt construction (7.0.0)** card; keep the existing "metadata layer for AI-first development" tagline.
- **`www/llms.txt`** — "ships three capabilities" → four; add the prompt-construction bullet marked design-stage/`7.0.0`; refresh the roadmap line; link the new essay once published.
- **`www/llms-full.txt`** — parallel update (full corpus dump; structure inspected during implementation).

### Surface 3 — commercial site (`<commercial-site>`, PRIVATE, separate repo)

- Mirror the four-pillar messaging on the homepage capabilities section, with an enterprise value framing for prompt construction (governed prompts, build-time prompt drift, visible payload/token bloat). Exact Eleventy node edits (`index.njk` / `_data`) determined against the site's structure during implementation.

### Surface 4 — essay (`<personal-site>`, PRIVATE repo; published publicly)

Third in the existing writing series (after the AI-drift origin essay and the "AI stack's missing architecture" positioning essay). Eleventy markdown under `src/writing/`, dated `2026-05-22`, frontmatter per the site's convention (layout / title / date / tags / excerpt). The site's date-stripping slug/permalink mechanism is matched (verified against its Eleventy config during implementation).

- **Working title:** *"The prompt is code — and yours is drifting too."*
- **Arc** (Roman-numeral sections, author's first-person voice; opens referencing the prior two essays):
  1. The series so far → now turn the drift lens on the prompts themselves.
  2. The hidden drift in prompts — imperative `StringBuilder` prompt assembly, repositories read *inside* the builder (untestable without a live DB), the same rules triplicated across calls, invisible payload bloat, a renamed field silently breaking a prompt.
  3. A prompt is just **(data + text + render)** — and metadata already governs each part.
  4. **The fourth pillar — Prompt construction:** typed payload = a projection (the spine proving itself); externalized, provider-resolved text; byte-identical cross-language render (Mustache + conformance); build-time prompt↔payload drift (`verify`) — each mapped back to codegen / runtime / drift.
  5. Why it had to be metadata: cross-language byte-identical, no lock-in, the provider seam (static → A/B → evolutionary) without touching metadata or the engine.
  6. What it means for your stack (enterprise-scale framing).
  7. What's next — `7.0.0` (FR-003 substrate first, then FR-004).
- **Grounding:** the author's own game-NPC prompt consumer (already named in the prior essays) carries the concrete dogfooding story; enterprise framing stays generic (no employer named, no disclosure aside). The real product name appears only in the personal-site article — kept generic in this committed design doc for public-repo hygiene.

## Cross-cutting

- **Public-repo hygiene:** public surfaces (this repo + `metaobjects.dev`) stay generic — no consumer-project names, no absolute home paths. The personal and commercial sites name projects per their norms. This design doc is itself genericized so it passes the public-repo commit guard.
- **Sequencing:** docs → `metaobjects.dev` → `<commercial-site>` → essay last (so the essay rests on settled messaging).
- **Commits:** four repositories, separate commits each; committed only on explicit request, never auto-pushed; a non-default branch is used where the host repo is on its default branch.

## Out of scope

- Any FR-004 / FR-003 code implementation (metatype, render engine, providers, migration). This rollout is messaging only.
- New normative `prompt.*` vocabulary in the canonical specs (deferred until FR-003 lands, per FR-004).
- Revising the FR-003 / FR-004 design docs themselves.

## Open questions (resolve during implementation)

1. The personal site's exact slug/permalink derivation (date-stripping) — confirm against its Eleventy config so the essay URL matches the series.
2. `llms-full.txt` internal structure — confirm where the pillar/roadmap content lives so the parallel edit is precise.
3. Commercial-site structure — which Eleventy node(s) carry the capability/pillar messaging.

## Testing / verification

- Public surfaces build clean (each site's `eleventy` / static build) and contain no consumer-project names or home paths (public-repo guard passes on commit).
- Internal consistency: "four pillars (fourth landing in 7.0.0)" reads identically across `metaobjects.dev`, `<commercial-site>`, this repo's docs, and the essay's framing.
- Essay renders in the site's dev server with correct frontmatter, tags, and series cross-links.

## Cross-references

- `docs/superpowers/specs/2026-05-22-fr-004-cross-language-prompt-construction-design.md`
- `docs/superpowers/specs/2026-05-22-fr-003-omdb-persistence-schema-migration-projections-design.md`
- `spec/roadmap.md`, `spec/README.md`, `CLAUDE.md`
