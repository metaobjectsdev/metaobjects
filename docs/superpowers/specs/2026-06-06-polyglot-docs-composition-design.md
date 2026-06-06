# Polyglot docs composition (SP-1) — design

**Date:** 2026-06-06
**Status:** Design (pending review)
**Relates to:** ADR-0025 (unified docs door — this implements its multi-language direction). This is **SP-1** of a two-part program; **SP-2** (the Java api surface + a real TS+Java end-to-end conformance) follows in its own spec.

## Goal

Let a **polyglot solution** (e.g. TypeScript + Java over the same meta models) produce ONE coherent doc tree: the **model docs generated once** (shared, language-independent) + **one api surface per language** (idiomatic SDK reference), all **cross-linked**. SP-1 builds the TS-side composition + the contract; it is TS-only today but lays the exact shape the Java api surface (SP-2) plugs into. No model-doc duplication across languages.

## Research basis (why this shape)

Tools that do precisely "one neutral model → many idiomatic language outputs" converge on **an explicit list of per-language targets, each with its own output dir, in one build config**:
- **buf** `buf.gen.yaml` lists `plugins[]`, each with its own `out:` per language; "managed mode" keeps the schema neutral while per-consumer options live in config.
- **Smithy** `smithy-build.json` declares multiple projections + plugins (`<language>-<type>-codegen`) from one model.
- **Backstage TechDocs** aggregates many components via a manifest (`catalog-info.yaml`) — but that is a *portal/federation layer ABOVE* per-project generation.

**Decision:** an **explicit per-language `apiSurfaces[]` list in the `docs:` config** (the buf/Smithy pattern, and consistent with our own `generators[]`/`targets{}`). The Backstage-style **manifest is deferred** (YAGNI); we keep the internal resolver consuming a *source-agnostic resolved surface list* so a multi-repo manifest can feed the same contract later without reworking the generators.

## Scope

- **Build now (TS):** the `apiSurfaces[]` config, the model-page→**set-of-api-surfaces** links, per-language api subdirs, relative-or-`baseUrl` cross-link bases, the emit/skip behavior of `meta docs`, and a conformance gate proving a one-tree, **N-api-surface** layout (using a simulated second surface). 
- **Contract (designed, not built here):** the surface declaration + cross-link path contract that SP-2's Java api surface will emit into.
- **Out of scope:** the Java api surface itself (SP-2); the federation manifest path (deferred); the non-TS model-engine reach (still deferred per ADR-0025 — *not needed* for a polyglot solution, since the model docs come from the TS toolchain once).
- **Fixture hygiene (in scope):** SP-1 fixtures live **TS-package-local**, NOT in the shared `fixtures/conformance/` corpus; and SP-1 **relocates the existing `template-source-conformance` + `template-source-conformance-package` fixtures out of the shared corpus** (see "Fixture placement" below).

## Design

### 1. Config: additive `apiSurfaces[]` (back-compat)

Extend `DocsConfig` (`packages/codegen-ts/src/metaobjects-config.ts`):
```ts
export interface ApiSurface {
  lang: string;        // "ts" | "java" | … (free string; label derived)
  subDir: string;      // e.g. "api/ts"; per-language output sub-root under outDir
  baseUrl?: string;    // when set, cross-links to THIS surface are absolute (federated)
}
export interface DocsConfig {
  outDir?: string; layout?: OutputLayout; baseUrl?: string;
  surfaces?: DocsSurface[];          // existing — unchanged
  apiSurfaces?: ApiSurface[];        // NEW — polyglot api surface list
}
```
- **Absent `apiSurfaces` → today's behavior, byte-identical** (single model + single `api/` surface via the existing path).
- **Present `apiSurfaces` → it supersedes the single default:** the model page links to every entry; each language's `docs` command emits the surface whose `lang` it owns into that entry's `subDir`.
- `resolveDocsConfig` resolves `apiSurfaces` from config + (future) any manifest into one `ResolvedDocsConfig.apiSurfaces` list — the source-agnostic seam.

### 2. Model page links to the SET of api surfaces

The model entity page's single `apiPageHref` generalizes to `apiRefs: { label: string; href: string }[]`:
- rendered as `**API reference:** [TypeScript](api/ts/Order.md) · [Java](api/java/Order.md)`
- `label` from a small `lang → label` map (`ts`→`TypeScript`, `java`→`Java`, `kotlin`→`Kotlin`, `csharp`→`C#`, `python`→`Python`; unknown → the `lang` verbatim, capitalized).
- When `apiSurfaces` is absent, the existing single `apiPageHref` path is used unchanged (one-entry case need not route through `apiRefs` — keep the byte-identical default).

### 3. Cross-link base: relative (one tree) or `baseUrl` (federated)

A helper computes each cross-link from the emitting page to a target surface page:
- if the **target surface has no `baseUrl`** → relative path via the shared `surfaceCrossHref(fromOutputPath, `${subDir}/${page}`)` (Option A, one tree).
- if the **target surface has a `baseUrl`** → `${baseUrl}/${page}` (Option B, federated/multi-repo).
- the api→model link mirrors this using the model surface's own base (relative by default, or `docs.baseUrl` if the model docs are published separately).

This makes A and B the same code path, differing only by whether a `baseUrl` is set — exactly the "build A, get B by config" decision.

### 4. Who emits what (and the honest note)

`meta docs` (TS):
- emits the **model** surface once (when `model` ∈ surfaces),
- emits **only the api surface whose `lang` this port generates** (`ts`) into its `subDir`,
- renders model→links for **all** declared `apiSurfaces` (so the model page is solution-complete),
- if a declared surface (e.g. `java`) is NOT emitted by this command, prints a one-line note: `meta docs: declared api surface 'java' (api/java) is produced by that port's docs command — run it to populate those pages.`

The other languages' api pages are produced by their own port commands into the same tree (SP-2). In a federated setup they're produced in their own repos and linked by `baseUrl`.

### 5. Conformance gate (TS-local fixtures)

Because one command cannot emit another language's pages, the gate emits **all declared surfaces together** to prove integrity:
- a fixture declares ≥2 `apiSurfaces` (e.g. `ts` + a **simulated second** surface standing in for `java` — produced by running the api engine again under a second `subDir`/label);
- emit model + both api surfaces; assert every model→api link (one per surface) and every api→model link resolves to a real emitted page, in **flat AND package** layouts (extends the existing `docs-cross-link-conformance` pattern);
- include a `baseUrl` case asserting a surface with `baseUrl` produces absolute links (and is therefore NOT expected in the local tree);
- a teeth unit proving the checker flags a missing target.

### 6. Byte-stability

No `apiSurfaces` declared → zero output change (the single-surface path is untouched). Multi-surface behavior activates only on opt-in. Existing goldens unchanged except where a fixture opts into `apiSurfaces`.

## Fixture placement (fixes a cross-port landmine)

The shared `fixtures/conformance/` corpus is globbed by **cross-port** harnesses (C# conformance tests, the metadata-conformance bin that writes `expected.json` per fixture, etc.) that expect each case to carry cross-port expectations. The docs gates' fixtures (`template-source-conformance`, `template-source-conformance-package`) are **TS-implementation-test inputs** (input-only, no cross-port expectations) and currently sit in that shared corpus — tripping those harnesses ("no expectation files"). SP-1:
- places its OWN fixtures **TS-package-local** (e.g. `packages/codegen-ts/test/fixtures/docs/…`), not in the shared corpus; and
- **relocates `template-source-conformance` + `template-source-conformance-package`** out of `fixtures/conformance/` into the same TS-local home, updating the `CORPUS`/`FIXTURE` constants in the TS gates that reference them.

This removes the existing red and prevents SP-1 from adding more shared-corpus landmines. (Verify against the actually-failing port harness during implementation; the relocation must leave all TS docs gates green and stop the cross-port harnesses from globbing these input-only dirs.)

## ADR

A new ADR (next free number, ~ADR-0026) records the **polyglot docs composition contract**: model-once + per-language `apiSurfaces[]` (explicit-list, buf/Smithy-aligned), cross-link base relative-or-`baseUrl`, the deferred manifest/federation path, and the per-port-command/shared-model-engine principle inherited from ADR-0025. Add a pointer line from ADR-0025.

## File structure (TS)

- `packages/codegen-ts/src/metaobjects-config.ts` — `ApiSurface` type, `apiSurfaces` on `DocsConfig`/`ResolvedDocsConfig`, resolution in `resolveDocsConfig`.
- `packages/codegen-ts/src/docs-paths.ts` — a cross-link-base helper (relative-or-baseUrl) over `surfaceCrossHref`.
- `packages/codegen-ts/src/generators/docs-file.ts` + the entity doc-data builder + `templates/docs/entity-page.md.mustache` — `apiRefs[]` (generalize `apiPageHref`), the multi-link section (synced + byte-gated).
- `packages/cli/src/commands/docs.ts` — resolve `apiSurfaces`; emit the owned api surface(s); render all declared links; the skip note.
- `packages/codegen-ts/test/fixtures/docs/…` — relocated + new TS-local fixtures.
- `packages/codegen-ts/test/golden/docs-cross-link-conformance.test.ts` (+ a new multi-surface gate) — N-surface integrity, flat+package+baseUrl+teeth; updated `CORPUS` paths.
- `spec/decisions/ADR-0026-*.md` — the contract.

## Testing / gates

- `resolveDocsConfig` resolves `apiSurfaces` (config → resolved list); absent → single-surface default.
- multi-surface cross-link integrity (flat + package), baseUrl federation case, teeth.
- byte-stability: no-`apiSurfaces` output unchanged (existing goldens green, no churn).
- all TS docs gates green after fixture relocation; the shared-corpus cross-port harnesses no longer glob the docs input-only fixtures.

## YAGNI / non-goals

- No Java (or other) api surface emit — that is SP-2.
- No federation manifest path — deferred; only the source-agnostic seam.
- No non-TS model-engine reach — not needed for polyglot (model comes from TS once).
- No new model/api page CONTENT beyond the multi-link section.
