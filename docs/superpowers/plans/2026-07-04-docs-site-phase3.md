# Docs Site — Phase 3 (Scaffold-and-Own) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a metaobjects consumer own (theme) its docs-site templates + assets: a `meta docs --scaffold-site` command copies them into `codegen/docs-site/`, `generateSite` gains an `assetsDir` override, and `meta docs --site` auto-detects the owned copies.

**Architecture:** Mirror the existing ADR-0034 codegen scaffold (`meta init` → `codegen/generators/`, write-only-if-absent). The docs-site package exposes its bundled templates/assets through a small `scaffold.ts` API (`SITE_TEMPLATE_NAMES`/`SITE_ASSET_NAMES`/`readSiteFile`); the CLI copies from that API and, on `--site`, passes the owned dirs to `generateSite` when present (bundled fallback).

**Tech Stack:** bun, TypeScript (monorepo `tsconfig.base.json`), `@metaobjectsdev/docs-site` (workspace dep of the CLI), mustache templates.

**Spec:** `docs/superpowers/specs/2026-07-04-docs-site-phase3-design.md`

## Global Constraints

- **Public repo hygiene:** no private/downstream project names, no `/home/…` absolute paths, in code/tests/docs/commit messages. A commit guard enforces a denylist; also `grep -rniE "/home/"` touched files before committing.
- **ADR-0034 scaffold semantics:** scaffold writes a file ONLY if its target is absent (never clobber a hand-edited file); report created vs preserved; the owned copy of the same basename wins over the bundled one.
- **No new package dependency:** the CLI already depends on `@metaobjectsdev/docs-site` (`workspace:*`). Do not add others.
- **exactOptionalPropertyTypes:** new optional fields use `?: T | undefined`.
- **Determinism + link-check unchanged:** two regenerations are byte-identical; `generateSite` throws on any dangling link.
- **Scaffold location:** `codegen/docs-site/templates/` (9 mustache) + `codegen/docs-site/assets/` (`site.css`, `site.js`) — parallel to the existing `codegen/generators/`.

---

## File Structure

- `server/typescript/packages/docs-site/src/site.ts` — MODIFY: `SiteOptions.assetsDir?`; a `loadAsset(name, overrideDir?)` helper; route the two asset writes through it.
- `server/typescript/packages/docs-site/src/scaffold.ts` — CREATE: `SITE_TEMPLATE_NAMES`, `SITE_ASSET_NAMES`, `readSiteFile(kind, name)`.
- `server/typescript/packages/docs-site/src/index.ts` — MODIFY: re-export the scaffold API.
- `server/typescript/packages/docs-site/test/scaffold.test.ts` — CREATE.
- `server/typescript/packages/docs-site/test/site.test.ts` — MODIFY: assetsDir override test.
- `server/typescript/packages/cli/src/commands/docs.ts` — MODIFY: `--scaffold-site` flag + command; auto-detect owned dirs on `--site`.
- `server/typescript/packages/cli/src/index.ts` — MODIFY: `--scaffold-site` help line.
- `server/typescript/packages/cli/test/docs-command.test.ts` — MODIFY: scaffold + auto-detect tests.
- `server/typescript/packages/docs-site/README.md` — MODIFY: "Own your docs-site theme" section.

---

## Task 1: `assetsDir` override in `generateSite`

**Files:**
- Modify: `server/typescript/packages/docs-site/src/site.ts`
- Test: `server/typescript/packages/docs-site/test/site.test.ts`

**Interfaces:**
- Produces: `SiteOptions.assetsDir?: string | undefined`; when set and a file of the same basename exists there, it is written instead of the bundled asset.

- [ ] **Step 1: Write the failing test.** Append to `test/site.test.ts`:

```ts
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("assetsDir override: a consumer site.css wins over the bundled one", async () => {
  const overrideDir = mkdtempSync(join(tmpdir(), "assets-override-"));
  writeFileSync(join(overrideDir, "site.css"), "/* OWNED CSS MARKER */", "utf8");
  const out = mkdtempSync(join(tmpdir(), "site-out-"));
  await generateSite({
    sourceDirs: [join(import.meta.dir, "fixture/input/acme")],
    outDir: out, title: "Fixture", stamp: "2026-01-01", commit: "abc1234",
    assetsDir: overrideDir,
  });
  expect(readFileSync(join(out, "assets/site.css"), "utf8")).toBe("/* OWNED CSS MARKER */");
  // an asset NOT present in the override still comes from the bundled dir
  expect(readFileSync(join(out, "assets/site.js"), "utf8").length).toBeGreaterThan(0);
});
```
(If `test/site.test.ts` already imports `generateSite`, reuse that import rather than re-importing.)

- [ ] **Step 2: Run to verify it fails.** Run: `cd server/typescript/packages/docs-site && bun test test/site.test.ts -t "assetsDir override"`. Expected: FAIL (`SiteOptions` has no `assetsDir`; bundled css written).

- [ ] **Step 3: Add `assetsDir` to `SiteOptions`.** In `src/site.ts`, in the `SiteOptions` interface, after the `templatesDir?` line add:

```ts
  /** Override dir for assets; if a file of the same basename exists here, it wins over the bundled assets/ dir. */
  assetsDir?: string | undefined;
```

- [ ] **Step 4: Add `loadAsset` + a bundled-assets constant.** In `src/site.ts`, next to `BUNDLED_TEMPLATES` / `loadTemplate`, add:

```ts
const BUNDLED_ASSETS = resolve(import.meta.dir, "../assets");

function loadAsset(name: string, overrideDir?: string): string {
  if (overrideDir) {
    const candidate = join(overrideDir, name);
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  return readFileSync(join(BUNDLED_ASSETS, name), "utf8");
}
```

- [ ] **Step 5: Route the asset writes through `loadAsset`.** In `src/site.ts` section "10. Write assets", replace:

```ts
  // 10. Write assets
  const assetsDir = resolve(import.meta.dir, "../assets");
  writeOut(opts.outDir, "assets/site.css", readFileSync(join(assetsDir, "site.css"), "utf8"));
  writeOut(opts.outDir, "assets/site.js", readFileSync(join(assetsDir, "site.js"), "utf8"));
```
with:
```ts
  // 10. Write assets (consumer assetsDir wins over the bundled dir)
  writeOut(opts.outDir, "assets/site.css", loadAsset("site.css", opts.assetsDir));
  writeOut(opts.outDir, "assets/site.js", loadAsset("site.js", opts.assetsDir));
```

- [ ] **Step 6: Run to verify pass + no regression.** Run: `bun test`. Expected: all pass (the new test + the byte-identical golden test — the golden run passes no `assetsDir`, so bundled assets are used, unchanged).

- [ ] **Step 7: Typecheck + commit.**

```bash
bun run typecheck
grep -rniE "/home/" src/site.ts test/site.test.ts && echo LEAK || echo clean
git add src/site.ts test/site.test.ts
git commit -m "feat(docs-site): assetsDir override in generateSite (owned CSS/JS wins over bundled)"
```

---

## Task 2: Export the scaffold source (`SITE_TEMPLATE_NAMES`/`SITE_ASSET_NAMES`/`readSiteFile`)

**Files:**
- Create: `server/typescript/packages/docs-site/src/scaffold.ts`
- Modify: `server/typescript/packages/docs-site/src/index.ts`
- Test: `server/typescript/packages/docs-site/test/scaffold.test.ts`

**Interfaces:**
- Produces: `SITE_TEMPLATE_NAMES: readonly string[]` (9 mustache basenames), `SITE_ASSET_NAMES: readonly string[]` (`site.css`, `site.js`), `readSiteFile(kind: "template" | "asset", name: string): string` (reads the package's bundled file).

- [ ] **Step 1: Write the failing test.** Create `test/scaffold.test.ts`:

```ts
import { expect, test } from "bun:test";
import { SITE_TEMPLATE_NAMES, SITE_ASSET_NAMES, readSiteFile } from "../src/scaffold";

test("SITE_TEMPLATE_NAMES lists all 9 mustache templates", () => {
  expect([...SITE_TEMPLATE_NAMES].sort()).toEqual([
    "chrome-foot.mustache", "chrome-head.mustache", "coverage.html.mustache",
    "enums.html.mustache", "index.html.mustache", "object.html.mustache",
    "output.html.mustache", "package.html.mustache", "prompt.html.mustache",
  ]);
});

test("SITE_ASSET_NAMES lists the two assets", () => {
  expect([...SITE_ASSET_NAMES].sort()).toEqual(["site.css", "site.js"]);
});

test("readSiteFile returns the bundled template + asset contents", () => {
  for (const name of SITE_TEMPLATE_NAMES) expect(readSiteFile("template", name).length).toBeGreaterThan(0);
  expect(readSiteFile("asset", "site.css").length).toBeGreaterThan(0);
  // chrome-head is the page shell — sanity-check it is real template content
  expect(readSiteFile("template", "chrome-head.mustache")).toContain("{{");
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `bun test test/scaffold.test.ts`. Expected: FAIL (module `../src/scaffold` not found).

- [ ] **Step 3: Create `src/scaffold.ts`.**

```ts
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The 9 mustache templates the site is built from (basenames under templates/). */
export const SITE_TEMPLATE_NAMES: readonly string[] = [
  "chrome-head.mustache",
  "chrome-foot.mustache",
  "index.html.mustache",
  "package.html.mustache",
  "object.html.mustache",
  "prompt.html.mustache",
  "output.html.mustache",
  "enums.html.mustache",
  "coverage.html.mustache",
];

/** The site's themeable assets (basenames under assets/). search-index.json is generated, not themed. */
export const SITE_ASSET_NAMES: readonly string[] = ["site.css", "site.js"];

/** Read a bundled template or asset by basename (for scaffolding into a consumer). */
export function readSiteFile(kind: "template" | "asset", name: string): string {
  const dir = resolve(import.meta.dir, kind === "template" ? "../templates" : "../assets");
  return readFileSync(join(dir, name), "utf8");
}
```
Note: `import.meta.dir` is `docs-site/src` under bun and `docs-site/dist` under node; `../templates`/`../assets` resolve to the package-root dirs in both (they are in `package.json` `files`), exactly as `site.ts` already relies on.

- [ ] **Step 4: Re-export from `src/index.ts`.** Replace `src/index.ts` with:

```ts
export { generateSite } from "./site";
export type { SiteOptions, SiteResult } from "./site";
export { SITE_TEMPLATE_NAMES, SITE_ASSET_NAMES, readSiteFile } from "./scaffold";
```

- [ ] **Step 5: Run to verify pass.** Run: `bun test test/scaffold.test.ts`. Expected: PASS. Then `bun run typecheck` (clean) and `bun run build` (so the CLI's dist typecheck sees the new exports in Task 3).

- [ ] **Step 6: Commit.**

```bash
git add src/scaffold.ts src/index.ts test/scaffold.test.ts
git commit -m "feat(docs-site): export SITE_TEMPLATE_NAMES/SITE_ASSET_NAMES/readSiteFile for scaffolding"
```

---

## Task 3: `meta docs --scaffold-site` + auto-detect owned copies on `--site`

**Files:**
- Modify: `server/typescript/packages/cli/src/commands/docs.ts`
- Modify: `server/typescript/packages/cli/src/index.ts` (help line)
- Test: `server/typescript/packages/cli/test/docs-command.test.ts`

**Interfaces:**
- Consumes: `SITE_TEMPLATE_NAMES`, `SITE_ASSET_NAMES`, `readSiteFile` from `@metaobjectsdev/docs-site`; `generateSite`'s `templatesDir`/`assetsDir`.
- Produces: a `--scaffold-site` flag that copies templates+assets into `<root>/codegen/docs-site/{templates,assets}` (write-only-if-absent) and returns; `meta docs --site` passes those owned dirs to `generateSite` when present.

- [ ] **Step 1: Write the failing tests.** Append to `test/docs-command.test.ts` (it already has `project()`, `logged`, `run`, `docsCommand`, and imports `existsSync`, `readFile`, `readdir`, `join`):

```ts
describe("meta docs --scaffold-site — own your theme", () => {
  test("scaffolds the 9 templates + 2 assets into codegen/docs-site, preserving existing", async () => {
    const root = await project();
    // pre-place one edited template to prove it is preserved (not clobbered)
    await mkdir(join(root, "codegen/docs-site/templates"), { recursive: true });
    await writeFile(join(root, "codegen/docs-site/templates/chrome-head.mustache"), "OWNED HEAD", "utf8");

    const code = await docsCommand([root, "--scaffold-site"], root);
    expect(code).toBe(0);

    // all 9 templates + 2 assets exist
    for (const n of ["chrome-head.mustache", "coverage.html.mustache", "object.html.mustache"]) {
      expect(existsSync(join(root, "codegen/docs-site/templates", n))).toBe(true);
    }
    expect(existsSync(join(root, "codegen/docs-site/assets/site.css"))).toBe(true);
    expect(existsSync(join(root, "codegen/docs-site/assets/site.js"))).toBe(true);
    // the pre-existing edited template is PRESERVED (not overwritten)
    expect(await readFile(join(root, "codegen/docs-site/templates/chrome-head.mustache"), "utf8")).toBe("OWNED HEAD");
    // summary reports created + preserved
    expect(logged.join("\n")).toMatch(/scaffold-site/);
  });

  test("--site auto-detects owned templates: an edited template wins in the output", async () => {
    const root = await project();
    await docsCommand([root, "--scaffold-site"], root);
    // edit the scaffolded index template with a unique marker
    const tpl = join(root, "codegen/docs-site/templates/index.html.mustache");
    const orig = await readFile(tpl, "utf8");
    await writeFile(tpl, orig + "\n<!-- OWNED-TEMPLATE-MARKER -->", "utf8");

    const out = join(root, "out-owned");
    const code = await docsCommand([root, "--site", "--out", out], root);
    expect(code).toBe(0);
    expect(await readFile(join(out, "site/index.html"), "utf8")).toContain("OWNED-TEMPLATE-MARKER");
  });

  test("--site auto-detects owned assets: an edited site.css wins in the output", async () => {
    const root = await project();
    await docsCommand([root, "--scaffold-site"], root);
    await writeFile(join(root, "codegen/docs-site/assets/site.css"), "/* OWNED-ASSET-MARKER */", "utf8");
    const out = join(root, "out-owned-asset");
    expect(await docsCommand([root, "--site", "--out", out], root)).toBe(0);
    expect(await readFile(join(out, "site/assets/site.css"), "utf8")).toBe("/* OWNED-ASSET-MARKER */");
  });
});
```

- [ ] **Step 2: Run to verify failure.** Run: `cd server/typescript/packages/cli && bun test test/docs-command.test.ts -t "scaffold-site"`. Expected: FAIL (`--scaffold-site` is an unknown flag → parse error exit 2).

- [ ] **Step 3: Import the scaffold API + `SITE_*` in `docs.ts`.** In `cli/src/commands/docs.ts`, add to the `@metaobjectsdev/docs-site` import (currently `import { generateSite } from "@metaobjectsdev/docs-site";`):

```ts
import { generateSite, SITE_TEMPLATE_NAMES, SITE_ASSET_NAMES, readSiteFile } from "@metaobjectsdev/docs-site";
```

- [ ] **Step 4: Parse `--scaffold-site`.** In `docs.ts`, add `scaffoldSite: boolean` to the `DocsFlags` interface (next to `site: boolean`):

```ts
  /** Copy the docs-site templates + assets into codegen/docs-site/ so the consumer owns them. */
  scaffoldSite: boolean;
```
In `parseDocsArgs`, declare `let wantScaffoldSite = false;` next to `wantSite`, add a branch in the arg loop next to `--site`:
```ts
    } else if (a === "--scaffold-site") {
      wantScaffoldSite = true;
```
and add `scaffoldSite: wantScaffoldSite,` to the returned object (next to `site: wantSite,`).

- [ ] **Step 5: Handle `--scaffold-site` early (scaffold and return).** In `docsCommand`, right after `const metaRoot = resolvePath(cwd, flags.metadata);` add:

```ts
  // `--scaffold-site`: copy the docs-site templates + assets into codegen/docs-site/
  // so the consumer owns them (ADR-0034 scaffold-and-own). Scaffold and return —
  // it does not also generate.
  if (flags.scaffoldSite) {
    return scaffoldSiteCommand(metaRoot);
  }
```

- [ ] **Step 6: Add the `scaffoldSiteCommand` helper.** In `docs.ts`, next to `emitSite`, add:

```ts
/**
 * ADR-0034 scaffold-and-own for the docs-site: copy the bundled templates + assets
 * into `<root>/codegen/docs-site/{templates,assets}`, writing each file ONLY if
 * absent so a re-run never clobbers a hand-edited file.
 */
async function scaffoldSiteCommand(metaRoot: string): Promise<number> {
  const tplDir = join(metaRoot, "codegen/docs-site/templates");
  const astDir = join(metaRoot, "codegen/docs-site/assets");
  const created: string[] = [];
  const preserved: string[] = [];
  try {
    await mkdir(tplDir, { recursive: true });
    await mkdir(astDir, { recursive: true });
    for (const name of SITE_TEMPLATE_NAMES) {
      const abs = join(tplDir, name);
      const rel = `codegen/docs-site/templates/${name}`;
      if (existsSync(abs)) { preserved.push(rel); continue; }
      await writeFile(abs, readSiteFile("template", name), "utf8");
      created.push(rel);
    }
    for (const name of SITE_ASSET_NAMES) {
      const abs = join(astDir, name);
      const rel = `codegen/docs-site/assets/${name}`;
      if (existsSync(abs)) { preserved.push(rel); continue; }
      await writeFile(abs, readSiteFile("asset", name), "utf8");
      created.push(rel);
    }
  } catch (err) {
    log.error(`docs: failed to scaffold site templates: ${(err as Error).message}`);
    return 1;
  }
  log.info(
    `meta docs --scaffold-site — ${created.length} created, ${preserved.length} preserved ` +
      `→ ${join(metaRoot, "codegen/docs-site")} (edit these to own your theme)`,
  );
  return 0;
}
```

- [ ] **Step 7: Auto-detect owned dirs in `emitSite`.** In `docs.ts`, change `emitSite` to compute the owned dirs from `metaRoot` and drop the no-op `projectRoot` threading. Replace the current `emitSite` signature + `generateSite` options. The function becomes:

```ts
async function emitSite(metaRoot: string, outDir: string, flags: DocsFlags): Promise<number> {
  const siteOutDir = resolvePath(outDir, "site");
  const sourceDirs = [join(metaRoot, DEFAULT_METADATA_DIR)];
  // Scaffold-and-own: when the consumer has copied templates/assets into
  // codegen/docs-site/ (via --scaffold-site), use those; else the bundled defaults.
  const ownedTemplates = join(metaRoot, "codegen/docs-site/templates");
  const ownedAssets = join(metaRoot, "codegen/docs-site/assets");
  try {
    const r = await generateSite({
      sourceDirs,
      outDir: siteOutDir,
      title: basename(metaRoot) || "Metadata",
      stamp: new Date().toISOString().slice(0, 10),
      commit: "",
      core: { n: 15 },
      ...(existsSync(ownedTemplates) ? { templatesDir: ownedTemplates } : {}),
      ...(existsSync(ownedAssets) ? { assetsDir: ownedAssets } : {}),
    });
    log.info(`meta docs --site — wrote ${r.pages.length} page(s) → ${siteOutDir}`);
    return 0;
  } catch (err) {
    log.error(`docs: failed to generate site: ${(err as Error).message}`);
    return 1;
  }
}
```
Then update the two `emitSite(...)` call sites in `docsCommand` (the site-only early return and the additive path) to drop the `projectRoot` argument: `return emitSite(metaRoot, outDir, flags);` and `const siteRc = await emitSite(metaRoot, outDir, flags);`. (The `projectRoot` variable stays — it is still used by the markdown path; only its threading into the site is removed. If `projectRoot` becomes unused elsewhere, leave it; the markdown path uses it.)

- [ ] **Step 8: Help line.** In `cli/src/index.ts` `docs` help FLAGS block (after the `--site` line), add:

```
  --scaffold-site      copy the site's templates + assets into codegen/docs-site/ to own (theme) them
```

- [ ] **Step 9: Build docs-site + run the tests.** From the repo root: `bun run --cwd server/typescript/packages/docs-site build` (so the CLI's dist typecheck sees the exports). Then `cd server/typescript/packages/cli && bun test test/docs-command.test.ts`. Expected: PASS (scaffold + both auto-detect tests). Then `bun run typecheck` (clean).

- [ ] **Step 10: Hygiene + commit.**

```bash
grep -rniE "/home/" src/commands/docs.ts src/index.ts test/docs-command.test.ts && echo LEAK || echo clean
git add src/commands/docs.ts src/index.ts test/docs-command.test.ts
git commit -m "feat(cli): meta docs --scaffold-site + auto-detect owned templates/assets on --site"
```

---

## Task 4: Docs + real-CLI scaffold-and-own validation

**Files:**
- Modify: `server/typescript/packages/docs-site/README.md`
- Validation only (no code): the `meta` CLI end-to-end.

**Interfaces:**
- Consumes: the Task 1–3 surface.

- [ ] **Step 1: Document the flow.** In `server/typescript/packages/docs-site/README.md`, add a section (create the README section if the file lacks one; keep it generic — no private names):

```markdown
## Own your docs-site theme

The site ships with bundled templates + assets. To customize them, scaffold owned
copies into your repo:

```
meta docs --scaffold-site
```

This writes the 9 mustache templates to `codegen/docs-site/templates/` and the CSS/JS
to `codegen/docs-site/assets/` (only files that don't already exist — your edits are
never clobbered). Edit them, then regenerate:

```
meta docs --site
```

`meta docs --site` auto-detects `codegen/docs-site/` and uses your owned copies; any
file you didn't override falls back to the bundled default. The engine
(`@metaobjectsdev/docs-site`) stays a versioned dependency.
```

- [ ] **Step 2: Real-CLI end-to-end validation (scaffold → edit template + asset → owned wins).** From the worktree root, run:

```bash
cd server/typescript/packages/cli
FIX=$PWD/../docs-site/test/fixture/input/acme
PROJ=$(mktemp -d); mkdir -p "$PROJ/metaobjects"; cp -R "$FIX"/. "$PROJ/metaobjects/"
# scaffold
bun run bin/meta.ts docs --scaffold-site "$PROJ"
ls "$PROJ/codegen/docs-site/templates" | wc -l   # expect 9
ls "$PROJ/codegen/docs-site/assets"              # expect site.css site.js
# edit an owned template + asset with unique markers
printf '\n<!-- E2E-OWNED-TEMPLATE -->' >> "$PROJ/codegen/docs-site/templates/index.html.mustache"
printf '/* E2E-OWNED-ASSET */' > "$PROJ/codegen/docs-site/assets/site.css"
# generate; owned copies must win
OUT=$(mktemp -d); bun run bin/meta.ts docs --site "$PROJ" --out "$OUT"
grep -q "E2E-OWNED-TEMPLATE" "$OUT/site/index.html" && echo "TEMPLATE-OK" || echo "TEMPLATE-FAIL"
grep -q "E2E-OWNED-ASSET" "$OUT/site/assets/site.css" && echo "ASSET-OK" || echo "ASSET-FAIL"
# re-run is byte-identical (determinism) + link-check green (rc 0)
OUT2=$(mktemp -d); bun run bin/meta.ts docs --site "$PROJ" --out "$OUT2"; echo "rc=$?"
diff -r "$OUT/site" "$OUT2/site" && echo "DETERMINISTIC" || echo "NONDETERMINISTIC"
```
Expected: `9`, `site.css site.js`, `TEMPLATE-OK`, `ASSET-OK`, `rc=0`, `DETERMINISTIC`. If `scaffold-site` re-run: run `bun run bin/meta.ts docs --scaffold-site "$PROJ"` again and confirm the summary reports 11 preserved / 0 created (idempotent, no clobber).

- [ ] **Step 3: Scale smoke against a substantial in-repo model.** Find a rich in-repo conformance model and generate against it:

```bash
cd <worktree>/server/typescript/packages/cli   # <worktree> = the feat/docs-site checkout root
# pick a rich conformance model (has multiple entities + relationships)
MODEL=../../../fixtures/conformance/flattened-kitchen-sink/input
PROJ2=$(mktemp -d); mkdir -p "$PROJ2/metaobjects"; cp -R "$MODEL"/. "$PROJ2/metaobjects/"
OUT3=$(mktemp -d); bun run bin/meta.ts docs --site "$PROJ2" --out "$OUT3"; echo "rc=$?"
ls "$OUT3/site" && find "$OUT3/site" -name "*.html" | wc -l
```
Expected: `rc=0` (link-check green — no dangling links), an `index.html` + per-object pages written. If the model does not load through `<root>/metaobjects/` (multi-dir layout), record it as the multi-module gap the spec flags — do NOT expand scope; note it for a follow-up.

- [ ] **Step 4: Hygiene + commit the docs.**

```bash
cd <worktree>   # the feat/docs-site checkout root
grep -rniE "/home/" server/typescript/packages/docs-site/README.md && echo LEAK || echo clean
git add server/typescript/packages/docs-site/README.md
git commit -m "docs(docs-site): document the scaffold-and-own theme workflow (--scaffold-site)"
```

---

## Self-Review

**Spec coverage:** A1 assetsDir → Task 1; A2 exports → Task 2; A3 --scaffold-site → Task 3 (steps 3–6); A4 auto-detect → Task 3 (step 7); A5 docs → Task 4 (step 1); validation (scaffold→edit→owned-wins + scale smoke) → Task 4 (steps 2–3). ADR-0034 write-only-if-absent → Task 3 step 6 (`existsSync` guard) + Task 1's byte-identical golden proves bundled default unchanged. Rollout sub-projects B/D/E/F are out of this plan by design.

**Placeholder scan:** none — every code step shows the exact code; the validation steps show exact commands + expected output. The scale-smoke model path (`flattened-kitchen-sink`) is concrete; if it turns out multi-dir, that is a recorded observation, not a placeholder.

**Type consistency:** `assetsDir?: string | undefined` (Task 1) is consumed by `emitSite` (Task 3 step 7); `SITE_TEMPLATE_NAMES`/`SITE_ASSET_NAMES`/`readSiteFile` defined in Task 2 are imported in Task 3 step 3 and used in step 6; `scaffoldSite: boolean` on `DocsFlags` (Task 3 step 4) is read in step 5; `emitSite(metaRoot, outDir, flags)` signature (step 7) matches both updated call sites.
