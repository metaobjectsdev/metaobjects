# Docs Site — Phase 3 Design: Scaffold-and-Own + Rollout Program

**Status:** approved-direction · **Date:** 2026-07-04 · **Branch:** `feat/docs-site`
**Predecessors:** [Phase 1 — port](2026-07-04-docs-site-design.md) · [Phase 2 — shared IR](2026-07-04-docs-site-phase2-design.md) (both shipped on the branch)

## Problem

The `@metaobjectsdev/docs-site` engine ships bundled templates + assets. A consumer
can already override *templates* via `generateSite`'s `templatesDir`, but there is
no way to (a) get those files into the consumer's repo to edit, and (b) override the
CSS/JS **assets** at all (`generateSite` reads them from the bundled `../assets`,
hardcoded). So a project cannot yet *own its docs-site theme* — the ADR-0034
"scaffold-and-own" promise the codegen generators already fulfill
(`meta init` → `codegen/generators/`).

## Goal / Non-goals

**Goal (this spec — sub-project A):** a `meta docs --scaffold-site` command that copies
the engine's templates + assets into the consumer's repo (write-only-if-absent, ADR-0034
semantics); an `assetsDir` override so the copied CSS/JS are actually used; auto-detection
so `meta docs --site` picks up the owned copies with no extra flags; docs; and validation
through the **real `meta` CLI** against a substantial model.

**Non-goals (this spec):** the downstream adopter conversions and the prerelease — those
are sequenced follow-on sub-projects (see Program Rollout). No template redesign; no change
to the markdown surfaces or Phase-1/2 behavior.

## Design (sub-project A)

### A1 — Make assets ownable (`generateSite`)
Add `assetsDir?: string` to `SiteOptions`, mirroring `templatesDir`. A `loadAsset(name,
overrideDir?)` helper checks `join(overrideDir, name)` first, else the bundled `../assets`.
The two `writeOut("assets/…", readFileSync(bundled))` calls in `site.ts` route through it.

### A2 — Export the scaffold source (`docs-site/src/index.ts`)
Export `SITE_TEMPLATE_NAMES: readonly string[]` (the 9 `*.mustache` basenames),
`SITE_ASSET_NAMES: readonly string[]` (`site.css`, `site.js`), and
`readSiteFile(kind: "template" | "asset", name: string): string` reading from the package's
bundled `templates`/`assets` dirs (`resolve(import.meta.dir, "../templates" | "../assets")`).
This mirrors codegen-ts's `readReferenceTemplate` / `REFERENCE_GENERATOR_NAMES`, so the CLI
copies from a stable package API — never by reaching into `node_modules` paths.

### A3 — `meta docs --scaffold-site` (`cli/src/commands/docs.ts`)
Parse `--scaffold-site`. When set, copy each template → `<root>/codegen/docs-site/templates/<name>`
and each asset → `<root>/codegen/docs-site/assets/<name>`, **only if the target is absent**
(never clobber a hand-edited file); report created vs preserved counts, mirroring
`meta init`'s `result.created`/`preserved`. It scaffolds and returns — it does not also
generate. The location `codegen/docs-site/` parallels the existing `codegen/generators/`.

### A4 — Auto-detect owned copies (`meta docs --site`)
In the site-emit path: if `<root>/codegen/docs-site/templates` exists → pass it as
`templatesDir`; if `<root>/codegen/docs-site/assets` exists → pass as `assetsDir`; else the
bundled defaults. So after `--scaffold-site`, theming "just works" with no extra flag. This
replaces the Phase-1 `templatesDir: projectRoot` threading, which was a no-op (a project root
is not a flat mustache dir, so `loadTemplate` never matched and always fell back to bundled).

### A5 — Docs
A short "Own your docs-site theme" section in the docs-site `README.md` + a `--scaffold-site`
help line in `cli/src/index.ts`, documenting the flow and the `codegen/docs-site/` location.

## Validation (sub-project A — the "make sure it works" gate)

1. **Unit tests:** `assetsDir` override (site.ts); the scaffold copy + write-only-if-absent
   + report shape (docs-command test); auto-detect picks up the owned dir.
2. **Real-CLI scaffold-and-own proof:** drive `bun run bin/meta.ts` end-to-end — `--scaffold-site`
   into a scratch project → edit a scaffolded **template** AND an **asset** → `meta docs --site`
   → assert the *edited* content appears in the output (the owned copy wins) and re-running is
   deterministic + link-checked.
3. **Scale/parity smoke against a real model:** run `meta docs --site` against a substantial
   in-repo model (a rich conformance model, e.g. `fixtures/conformance/flattened-kitchen-sink`)
   AND — local only, nothing committed to this public repo — against the private reference
   adopter's real metadata, to prove the engine handles a large real model (surfacing gaps such
   as a multi-module metadata layout vs the CLI's single-`<root>/metaobjects/` assumption).

## Program Rollout (sequenced sub-projects — dependency-ordered)

This spec's sub-project A is the foundation. The remaining sub-projects each get their own
brief plan when reached; they are listed here so the whole rollout is visible.

- **B — Cross-port `deriveM2MFields` FQN sync (in-repo).** The Phase-2 fix (junction `@through`
  resolved by FQN, not just bare name) landed only in the TS port. The **Python** port has a
  direct analog (`server/python/src/metaobjects/meta/core/relationship/derive_m2m_fields.py`) that
  very likely shares the bare-name bug; **Java/Kotlin** have M2M resolvers of a different shape
  (`server/java/**/M2m*`, `M2MResolver`) to investigate. Per the "keep all ports in sync" doctrine,
  fix the analogous bug in each in-repo port (+ a regression test each). Blocked by: nothing
  (independent of A) — but grouped into this branch's rollout.
- **C — Validation** (folded into A's gates above).
- **D — Prerelease.** Cut a metaobjects prerelease from the merged branch so adopters can
  `npm install` the new `meta docs --site` + the M:N fix (RC-first, per `docs/RELEASING.md`).
  Blocked by: A (+ B) merged.
- **E — first adopter adoption.** Bump the (private) reference adopter's `@metaobjectsdev/*` to
  the prerelease, replace its private in-repo generator copy with `meta docs --site` +
  `--scaffold-site`ed templates, regenerate its site, parity-check against the known-good output.
  Adopter-repo work. Blocked by: D.
- **F — second adopter adoption.** Add/update metaobjects in a second downstream project first,
  then adopt `meta docs --site`. Blocked by: D (+ that project's metaobjects onboarding).

## Testing & gates

Determinism (byte-identical golden across two regenerations), link-check (throws on dangling),
and typecheck stay green. New: the `assetsDir` override + scaffold copy carry unit tests; the
real-CLI scaffold-and-own proof is the integration gate.

## Constraints

- **Public repo:** no private/downstream project names, no absolute local paths in anything
  committed. The scale/parity smoke against the private adopter is **local only** — its output
  and paths never enter the public repo.
- **ADR-0034 semantics:** scaffold writes only if absent (never clobbers a hand-edited file);
  the engine stays a versioned dependency; the owned copy of the same basename wins.
- **No new package dependency** beyond what Phases 1-2 already added.

## Success criteria (sub-project A)

- `meta docs --scaffold-site` writes the 9 templates + 2 assets to `codegen/docs-site/`,
  preserves any that already exist, and reports created/preserved.
- After scaffolding, editing a template or asset and running `meta docs --site` yields the
  edited content in the output (owned copy wins), deterministic + link-checked.
- `meta docs --site` runs clean against a substantial in-repo model (full site, no dangling links).
- Unit + integration tests green; typecheck clean; no private-name/path leak.

## Risks

- **Multi-module metadata layout.** `meta docs --site` computes `sourceDirs =
  [<root>/metaobjects]`; a real adopter's model may span several dirs. The parity smoke will
  surface this; if real, the fix (accept multiple source dirs) is a scoped addition, flagged
  during validation rather than pre-built (YAGNI until observed).
- **Asset override scope.** Only `site.css`/`site.js` are owned; `search-index.json` is
  generated, not scaffolded (correct — it is derived, not themed).
