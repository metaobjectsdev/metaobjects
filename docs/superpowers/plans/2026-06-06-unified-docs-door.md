# Unified docs door Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `meta docs` the single door that emits BOTH the model surface (neutral metadata docs) and the api surface (SDK reference) from one `docs:` config, cross-linked, in one output tree — TS first, with the schema/contract designed for the eventual 5-port fan-out.

**Architecture:** Keep the two existing engines (`docsFile()` = model, `apiDocsFile()` = api) but unify the user-facing layer: one `docs:` config block, one command invoking both engines into one `outDir` (`<outDir>/<Entity>.md` model + `<outDir>/api/<Entity>.md` api), with cross-links computed via the shared `docs-paths` helpers. `apiDocsFile()` is demoted from a `meta gen` generator to the api-surface engine (deprecated like `docsFile()` already is).

**Tech Stack:** TypeScript, bun test, MetaObjects codegen-ts + cli packages, Mustache doc templates.

Reference (read once): the design spec `docs/superpowers/specs/2026-06-06-unified-docs-door-design.md`; `packages/cli/src/commands/docs.ts`; `packages/codegen-ts/src/metaobjects-config.ts`; `packages/codegen-ts/src/generators/{docs-file,api-docs-file,index}.ts`; `packages/codegen-ts/src/docs-paths.ts`; `packages/codegen-ts/src/runner.ts`; `packages/cli/src/commands/init.ts`; `templates/docs/*` + `templates/api/*` + `scripts/sync-doc-templates.sh`; the gate pattern in `packages/codegen-ts/test/golden/template-source-conformance.test.ts`.

All commands run from `server/typescript` unless noted. Run `bun install` first if `node_modules` is missing.

---

## Task 1: The `docs:` config type + resolver

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/metaobjects-config.ts` (add `DocsConfig` + `docs?` field + `resolveDocsConfig`)
- Test: `server/typescript/packages/codegen-ts/test/docs-config.test.ts` (create)

- [ ] **Step 1: Write the failing test.**

```ts
// test/docs-config.test.ts
import { test, expect } from "bun:test";
import { resolveDocsConfig } from "../src/metaobjects-config.js";

test("defaults when no docs block and no overrides", () => {
  const r = resolveDocsConfig(undefined, {}, "package");
  expect(r).toEqual({ outDir: "./docs", layout: "package", baseUrl: "", surfaces: ["model", "api"] });
});

test("docs block supplies values; fallbackLayout ignored when layout set", () => {
  const r = resolveDocsConfig({ outDir: "./site", layout: "flat", baseUrl: "/d", surfaces: ["model"] }, {}, "package");
  expect(r).toEqual({ outDir: "./site", layout: "flat", baseUrl: "/d", surfaces: ["model"] });
});

test("CLI overrides beat the docs block", () => {
  const r = resolveDocsConfig({ outDir: "./site", layout: "flat" }, { outDir: "./out", layout: "package", surfaces: ["api"], baseUrl: "x" }, "flat");
  expect(r).toEqual({ outDir: "./out", layout: "package", baseUrl: "x", surfaces: ["api"] });
});

test("layout falls back to fallbackLayout when neither block nor override sets it", () => {
  expect(resolveDocsConfig({ outDir: "./d" }, {}, "package").layout).toBe("package");
});
```

- [ ] **Step 2: Run → FAIL.** `bun test packages/codegen-ts/test/docs-config.test.ts` → fails (`resolveDocsConfig` not exported).

- [ ] **Step 3: Implement.** In `metaobjects-config.ts`, add near the other interfaces (after `ResolvedGenConfig`):

```ts
export type DocsSurface = "model" | "api";

/** The single docs-output config: where ALL doc surfaces go, how pages are laid
 *  out, and which surfaces to emit. Read by the `meta docs` door (and, when the
 *  api surface fans out, by each port's docs command). */
export interface DocsConfig {
  outDir?: string;
  layout?: OutputLayout;
  baseUrl?: string;
  surfaces?: DocsSurface[];
}

export interface ResolvedDocsConfig {
  outDir: string;
  layout: OutputLayout;
  baseUrl: string;
  surfaces: DocsSurface[];
}

/** Merge the config `docs:` block with CLI overrides over documented defaults.
 *  `fallbackLayout` is the project's `outputLayout` (so docs default to the same
 *  page placement as codegen when `docs.layout` is unset). */
export function resolveDocsConfig(
  block: DocsConfig | undefined,
  cli: Partial<ResolvedDocsConfig>,
  fallbackLayout: OutputLayout,
): ResolvedDocsConfig {
  return {
    outDir: cli.outDir ?? block?.outDir ?? "./docs",
    layout: cli.layout ?? block?.layout ?? fallbackLayout,
    baseUrl: cli.baseUrl ?? block?.baseUrl ?? "",
    surfaces: cli.surfaces ?? block?.surfaces ?? ["model", "api"],
  };
}
```

Add `docs?: DocsConfig;` to the `MetaobjectsGenConfig` interface (alongside `apiPrefix?`, `emitAbstractShapes?`).

- [ ] **Step 4: Run → PASS.** `bun test packages/codegen-ts/test/docs-config.test.ts`.

- [ ] **Step 5: Commit.** `git add packages/codegen-ts/src/metaobjects-config.ts packages/codegen-ts/test/docs-config.test.ts && git commit -m "feat(codegen-ts): docs: config block + resolveDocsConfig" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

## Task 2: api-docs `subDir` option (emit under the docs root, not `docs/api`)

**Why:** `apiDocsFile()` hardcodes `API_DIR = "docs/api"`. Under the unified `meta docs` command the outDir IS the docs root (`./docs`), so the api surface must emit `api/<Entity>.md` (not `docs/api/...`, which would double to `./docs/docs/api`). Make the prefix an option; default stays `docs/api` so existing `meta gen`/test behavior is byte-identical.

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/generators/api-docs-file.ts`
- Test: `server/typescript/packages/codegen-ts/test/api-docs-subdir.test.ts` (create)

- [ ] **Step 1: Write the failing test.** (Builds a tiny in-memory root the same way `template-source-conformance.test.ts` builds its ctx — copy that fixture-loading + `makeCtx` helper pattern; if simpler, load `fixtures/conformance/template-source-conformance/input`.)

```ts
// test/api-docs-subdir.test.ts
import { test, expect } from "bun:test";
import { apiDocsFile } from "../src/generators/api-docs-file.js";
// reuse the loadFixture + makeCtx helpers from template-source-conformance.test.ts
import { loadFixtureRoot, makeDocsCtx } from "./golden/_docs-test-helpers.js"; // extract if not present

test("default subDir keeps docs/api (byte-identical)", async () => {
  const ctx = await makeDocsCtx("template-source-conformance", "flat");
  const files = await apiDocsFile().generate(ctx);
  expect(files.some((f) => f.path.startsWith("docs/api/"))).toBe(true);
  expect(files.some((f) => f.path === "docs/api/README.md")).toBe(true);
});

test("subDir:'api' emits under api/ (for the unified docs root)", async () => {
  const ctx = await makeDocsCtx("template-source-conformance", "flat");
  const files = await apiDocsFile({ subDir: "api" }).generate(ctx);
  expect(files.every((f) => f.path.startsWith("api/"))).toBe(true);
  expect(files.some((f) => f.path === "api/README.md")).toBe(true);
  expect(files.some((f) => f.path.startsWith("docs/api/"))).toBe(false);
});
```

> If `_docs-test-helpers.ts` doesn't exist, FIRST extract `loadFixture`/`makeCtx` from `test/golden/template-source-conformance.test.ts` into `test/golden/_docs-test-helpers.ts` and re-import them there (pure refactor, keep that test green). `makeDocsCtx(fixture, layout)` returns the GenContext with `config.outputLayout = layout`.

- [ ] **Step 2: Run → FAIL.** `bun test packages/codegen-ts/test/api-docs-subdir.test.ts` (subDir option not supported; second test fails).

- [ ] **Step 3: Implement.** In `api-docs-file.ts`:
  - Add to opts: `export interface ApiDocsFileOpts { filter?: (entity: MetaObject) => boolean; target?: string; subDir?: string; }`
  - Replace the three module-level constants with per-call locals derived from `subDir`:

```ts
// inside apiDocsFile(opts), at the top of generate(ctx):
const apiDir = opts?.subDir ?? "docs/api";
const indexFilename = `${apiDir}/README.md`;
const agentFilename = `${apiDir}/AGENT-API.md`;
```

  Replace `API_DIR`/`INDEX_FILENAME`/`AGENT_FILENAME` usages in `generate` with `apiDir`/`indexFilename`/`agentFilename`. Delete the now-unused module constants (or keep `const DEFAULT_API_DIR = "docs/api"` and reference it).

- [ ] **Step 4: Run → PASS.** `bun test packages/codegen-ts/test/api-docs-subdir.test.ts`, then `bun test packages/codegen-ts` — confirm 0 fail and the existing api-docs goldens are unchanged (default path byte-identical).

- [ ] **Step 5: Commit.** `git add -A packages/codegen-ts && git commit -m "feat(codegen-ts): apiDocsFile() subDir option (default docs/api unchanged)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

## Task 3: Unified `meta docs` command — emit both surfaces

**Files:**
- Modify: `server/typescript/packages/cli/src/commands/docs.ts`
- Test: `server/typescript/packages/cli/test/unit/docs-command-surfaces.test.ts` (create)

- [ ] **Step 1: Write the failing test.** Drives the real `docsCommand` against a temp project. Build a temp dir with `metaobjects/` (copy a known-good fixture, e.g. `fixtures/conformance/template-source-conformance/input` → `<tmp>/metaobjects`-shaped; reuse the loader expectations) — model the setup on existing docs-command tests if any (`grep -rl "docsCommand" packages/cli/test`). Assertions:

```ts
// both surfaces when a metaobjects.config.ts is present
test("emits model + api pages under one outDir when config present", async () => {
  // ... run docsCommand(["--out", outDir], tmpWithConfig)
  expect(existsSync(join(outDir, "Order.md"))).toBe(true);        // model
  expect(existsSync(join(outDir, "api", "Order.md"))).toBe(true); // api
  expect(existsSync(join(outDir, "README.md"))).toBe(true);
});

test("--model emits only the model surface", async () => {
  // run docsCommand(["--out", outDir, "--model"], tmpWithConfig)
  expect(existsSync(join(outDir, "Order.md"))).toBe(true);
  expect(existsSync(join(outDir, "api", "Order.md"))).toBe(false);
});

test("no config -> model only + skip note (exit 0)", async () => {
  // run docsCommand(["--out", outDir], tmpNoConfig)
  expect(existsSync(join(outDir, "Order.md"))).toBe(true);
  expect(existsSync(join(outDir, "api"))).toBe(false);
});
```

- [ ] **Step 2: Run → FAIL.** `bun test packages/cli/test/unit/docs-command-surfaces.test.ts` (api pages not emitted; flags unknown).

- [ ] **Step 3: Implement — flags.** In `docs.ts` `parseDocsArgs`, extend `DocsFlags` with `surfaces?: DocsSurface[]` and `baseUrl?: string`; parse `--model` → `surfaces=["model"]`, `--api` → `surfaces=["api"]`, `--base-url <v>`/`--base-url=`. (Keep `--out`/`--layout`/`--templates` as-is.) `--model --api` together = both (set `["model","api"]`).

- [ ] **Step 4: Implement — load full config + resolve docs config.** Where it currently extracts only `configProviders`, also capture the full loaded config so the api surface can gate on it. Confirm `loadMetaobjectsConfig` returns the resolved config object (it exposes `.providers`); read `.docs` (the `docs:` block) and `.includeHonoRoutes` from it. Then:

```ts
import { resolveDocsConfig, type ResolvedDocsConfig } from "@metaobjectsdev/codegen-ts"; // or its export path
const hasConfig = existsSync(join(metaRoot, "metaobjects.config.ts"));
const docsCfg: ResolvedDocsConfig = resolveDocsConfig(
  loadedConfig?.docs,
  {
    ...(flags.out !== "./docs" ? { outDir: flags.out } : {}), // CLI --out overrides
    layout: flags.layout,                                     // --layout always set (defaults flat)
    ...(flags.surfaces ? { surfaces: flags.surfaces } : {}),
    ...(flags.baseUrl !== undefined ? { baseUrl: flags.baseUrl } : {}),
  },
  flags.layout, // fallbackLayout: docs default to the CLI/flat layout
);
const outDir = resolvePath(metaRoot, docsCfg.outDir);
```

(Adjust the `--out` override detection if you prefer an explicit `outProvided` boolean from the parser — cleaner than comparing to `"./docs"`. If so, add `outProvided`/`layoutProvided` booleans in `parseDocsArgs` and use them here.)

- [ ] **Step 5: Implement — emit both surfaces.** Build the GenContext as today but use `docsCfg.layout` for `config.outputLayout` and set `includeHonoRoutes` from the loaded config. Then:

```ts
import { docsFile, apiDocsFile } from "@metaobjectsdev/codegen-ts/generators";
const emit: EmittedFile[] = [];
if (docsCfg.surfaces.includes("model")) {
  emit.push(...await docsFile().generate(ctx));
}
let apiEmitted = false;
if (docsCfg.surfaces.includes("api")) {
  if (hasConfig) {
    emit.push(...await apiDocsFile({ subDir: "api" }).generate(ctx));
    apiEmitted = true;
  } else {
    log.info("meta docs: api surface skipped — no metaobjects.config.ts (nothing generated to document).");
  }
}
```

Write every file in `emit` under `outDir` (existing write loop). Keep the existing model-render error handling around the `docsFile()` call. Update the summary line to report model + api page counts and the outDir.

- [ ] **Step 6: Run → PASS.** `bun test packages/cli/test/unit/docs-command-surfaces.test.ts`, then `bun test packages/cli` → 0 fail.

- [ ] **Step 7: Commit.** `git add -A packages/cli && git commit -m "feat(cli): meta docs emits model + api surfaces from one docs: config" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

## Task 4: Cross-links between surfaces + unified index

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/docs-paths.ts` (`surfaceCrossHref`)
- Modify: `server/typescript/packages/codegen-ts/src/generators/docs-file.ts` (model pages + index get an api link) and `api-docs-file.ts` (api pages get a model link)
- Modify canonical templates: `templates/docs/entity-page.md.mustache`, `templates/docs/template-page.md.mustache`, `templates/api/entity-api.md.mustache`, `templates/docs/` index template; then run `scripts/sync-doc-templates.sh`
- Test: `server/typescript/packages/codegen-ts/test/docs-paths-cross.test.ts` (create) + update affected goldens

- [ ] **Step 1: Write the failing helper test.**

```ts
// test/docs-paths-cross.test.ts
import { test, expect } from "bun:test";
import { surfaceCrossHref } from "../src/docs-paths.js";

test("flat: model->api and api->model", () => {
  expect(surfaceCrossHref("Order.md", "api/Order.md")).toBe("./api/Order.md");
  expect(surfaceCrossHref("api/Order.md", "Order.md")).toBe("../Order.md");
});
test("package: across package dirs + api subroot", () => {
  expect(surfaceCrossHref("acme/sales/Order.md", "api/acme/sales/Order.md")).toBe("../../api/acme/sales/Order.md");
  expect(surfaceCrossHref("api/acme/sales/Order.md", "acme/sales/Order.md")).toBe("../../../acme/sales/Order.md");
});
```

- [ ] **Step 2: Run → FAIL.** `bun test packages/codegen-ts/test/docs-paths-cross.test.ts`.

- [ ] **Step 3: Implement the helper.** In `docs-paths.ts`:

```ts
/** Relative href between two doc pages whose output paths (relative to the
 *  shared docs outDir) may sit under different surface sub-roots — e.g. a model
 *  page `Order.md` and its api page `api/Order.md`. Same relative-path rule
 *  docPageHref uses, but over raw output paths instead of DocPageNodes. */
export function surfaceCrossHref(fromOutputPath: string, toOutputPath: string): string {
  const fromDir = fromOutputPath.includes("/")
    ? fromOutputPath.slice(0, fromOutputPath.lastIndexOf("/"))
    : "";
  let rel = posixRelative(fromDir, toOutputPath);
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}
```

- [ ] **Step 4: Run → PASS.** `bun test packages/codegen-ts/test/docs-paths-cross.test.ts`.

- [ ] **Step 5: Wire the model→api link.** In `docs-file.ts`, the model engine must know (a) whether the api surface is also being emitted and (b) the api subDir, to emit the link. Add an optional opt: `docsFile({ apiSurface?: { subDir: string } })`. When set, for each entity page compute `surfaceCrossHref(docPageOutputPath(layout, node), `${apiSurface.subDir}/${docPageOutputPath(layout, node)}`)` and pass it to `buildEntityDocData` as `apiPageHref`. The docs command (Task 3) passes `apiSurface: { subDir: "api" }` only when it also emits the api surface. Render an "API reference" link in `entity-page.md.mustache` guarded by the field:

```mustache
{{#apiPageHref}}
**API reference:** [generated SDK for {{name}}]({{apiPageHref}})
{{/apiPageHref}}
```

- [ ] **Step 6: Wire the api→model link.** In `api-docs-file.ts`, add opt `apiDocsFile({ subDir, modelSurface?: true })`. When `modelSurface` is set, for each unit compute `surfaceCrossHref(`${apiDir}/${docPageOutputPath(layout, node)}`, docPageOutputPath(layout, node))` and pass to `renderEntityApiPage` as `modelPageHref`; render a "Model / metadata" link in `templates/api/entity-api.md.mustache` guarded by the field. The docs command passes `modelSurface: true` only when it also emits the model surface.

- [ ] **Step 7: Unified top-level index.** In `docs-file.ts` `renderIndexPage`, accept an optional `apiIndexHref` (e.g. `./api/README.md`) and render an "## API reference" section linking it when present; the docs command passes it when the api surface is emitted. (Keep the api surface's own `api/README.md` as the api sub-index.)

- [ ] **Step 8: Sync templates + update goldens.** Run `bash scripts/sync-doc-templates.sh` (copies canonical → package + regenerates the embedded module). Then run `bun test packages/codegen-ts` — the model/api/template page goldens now legitimately gain the cross-link section; update each golden to the new output **in this one commit** (review the diff: it must be ONLY the added cross-link lines, gated by the presence opts so non-cross-linked runs stay byte-identical).

- [ ] **Step 9: Run → PASS.** `bun test packages/codegen-ts` 0 fail; `bun test packages/codegen-ts/test/golden/template-doc-conformance.test.ts` (byte-identity root==package) green.

- [ ] **Step 10: Commit.** `git add -A packages/codegen-ts templates && git commit -m "feat(codegen-ts): cross-links between model and api doc surfaces" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

## Task 5: Cross-link integrity conformance gate

**Files:**
- Test: `server/typescript/packages/codegen-ts/test/golden/docs-cross-link-conformance.test.ts` (create)

- [ ] **Step 1: Write the gate.** Mirror `template-source-conformance.test.ts`. For both `"flat"` and `"package"` layouts: emit BOTH surfaces the way the docs command does — `[...await docsFile({ apiSurface: { subDir: "api" } }).generate(ctx), ...await apiDocsFile({ subDir: "api", modelSurface: true }).generate(ctx)]`. Build a set of emitted page paths. Parse every cross-surface link out of the emitted markdown (the "API reference" link in model pages, the "Model / metadata" link in api pages, and the "API reference" section in the index). For each link, resolve it relative to the emitting page's path and assert the target is in the emitted set. Use the multi-package fixture `fixtures/conformance/template-source-conformance-package` for the package-layout case (it already has cross-package nodes).

```ts
// shape (fill in helpers mirroring the template-source gate):
for (const layout of ["flat", "package"] as const) {
  test(`cross-surface links resolve (${layout})`, async () => {
    const files = await emitBothSurfaces("template-source-conformance-package", layout);
    const present = new Set(files.map((f) => f.path));
    const broken = findBrokenCrossLinks(files, present); // resolve each ../ href against its page dir
    expect(broken).toEqual([]);
  });
}
```

- [ ] **Step 2: Run → it must PASS** (Task 4 made the links correct). If any break, fix the href computation in Task 4 (almost certainly a `surfaceCrossHref` argument-order or subDir-prefix slip), not the test.

- [ ] **Step 3: Add a teeth check.** Temporarily break one link target (rename in a local copy) to confirm the gate fails, then revert — document in the test comment that it has teeth (or add a tiny unit asserting `findBrokenCrossLinks` flags a known-bad input).

- [ ] **Step 4: Commit.** `git add packages/codegen-ts/test/golden/docs-cross-link-conformance.test.ts && git commit -m "test(codegen-ts): cross-surface doc link integrity gate (flat + package)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

## Task 6: Deprecation shim + scaffold swap

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/generators/api-docs-file.ts` (+ `index.ts`) — `@deprecated` note mirroring `docsFile()`
- Modify: `server/typescript/packages/codegen-ts/src/runner.ts` — warn + skip a deprecated doc generator in the `generators` array
- Modify: `server/typescript/packages/cli/src/commands/init.ts` — scaffold swap
- Modify: `server/typescript/packages/cli/test/unit/init-scaffold-config.test.ts`
- Test: `server/typescript/packages/codegen-ts/test/runner-docs-shim.test.ts` (create)

- [ ] **Step 1: Deprecate `apiDocsFile()`.** Add above `export const apiDocsFile` in `api-docs-file.ts` a JSDoc mirroring `docsFile()`'s:

```ts
/**
 * @deprecated ADR-0025: `meta docs` is the single door for ALL docs. `apiDocsFile()`
 * stays as the INTERNAL engine of the docs door's api surface — do NOT add it to a
 * `meta gen` config / the generators array. Use `meta docs` (which emits the api
 * surface alongside the model surface). A `meta gen` config that lists it is warned + skipped.
 */
```

  In `generators/index.ts`, add the matching `@deprecated ADR-0025 …` line above the `apiDocsFile` re-export (mirror the existing `docsFile` line).

- [ ] **Step 2: Write the runner shim test.**

```ts
// test/runner-docs-shim.test.ts — build a config whose generators include apiDocsFile()
// run the runner; assert (a) a warning naming the deprecated generator was collected,
// (b) NO docs/api/* files were emitted by the run.
```

  (Model setup on existing `runner.ts` tests — `grep -rl "runGen\|runner" packages/codegen-ts/test`.)

- [ ] **Step 3: Run → FAIL.**

- [ ] **Step 4: Implement the shim.** In `runner.ts`, before the `generator.generate(ctx)` call, skip deprecated doc generators by their stable `name`:

```ts
const DEPRECATED_DOC_GENERATORS = new Set(["docs-file", "api-docs"]);
if (DEPRECATED_DOC_GENERATORS.has(generator.name)) {
  warnings.push(
    `[${generator.name}] docs are produced by 'meta docs' (ADR-0025); ` +
    `remove ${generator.name === "api-docs" ? "apiDocsFile()" : "docsFile()"} from generators. Skipped.`,
  );
  continue;
}
```

- [ ] **Step 5: Run → PASS.** `bun test packages/codegen-ts/test/runner-docs-shim.test.ts`.

- [ ] **Step 6: Scaffold swap.** In `init.ts` `buildMetaobjectsConfigBody`: remove `apiDocsFile,` from the import and `apiDocsFile(),` from the `generators` array; add a `docs:` block after `generators: [...]`:

```ts
  generators: [
    entityFile(),
    queriesFile(),
    routesFile(),
    barrel(),
  ],
  docs: {
    outDir:   "./docs",        // model + api surfaces both land here (run: meta docs)
    layout:   "flat",          // or "package" for multi-package models
    surfaces: ["model", "api"],
  },
```

- [ ] **Step 7: Update the scaffold guard test.** In `init-scaffold-config.test.ts`: drop the `expect(body).toContain(\`apiDocsFile()\`)` assertion; in the D1 guard test, also assert `expect(body).not.toContain("apiDocsFile")` and `expect(body).toContain("docs:")` and `expect(body).toContain('surfaces:')`. Keep the `not.toContain("docsFile")` + `nextStepsBlock()` `meta docs` assertions.

- [ ] **Step 8: Run → PASS.** `bun test packages/cli packages/codegen-ts` → 0 fail.

- [ ] **Step 9: Commit.** `git add -A packages/codegen-ts packages/cli && git commit -m "feat: demote apiDocsFile() to the docs-door api surface (deprecate for meta gen)" -m "Scaffold now emits a docs: block; meta gen warns+skips a deprecated doc generator." -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

## Task 7: ADR-0025 + agent-context pointer + closeout

**Files:**
- Create: `spec/decisions/ADR-0025-unified-docs-door.md`
- Modify: `spec/decisions/ADR-0021-*.md` + `spec/decisions/ADR-0022-*.md` (add "extended/revised by ADR-0025" pointer lines)
- Modify: `agent-context/skills/metaobjects-codegen/references/typescript.md` + `agent-context/skills/metaobjects-prompts/references/typescript.md`; regenerate `fixtures/agent-context-conformance/ts-*/expected/...`

- [ ] **Step 1: Write ADR-0025.** Capture: docs = one subsystem, one per-port command door, one `docs:` config, N surfaces (`model` Tier-2 shared / `api` Tier-1 per-port) cross-linked in one tree. State it extends ADR-0021 D1 (single door now covers ALL docs) and revises ADR-0022 Part 3 (api-docs = the api surface of the docs door, not a `meta gen` generator). Record the deferred open item: how a non-TS port reaches the shared model engine (embed-binary vs invoke-TS-CLI vs port-native-emitter-over-shared-templates) — to be decided at api-surface fan-out. Add "Extended by ADR-0025" / "Revised by ADR-0025" pointer lines to ADR-0021 and ADR-0022 (do not rewrite them).

- [ ] **Step 2: Update the agent-context TS references.** In `metaobjects-codegen/references/typescript.md`, replace the api-docs-as-`apiDocsFile()`-generator framing with: docs come from the `meta docs` command, which emits the **model** surface (entity + template pages) AND the **api** surface (SDK reference, `docs/api/...`, incl. `AGENT-API.md`) from the one `docs:` config, cross-linked. Drop any "apiDocsFile() generator row". In `metaobjects-prompts/references/typescript.md`, keep the template-page pointer; just confirm the path wording still matches (`docs/<Template>.md`). Use only verified paths/commands — no invented flags.

- [ ] **Step 3: Regenerate agent-context goldens.** Rebuild the affected ts-stack fixtures (the throwaway-bun-script approach used before, or a regen flag if present); confirm only ts-stack `expected/` files change, non-TS unchanged. Rebuild the sdk bundle (`cd packages/sdk && node scripts/bundle-agent-context.mjs`) and run `bun test packages/sdk` → 0 fail.

- [ ] **Step 4: Full suite.** `bun test packages/codegen-ts packages/cli packages/sdk packages/render` → record counts, 0 fail.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "docs(ADR-0025): unified docs door; agent-context points at meta docs surfaces" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

- [ ] **Step 6: Whole-branch review + code-simplifier; fix findings.**

- [ ] **Step 7: Forward-merge to origin/main via a temp worktree off the latest origin/main** (the main checkout holds other sessions' WIP — do not touch it). Resolve any ADR-0025-number collision if a sibling grabbed it (renumber to the next free). Remove worktrees/branches. Update memory.

## Guard
- PUBLIC repo: no private/other-project names, no absolute home paths — code, fixtures, OR commit messages.
- Byte-stability: the model + api page output stays byte-identical EXCEPT the cross-link section, which only appears when the sibling-surface opt is passed (so standalone runs and existing goldens are unchanged until Task 4's deliberate one-commit golden update).
- `apiDocsFile()` default `subDir` stays `docs/api` (existing `meta gen`/goldens unchanged).
- Reuse `docPageHref`/`surfaceCrossHref`/`docPageOutputPath` — do NOT hand-roll relative paths.
- Keep the model engine shared (Tier-2). Do NOT port it per-language. Don't touch other ports, the render `verify()` engine, or the rich-view renderer.
- ADR-0024 is taken (sibling's BYO-LLM); use ADR-0025.
