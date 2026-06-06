# Polyglot docs composition (SP-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Generalize the unified docs door so the model page links to a LIST of per-language api surfaces (`apiSurfaces[]`), each under its own subdir, with relative-or-`baseUrl` cross-links — TS-only today, but the exact contract the Java api surface (SP-2) plugs into.

**Architecture:** Replace the single model→api link (`apiPageHref`) with a list (`apiRefs[]`) driven by a canonical `apiSurfaces[]` config (default one TS surface). No back-compat (door is unreleased) — one rendering path, goldens update once. Also relocate the two TS-only docs fixtures out of the shared cross-port `fixtures/conformance/` corpus.

**Tech Stack:** TypeScript, bun test, codegen-ts + cli packages, Mustache doc templates.

Reference (read once): spec `docs/superpowers/specs/2026-06-06-polyglot-docs-composition-design.md`. Baseline code: `metaobjects-config.ts` (DocsConfig/resolveDocsConfig L102–135), `cli/src/commands/docs.ts` (flags L37–139, resolve L195–208, emit L273–323), `generators/docs-file.ts` (DocsFileOpts L48–58, apiPageHref L116–119, index L162–165/196–248), `generators/docs-data-builder.ts` (BuildDocDataOpts L62–73, apiPageHref set L477–479), `generators/docs-data.ts` (apiPageHref L181–185), `generators/api-docs-file.ts` (opts L56–66, modelPageHref L119–121), `docs-paths.ts` (surfaceCrossHref L84–88), templates `templates/docs/entity-page.md.mustache` L8–11 + package copy + `scripts/sync-doc-templates.sh`.

All commands from `server/typescript`; `bun install` first if `node_modules` missing.

---

## Task 1: `ApiSurface` type + `apiSurfaces` config + label map

**Files:** `packages/codegen-ts/src/metaobjects-config.ts`, `packages/codegen-ts/src/index.ts`, new `packages/codegen-ts/src/generators/api-label.ts`; tests `packages/codegen-ts/test/docs-config.test.ts` (extend), new `packages/codegen-ts/test/api-label.test.ts`.

- [ ] **Step 1: Failing test — apiSurfaces resolution.** Append to `test/docs-config.test.ts`:
```ts
test("apiSurfaces defaults to a single ts surface", () => {
  const r = resolveDocsConfig(undefined, {}, "flat");
  expect(r.apiSurfaces).toEqual([{ lang: "ts", subDir: "api" }]);
});
test("apiSurfaces from the docs block is preserved", () => {
  const block = { apiSurfaces: [{ lang: "ts", subDir: "api/ts" }, { lang: "java", subDir: "api/java", baseUrl: "https://d/j" }] };
  expect(resolveDocsConfig(block, {}, "flat").apiSurfaces).toEqual(block.apiSurfaces);
});
```
- [ ] **Step 2: Failing test — label map.** Create `test/api-label.test.ts`:
```ts
import { test, expect } from "bun:test";
import { apiLabel } from "../src/generators/api-label.js";
test("known langs", () => {
  expect(apiLabel("ts")).toBe("TypeScript");
  expect(apiLabel("java")).toBe("Java");
  expect(apiLabel("csharp")).toBe("C#");
});
test("unknown lang is capitalized verbatim", () => { expect(apiLabel("rust")).toBe("Rust"); });
```
- [ ] **Step 3: Run → FAIL.** `bun test packages/codegen-ts/test/docs-config.test.ts packages/codegen-ts/test/api-label.test.ts`.
- [ ] **Step 4: Implement label map.** Create `src/generators/api-label.ts`:
```ts
const LABELS: Record<string, string> = {
  ts: "TypeScript", java: "Java", kotlin: "Kotlin", csharp: "C#", python: "Python",
};
/** Human label for an api-surface language key. Unknown → capitalized verbatim. */
export function apiLabel(lang: string): string {
  return LABELS[lang] ?? (lang.length ? lang[0]!.toUpperCase() + lang.slice(1) : lang);
}
```
- [ ] **Step 5: Implement config.** In `metaobjects-config.ts`, after `DocsSurface` (L102) add:
```ts
export interface ApiSurface {
  lang: string;
  subDir: string;
  baseUrl?: string;
}
```
Add `apiSurfaces?: ApiSurface[];` to `DocsConfig` (after `surfaces?`) and `apiSurfaces: ApiSurface[];` to `ResolvedDocsConfig`. In `resolveDocsConfig`, add to the returned object:
```ts
apiSurfaces: cli.apiSurfaces ?? block?.apiSurfaces ?? [{ lang: "ts", subDir: "api" }],
```
(Add `apiSurfaces?: ApiSurface[]` to the `cli` param's type — it's `Partial<ResolvedDocsConfig>`, so it's already allowed.)
- [ ] **Step 6: Export.** In `src/index.ts` L20, add `ApiSurface` to the docs-config type re-export; export `apiLabel` from `./generators/api-label.js` (add a line near the other generator exports).
- [ ] **Step 7: Run → PASS.** `bun test packages/codegen-ts/test/docs-config.test.ts packages/codegen-ts/test/api-label.test.ts`, then `bun test packages/codegen-ts` (0 fail).
- [ ] **Step 8: Commit.** `git add -A packages/codegen-ts/src packages/codegen-ts/test && git commit -m "feat(codegen-ts): ApiSurface + apiSurfaces config + apiLabel map" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

## Task 2: Relocate TS-only docs fixtures out of the shared corpus

**Files:** move `fixtures/conformance/template-source-conformance/` + `…-package/` → `packages/codegen-ts/test/fixtures/docs-conformance/`; update `CORPUS` in 3 test files: `test/golden/template-source-conformance.test.ts` (L57), `test/golden/docs-cross-link-conformance.test.ts` (L29), `test/api-docs-subdir.test.ts` (L26).

- [ ] **Step 1: Move the fixtures (preserve history).**
```bash
mkdir -p packages/codegen-ts/test/fixtures/docs-conformance
git mv ../../fixtures/conformance/template-source-conformance packages/codegen-ts/test/fixtures/docs-conformance/template-source-conformance
git mv ../../fixtures/conformance/template-source-conformance-package packages/codegen-ts/test/fixtures/docs-conformance/template-source-conformance-package
```
(Run from `server/typescript`. The corpus is at repo-root `fixtures/conformance`; adjust the `../../` if your cwd differs — the target is `<repo>/server/typescript/packages/codegen-ts/test/fixtures/docs-conformance/`.)
- [ ] **Step 2: Update `CORPUS` in the 3 files.** Each currently is `resolve(import.meta.dir, "<...>/fixtures/conformance")`. New targets (relative to each file's dir):
  - `test/golden/template-source-conformance.test.ts` and `test/golden/docs-cross-link-conformance.test.ts` (both in `test/golden/`): `const CORPUS = resolve(import.meta.dir, "../fixtures/docs-conformance");`
  - `test/api-docs-subdir.test.ts` (in `test/`): `const CORPUS = resolve(import.meta.dir, "./fixtures/docs-conformance");`
  Leave the `FIXTURE`/`FIXTURE_PACKAGE` name constants unchanged (the dir names didn't change).
- [ ] **Step 3: Run → PASS.** `bun test packages/codegen-ts/test/golden/template-source-conformance.test.ts packages/codegen-ts/test/golden/docs-cross-link-conformance.test.ts packages/codegen-ts/test/api-docs-subdir.test.ts` → all green at the new path.
- [ ] **Step 4: Confirm the corpus no longer contains them.** `ls ../../fixtures/conformance | grep template-source || echo "gone from shared corpus"` → expect "gone". (Cross-port harnesses — C# `FixtureDiscovery.cs`, the TS `conformance` bin — enumerate `fixtures/conformance/` by directory; removing these input-only dirs stops them tripping on "no expectation files".)
- [ ] **Step 5: Run full codegen-ts.** `bun test packages/codegen-ts` → 0 fail.
- [ ] **Step 6: Commit.** `git add -A && git commit -m "test(codegen-ts): relocate TS-only docs fixtures out of the shared cross-port corpus" -m "These are TS docs-gate inputs (input-only, no cross-port expectations); they belong package-local, not in fixtures/conformance/ which cross-port harnesses glob expecting per-case expectations." -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

## Task 3: `apiSurfaceHref` — relative-or-baseUrl cross-link base

**Files:** `packages/codegen-ts/src/docs-paths.ts`; test `packages/codegen-ts/test/docs-paths-cross.test.ts` (extend).

- [ ] **Step 1: Failing test.** Append to `test/docs-paths-cross.test.ts`:
```ts
import { apiSurfaceHref } from "../src/docs-paths.js";
test("apiSurfaceHref relative when no baseUrl", () => {
  expect(apiSurfaceHref("Order.md", { subDir: "api/ts" }, "Order.md")).toBe("./api/ts/Order.md");
  expect(apiSurfaceHref("acme/shop/Order.md", { subDir: "api/java" }, "acme/shop/Order.md")).toBe("../../api/java/acme/shop/Order.md");
});
test("apiSurfaceHref absolute when baseUrl set", () => {
  expect(apiSurfaceHref("Order.md", { subDir: "api/java", baseUrl: "https://d/java" }, "acme/shop/Order.md")).toBe("https://d/java/acme/shop/Order.md");
});
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** In `docs-paths.ts`, after `surfaceCrossHref`:
```ts
/** Href FROM a page (at `fromOutputPath`, relative to the docs root) TO a page
 *  (`page`, relative to the surface's own root) in an api surface. Relative via
 *  `surfaceCrossHref` when the surface is in the same tree; absolute `baseUrl/page`
 *  when the surface declares a baseUrl (federated / separate repo). */
export function apiSurfaceHref(
  fromOutputPath: string,
  surface: { subDir: string; baseUrl?: string },
  page: string,
): string {
  if (surface.baseUrl !== undefined && surface.baseUrl !== "") {
    return `${surface.baseUrl.replace(/\/$/, "")}/${page}`;
  }
  return surfaceCrossHref(fromOutputPath, `${surface.subDir}/${page}`);
}
```
- [ ] **Step 4: Run → PASS.** `bun test packages/codegen-ts/test/docs-paths-cross.test.ts`.
- [ ] **Step 5: Commit.** `git add -A packages/codegen-ts && git commit -m "feat(codegen-ts): apiSurfaceHref (relative or baseUrl) cross-link base" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

## Task 4: model page → `apiRefs[]` (one link per surface)

**Files:** `generators/docs-file.ts`, `generators/docs-data-builder.ts`, `generators/docs-data.ts`, `templates/docs/entity-page.md.mustache` (+ run sync); update entity/index goldens once.

- [ ] **Step 1: Change the data shape.** In `docs-data.ts` replace the single `apiPageHref?: string` (L181–185) with:
```ts
/** Cross-links to this entity's generated-SDK api page, one per api surface
 *  (per language). Present only when api surfaces are emitted with the model. */
apiRefs?: Array<{ label: string; href: string }>;
```
- [ ] **Step 2: Builder.** In `docs-data-builder.ts`: replace `apiPageHref?: string` on `BuildDocDataOpts` (L62–73) with `apiRefs?: Array<{ label: string; href: string }>;`; replace the set block (L477–479) with:
```ts
if (opts.apiRefs !== undefined) data.apiRefs = opts.apiRefs;
```
- [ ] **Step 3: docs-file opts + per-entity refs.** In `docs-file.ts`: change `DocsFileOpts.apiSurface?: { subDir: string }` (L48–58) to:
```ts
apiSurfaces?: Array<{ label: string; subDir: string; baseUrl?: string }>;
```
In the entity loop (replace L116–119), build the list:
```ts
const apiRefs = opts?.apiSurfaces?.map((s) => ({
  label: s.label,
  href: apiSurfaceHref(path, s, path),
}));
```
and pass `apiRefs` into `buildEntityDocData` (where it passed `apiPageHref`). Import `apiSurfaceHref` from `../docs-paths.js`.
- [ ] **Step 4: Index multi-link.** Change the index wiring (L162–165) to compute one ref per surface:
```ts
const apiIndexRefs = opts?.apiSurfaces?.map((s) => ({
  label: s.label,
  href: apiSurfaceHref(INDEX_FILENAME, s, INDEX_FILENAME),
}));
```
Change `renderIndexPage` to accept `apiIndexRefs?: Array<{label,href}>` (replacing the single `apiIndexHref`) and render the `## API reference` section as a list:
```ts
// inside renderIndexPage, when apiIndexRefs?.length:
//   "## API reference\n\n" + apiIndexRefs.map(r => `- [${r.label}](${r.href})`).join("\n") + "\n"
```
- [ ] **Step 5: Template.** In canonical `templates/docs/entity-page.md.mustache` replace the `{{#apiPageHref}}…{{/apiPageHref}}` block (L8–11) with:
```
{{#apiRefs.length}}
**API reference:** {{#apiRefs}}[{{label}}]({{href}}){{^last}} · {{/last}}{{/apiRefs}}

{{/apiRefs.length}}
```
To make `{{^last}}` work, set a `last` flag on the final ref in the builder (Step 2): when assigning `data.apiRefs`, mark the last element `{ ...r, last: true }`. (Simpler alternative if the Mustache impl lacks `.length`: render each on its own line — `{{#apiRefs}}**{{label}}:** [{{label}} SDK]({{href}})\n{{/apiRefs}}` — choose whichever the existing renderer supports; verify against `renderDocPage`.)
- [ ] **Step 6: Sync templates.** `bash scripts/sync-doc-templates.sh` (canonical → package copy + embedded module).
- [ ] **Step 7: Run + update goldens once.** `bun test packages/codegen-ts`. The entity/index goldens that exercise api cross-links now render the `apiRefs` shape (e.g. `**API reference:** [TypeScript](api/…)`); update those goldens to the new output in this commit. Confirm `template-doc-conformance.test.ts` (root==package) green.
- [ ] **Step 8: Commit.** `git add -A packages/codegen-ts templates && git commit -m "feat(codegen-ts): model page links a list of api surfaces (apiRefs)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

## Task 5: `meta docs` emits per-surface + links all declared

**Files:** `cli/src/commands/docs.ts`; test `cli/test/unit/docs-command-surfaces.test.ts` (extend).

- [ ] **Step 1: Failing test.** Add a case that sets `docs.apiSurfaces` to two entries (`ts` at `api/ts`, `java` at `api/java`) in the temp project's config, runs `docsCommand`, and asserts: the TS api pages exist under `api/ts/`, NO `api/java/` pages are written by this command, a model entity page contains BOTH `](api/ts/` and `](api/java/` links, and the run logs a note mentioning `java`. (Model-page link assertion can read the emitted `<Entity>.md` text.)
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** In `docs.ts`:
  - Build the resolved-label list once: `const surfaces = docsCfg.apiSurfaces.map(s => ({ ...s, label: apiLabel(s.lang) }));` (import `apiLabel`).
  - Model emit: pass ALL surfaces for linking: `docsFile({ apiSurfaces: surfaces.map(({label,subDir,baseUrl}) => ({label,subDir,...(baseUrl?{baseUrl}:{})})) })` when `"model" ∈ surfaces` and api is being emitted; else `docsFile()`. (Replace the L282–284 `bothSurfaces` conditional.)
  - Api emit: only for surfaces THIS port owns (`lang === "ts"`). For each owned surface: `apiDocsFile({ subDir: s.subDir, modelSurface: docsCfg.surfaces.includes("model") }).generate(ctx)` (replace L320–323). Collect their files.
  - Note: for each declared surface whose `lang !== "ts"`, `log.info(\`meta docs: api surface '\${s.lang}' (\${s.subDir}) is produced by that port's docs command — run it to populate those pages.\`)`.
  - Keep the existing model-only / no-config behavior (no api when config absent).
- [ ] **Step 4: Run → PASS.** `bun test packages/cli/test/unit/docs-command-surfaces.test.ts`, then `bun test packages/cli` (0 fail).
- [ ] **Step 5: Commit.** `git add -A packages/cli && git commit -m "feat(cli): meta docs emits owned api surfaces + links all declared (polyglot)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

## Task 6: Multi-surface cross-link conformance gate

**Files:** `packages/codegen-ts/test/golden/docs-cross-link-conformance.test.ts` (extend).

- [ ] **Step 1: Add a multi-surface emit helper + test.** Add an `emitMulti(fixture, layout)` that emits the model with TWO surfaces and BOTH api surfaces (the second simulates a "java" port by running the api engine again under a different subDir):
```ts
const surfaces = [{ label: "TypeScript", subDir: "api/ts" }, { label: "Java", subDir: "api/java" }];
const files = [
  ...await docsFile({ apiSurfaces: surfaces }).generate(ctx),
  ...await apiDocsFile({ subDir: "api/ts", modelSurface: true }).generate(ctx),
  ...await apiDocsFile({ subDir: "api/java", modelSurface: true }).generate(ctx),
];
```
- [ ] **Step 2: Assertions (both layouts).** Reuse `findBrokenCrossLinks` (generalize it to treat any path under `api/ts/` or `api/java/` as "api surface" — i.e. `isApi = p => p.startsWith("api/")`, already true). Assert: 0 broken; the model entity page has TWO api links (count `](api/ts/` and `](api/java/` occurrences ≥1 each); each api surface links back to the model. Run for `flat` and `package`.
- [ ] **Step 3: baseUrl case.** A unit asserting `apiSurfaceHref` with a `baseUrl` surface produces an absolute link, and that such a link is correctly NOT expected in the local `present` set (federated). Assert the docs-file `apiRefs` for a baseUrl surface start with `https://`.
- [ ] **Step 4: Run → PASS.** `bun test packages/codegen-ts/test/golden/docs-cross-link-conformance.test.ts`, then `bun test packages/codegen-ts` (0 fail).
- [ ] **Step 5: Commit.** `git add -A packages/codegen-ts && git commit -m "test(codegen-ts): multi-surface + baseUrl cross-link integrity gate" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

## Task 7: ADR + closeout

**Files:** new `spec/decisions/ADR-00NN-polyglot-docs-composition.md` (next free number — check `ls spec/decisions`; ADR-0025 exists, use 0026 unless taken); pointer line in ADR-0025; (no agent-context change needed — `apiSurfaces` is config, the existing `meta docs` pointer still holds).

- [ ] **Step 1: Write the ADR.** Record: per-language `apiSurfaces[]` (explicit-list, buf/Smithy-aligned; manifest deferred), model-once + per-language api, cross-link base relative-or-`baseUrl` (one-tree / federated), the per-port-command/shared-model-engine principle (from ADR-0025), and that SP-2 adds the Java api surface emitting into this contract. Add "Extended by ADR-00NN" pointer to ADR-0025.
- [ ] **Step 2: Full suite.** `bun test packages/codegen-ts packages/cli` → record counts, 0 fail.
- [ ] **Step 3: Whole-branch review + code-simplifier; fix findings.**
- [ ] **Step 4: Forward-merge** to origin/main via a temp worktree off latest origin/main (main checkout has other sessions' WIP — don't touch). Renumber the ADR if a sibling took the number. Remove worktrees/branches. Update memory.

## Guard
- PUBLIC repo: no private/other-project names, no home paths (code, fixtures, commit messages).
- No back-compat: the unreleased docs door may change output; update goldens once to the `apiRefs` shape. But the change must be intentional — review each golden diff.
- Reuse `apiSurfaceHref`/`surfaceCrossHref`/`docPageOutputPath` — never hand-roll relative paths. `apiLabel` is the single lang→label source.
- TS-local fixtures only; never add to `fixtures/conformance/` (cross-port corpus).
- Scope: do NOT build the Java api surface (SP-2), the federation manifest, or touch verify.ts / rich-view / other generators.
