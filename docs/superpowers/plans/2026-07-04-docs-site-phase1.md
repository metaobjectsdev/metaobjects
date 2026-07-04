# Docs Site — Phase 1 (Port as `meta docs --site`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the proven HTML documentation-site generator into the metaobjects monorepo as `@metaobjectsdev/docs-site`, wired as a new `meta docs --site` surface, keeping its current graph/output verbatim.

**Architecture:** A verbatim port of a model-agnostic bun/TypeScript generator (loader → link-graph → page builders → mermaid emitters → site orchestrator → link-check) into a new workspace package, plus a thin `--site` branch in the `meta docs` CLI command that calls the package's `generateSite()`. No behavior change to the generator; the shared-relationship-IR consolidation is Phase 2.

**Tech Stack:** bun, TypeScript (monorepo `tsconfig.base.json`), `@metaobjectsdev/metadata` + `@metaobjectsdev/render` (workspace deps), `yaml`, mustache templates, Tailwind/daisyUI + mermaid (CDN, referenced by the site's chrome).

## Global Constraints

- **Public repo:** metaobjects is public. The package ships ONLY the generic `acme` fixture + generic docs — no downstream/consumer/client names, no absolute local paths. Verify `git diff` before every commit.
- **Verbatim port:** the generator's `src/`, `templates/`, `assets/`, `test/`, and `test/fixture/` are copied UNCHANGED from the reference implementation. Do not "improve" them here — Phase 2 owns graph changes. The ONLY new/edited files are the package manifest/tsconfig, `src/index.ts`, and the CLI `--site` wiring.
- **Determinism + link-check preserved:** the byte-identical golden test and the link checker (generation throws on dangling links) must stay green; two regenerations must be byte-identical.
- **Escaping invariant:** `@metaobjectsdev/render`'s `render()` does not HTML-escape; the ported builders already escape at the boundary via the single canonical `esc`. Do not change this.
- **Package conventions:** match the sibling TS packages (`codegen-ts-react` etc.): `"type": "module"`, `exports` with a `bun → ./src/index.ts` condition, `tsc -p .` build to `dist`, `bun test`, workspace deps as `workspace:*`, `"license": "Apache-2.0"`, `publishConfig.access: public`.

## Source of the ported files

The verbatim-port files come from the reference implementation's `metadata-docs` tree. The exact file list is fixed (below). If a reviewer/implementer does not have that tree mounted, the files are available on the `feat/docs-site` branch history where the controller placed them; treat the on-branch copies as the source of truth. Do NOT re-derive them.

**Port these UNCHANGED** into `server/typescript/packages/docs-site/`:
- `src/`: `badges.ts`, `coverage.ts`, `link-check.ts`, `link-graph.ts`, `load.ts`, `mermaid.ts`, `mustache-highlight.ts`, `package-docs.ts`, `site.ts`, `yaml-comments.ts`, and `src/builders/`: `extras.ts`, `index-data.ts`, `object-data.ts`, `output-data.ts`, `package-data.ts`, `prompt-data.ts`.
- `templates/`: the 9 `*.mustache` files (`chrome-head`, `chrome-foot`, `index.html`, `package.html`, `object.html`, `prompt.html`, `output.html`, `enums.html`, `coverage.html`).
- `assets/`: `site.css`, `site.js`.
- `test/`: the 14 `*.test.ts` files (`badges`, `coverage`, `golden`, `graph-v2`, `index-package-v2`, `link-check`, `link-graph`, `load`, `mermaid`, `mustache-highlight`, `object-data`, `object-data-v2`, `package-docs`, `package-index-data`, `prompt-output-extras`, `site` — note some map 1:1) and `test/fixture/` (`input/acme/**` + `golden/**`).
- **Do NOT port** the reference `generate.ts` (it is the downstream entry point; the CLI replaces it) or `package.json`/`bun.lock` (the monorepo manifest replaces them).

---

## File Structure

New package `server/typescript/packages/docs-site/`:
- `package.json` — NEW (manifest; deps `@metaobjectsdev/metadata` + `@metaobjectsdev/render` `workspace:*`, `yaml`).
- `tsconfig.json`, `tsconfig.typecheck.json` — NEW (extend `../../tsconfig.base.json`, matching siblings).
- `README.md`, `LICENSE` — NEW (LICENSE copied from a sibling package).
- `src/**` — ported verbatim + `src/index.ts` NEW (public API barrel).
- `templates/**`, `assets/**` — ported verbatim (live at package root so `resolve(import.meta.dir, "../templates")` resolves from both `src/` and `dist/`).
- `test/**` — ported verbatim.

Modified:
- `server/typescript/packages/cli/src/commands/docs.ts` — add the `--site` surface.

---

## Task 1: Scaffold the package + port the generator; `bun test` green

**Files:**
- Create: `server/typescript/packages/docs-site/package.json`, `tsconfig.json`, `tsconfig.typecheck.json`, `README.md`, `LICENSE`, `src/index.ts`
- Create (verbatim port): all `src/**`, `templates/**`, `assets/**`, `test/**` per "Source of the ported files"
- Test: the ported `test/**` (run via `bun test`)

**Interfaces:**
- Produces: `@metaobjectsdev/docs-site` exporting `generateSite(opts: SiteOptions): Promise<SiteResult>`, `SiteOptions = { sourceDirs: string[]; outDir: string; title: string; stamp: string; commit: string; core?: { n?: number }; templatesDir?: string }`, `SiteResult = { pages: string[]; coverage: CoverageReport; anomalies: Anomaly[]; dangling: string[] }` (re-exported from `./src/site`).

- [ ] **Step 1: Create the package dir + port the files verbatim.**

```bash
cd server/typescript/packages
mkdir -p docs-site
# from the reference tree (or the branch copies), copy UNCHANGED:
cp -R <ref>/src docs-site/src
cp -R <ref>/templates docs-site/templates
cp -R <ref>/assets docs-site/assets
cp -R <ref>/test docs-site/test
# LICENSE from a sibling:
cp codegen-ts-react/LICENSE docs-site/LICENSE
```
Confirm no `generate.ts`, no `package.json`, no `bun.lock`, no `node_modules`, no `mockup/` were copied.

- [ ] **Step 2: Write `docs-site/package.json`** (manifest matching siblings; deps as workspace):

```json
{
  "name": "@metaobjectsdev/docs-site",
  "version": "0.15.6",
  "description": "HTML documentation-site generator for metaobjects models — a browsable multi-page site (nav, search, per-object/package pages, kind-aware ER diagrams). The `meta docs --site` surface.",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "bun": "./src/index.ts", "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  },
  "files": ["dist", "src", "templates", "assets", "README.md", "LICENSE"],
  "scripts": { "build": "tsc -p .", "typecheck": "tsc -p tsconfig.typecheck.json", "test": "bun test" },
  "license": "Apache-2.0",
  "author": "Doug Mealing <doug@dougmealing.com>",
  "homepage": "https://metaobjects.dev",
  "bugs": { "url": "https://github.com/metaobjectsdev/metaobjects/issues" },
  "repository": { "type": "git", "url": "https://github.com/metaobjectsdev/metaobjects.git", "directory": "server/typescript/packages/docs-site" },
  "keywords": ["metaobjects", "docs", "documentation", "html", "site", "erd"],
  "publishConfig": { "access": "public" },
  "dependencies": {
    "@metaobjectsdev/metadata": "workspace:*",
    "@metaobjectsdev/render": "workspace:*",
    "yaml": "^2.9.0"
  },
  "devDependencies": { "bun-types": "latest", "typescript": "^5.6.0" }
}
```

- [ ] **Step 3: Write `docs-site/tsconfig.json` and `tsconfig.typecheck.json`** (match siblings):

`tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "./dist", "rootDir": "./src" }, "include": ["src/**/*"], "exclude": ["dist", "test", "node_modules"] }
```
`tsconfig.typecheck.json` (copy the sibling's — typically includes `src` + `test` with `noEmit`; mirror `codegen-ts-react/tsconfig.typecheck.json` exactly).

- [ ] **Step 4: Write `docs-site/src/index.ts`** (public API barrel):

```ts
export { generateSite } from "./site";
export type { SiteOptions, SiteResult } from "./site";
```
(If `site.ts` does not already export `SiteOptions`/`SiteResult` as named types, confirm it does — the reference version exports both. Do not add new logic.)

- [ ] **Step 5: Install + run the ported tests.** From the repo root:

```bash
bun install
bun test server/typescript/packages/docs-site
```
Expected: all ported tests pass (the golden byte-identical test + graph/builder/mermaid/link-check unit tests). If the golden test fails, the FIRST suspect is template/asset resolution: `resolve(import.meta.dir, "../templates")` must resolve to `docs-site/templates`. Since bun runs `src/site.ts` directly, `import.meta.dir` = `docs-site/src`, so `../templates` = `docs-site/templates` ✓ and `../assets` = `docs-site/assets` ✓. If a test references a path that assumed the old repo layout, fix the TEST's fixture path only (never the generator's behavior); report any such change.

- [ ] **Step 6: Hygiene check + commit.**

```bash
grep -rniE "<downstream-name>|/home/" server/typescript/packages/docs-site/ && echo "LEAK — stop" || echo clean
git add server/typescript/packages/docs-site
git commit -m "feat(docs-site): port HTML documentation-site generator as @metaobjectsdev/docs-site (verbatim, acme fixture, tests green)"
```

---

## Task 2: Build to `dist` + typecheck green (dist template/asset resolution)

**Files:**
- Modify: none (verifies the Task-1 package builds); may adjust `files`/paths only if the build reveals a gap.

**Interfaces:**
- Consumes: the Task-1 package.
- Produces: a built `dist/` with working template/asset resolution, so downstream consumers importing the built package (not the `bun` src condition) still find templates.

- [ ] **Step 1: Build.** `bun run --cwd server/typescript/packages/docs-site build` (i.e. `tsc -p .`). Expected: `dist/` emitted, no type errors.
- [ ] **Step 2: Typecheck.** `bun run --cwd server/typescript/packages/docs-site typecheck`. Expected: clean.
- [ ] **Step 3: Verify dist template resolution.** From a scratch script, import the BUILT package (force the `default`/`dist` condition, not `bun`) and generate against the fixture into a tmp dir; confirm it does not throw and writes pages. Because `dist/site.js` sits at `docs-site/dist/`, `resolve(import.meta.dir, "../templates")` = `docs-site/templates` ✓ — templates/assets are NOT under `dist`, and are included in `files`, so both bun-src and dist runs resolve them. If the built run cannot find templates, the fix is to ensure `templates`/`assets` are in `package.json` `files` (already are) and that the resolution is `../templates` from `dist` (it is) — do NOT copy templates into `dist`.
- [ ] **Step 4: Commit** (only if any manifest/path adjustment was needed):

```bash
git commit -am "build(docs-site): confirm dist build + template/asset resolution from built output"
```

---

## Task 3: Wire the `meta docs --site` surface + end-to-end verify

**Files:**
- Modify: `server/typescript/packages/cli/src/commands/docs.ts` (add `--site` flag + emit branch)
- Modify: `server/typescript/packages/cli/package.json` (add `@metaobjectsdev/docs-site` as a `workspace:*` dependency)
- Modify: `server/typescript/packages/cli/src/index.ts` (help text: mention `--site`)

**Interfaces:**
- Consumes: `generateSite` from `@metaobjectsdev/docs-site`.

- [ ] **Step 1: Add the dependency.** In `cli/package.json` dependencies add `"@metaobjectsdev/docs-site": "workspace:*"`; run `bun install` from the repo root.

- [ ] **Step 2: Parse the `--site` flag.** In `docs.ts`'s arg loop (alongside `--model`/`--api`/`--metamodel`), add:

```ts
} else if (a === "--site") {
  wantSite = true;
```
Declare `let wantSite = false;` next to `wantModel`/`wantApi`/`wantMetamodel`, and return it from the parse result (extend the options type with `site: boolean` mirroring `metamodel: boolean`).

- [ ] **Step 3: Emit the site when `--site` is set.** In the command's run body, AFTER the existing surface handling, add a branch that resolves the metadata source dir(s) the command already computes (the `<metadata>` root's `metaobjects/` source path used to load the model — reuse the SAME dirs the model loader reads), then calls `generateSite`:

```ts
import { generateSite } from "@metaobjectsdev/docs-site";
// ... after model/api/metamodel handling, before the final summary:
if (opts.site) {
  const outDir = /* the resolved out dir, default ./docs/site when --site */;
  const r = await generateSite({
    sourceDirs: /* the resolved metadata source dirs (same the model loader uses) */,
    outDir,
    title: /* project/model title — reuse the command's existing title source, else "Metadata" */,
    stamp: new Date().toISOString().slice(0, 10),
    commit: "",                 // CLI has no repo commit context by default; empty is fine
    core: { n: 15 },
  });
  // reuse the command's existing "wrote N files" reporting shape for the site
}
```
Notes for the implementer: (a) find how the command resolves the metadata source directory it feeds to the loader — pass those exact dirs as `sourceDirs`; (b) default the site out dir to `./docs/site` (parallel to the markdown `./docs`); (c) `--templates <dir>` (already parsed) should be threaded as `templatesDir` so the scaffold-and-own override works for the site too; (d) `--site` is additive — if combined with `--model`/`--api`, emit both.

- [ ] **Step 4: Help text.** In `cli/src/index.ts` `docs` help, add a line: `  --site               generate the browsable HTML documentation site (docs/site/)`.

- [ ] **Step 5: End-to-end verify.** Build the cli (`bun run --cwd server/typescript/packages/cli build` if it builds; else run via bun src). Run the CLI's `docs --site` against the ported `acme` fixture model into a tmp dir:
  - it MUST NOT throw (link-check green),
  - it writes `index.html` + per-package/object pages + `assets/`,
  - two runs are byte-identical (determinism).
  Grep the output for `party.?lore`/`/home/` → none.

- [ ] **Step 6: Hygiene + commit.**

```bash
grep -rniE "<downstream-name>|/home/" server/typescript/packages/cli/src/commands/docs.ts && echo "LEAK — stop" || echo clean
git add server/typescript/packages/cli
git commit -m "feat(cli): meta docs --site surface — emit the HTML documentation site via @metaobjectsdev/docs-site"
```

---

## Self-Review

**Spec coverage (Phase 1):** new `@metaobjectsdev/docs-site` package → Task 1; `meta docs --site` surface, additive to markdown → Task 3; verbatim port of generator + `acme` fixture + tests → Task 1; deterministic + link-checked → Tasks 1 & 3; public-repo hygiene → hygiene checks in Tasks 1 & 3; dist build + template resolution → Task 2; escaping/determinism invariants preserved (no generator edits) → Global Constraints. Phase 2 (shared-IR graph) and Phase 3 (scaffold-and-own + consumers) are out of scope by design.

**Placeholder scan:** the `/* ... */` comments in Task 3 Step 3 are integration-point pointers, not code placeholders — the surrounding code + notes tell the implementer exactly what to substitute (the command's own resolved source dirs / out / title). They are unavoidable because they reference the CLI command's existing local variables, which the implementer reads in-file. Everything else is concrete.

**Type consistency:** `generateSite`/`SiteOptions`/`SiteResult` names match across Tasks 1 and 3; `wantSite`/`site: boolean` mirror the existing `wantMetamodel`/`metamodel: boolean` pattern in `docs.ts`; `templatesDir` matches `SiteOptions`.
