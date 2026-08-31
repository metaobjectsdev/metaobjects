// Split-dependency-tree regression gate — a generated file must import each module ONCE
// even when the CLI's resolution tree and the consumer project's node_modules hold two
// DIFFERENT physical copies of ts-poet.
//
// THE BUG THIS PINS (first-touch blocker, reproduced on published 0.21.5): with a
// globally-installed / linked `meta` CLI and a project-local ts-poet (which `meta init`
// itself adds to devDependencies), `meta gen` emitted `import { eq } from "drizzle-orm";`
// THREE times into <Entity>.queries.ts — TS2300 on the adopter's first `npx tsc`.
//
// MECHANISM: the scaffolded (ADR-0034 owned) generators compose ts-poet `Code` objects
// across a package boundary — `render*Fn` from @metaobjectsdev/codegen-ts build sections
// with the CLI-side ts-poet, while the scaffold's own `joinCode` came from a bare
// `import { joinCode } from "ts-poet"` that resolves from the PROJECT tree. Two physical
// ts-poet copies → two module instances → ts-poet's `instanceof Code` checks fail
// cross-instance → each section is stringified standalone WITH ITS OWN import header →
// duplicate imports mid-file. A flat single-tree npm install dedupes ts-poet and hides
// the bug, which is why the in-process render gate in
// codegen-ts/test/queries-single-import.test.ts could not reproduce it.
//
// THE FIX (two halves, one lane each below):
//   1. templates — the reference generators import `code`/`joinCode` from
//      @metaobjectsdev/codegen-ts (re-exported from ITS ts-poet instance), so every
//      cross-boundary Code shares one class identity by construction.
//   2. loader — loadMetaobjectsConfig aliases bare "ts-poet" to the copy adjacent to
//      the resolved @metaobjectsdev/codegen-ts (completing the existing alias map),
//      repairing EXISTING scaffolded projects — whose owned generators still say
//      `from "ts-poet"` — without re-scaffolding.
//
// HARNESS: the gate must run the CLI the way an adopter does — `node <cli-bin> gen` —
// because an in-process bun:test import produces a different module topology (Bun's
// native loader takes over from jiti and resolves differently) and cannot reproduce
// the failure faithfully. It therefore needs the built dist; a stale or missing dist
// is rebuilt in place, and if that does not converge the gate FAILS LOUDLY (never
// silently skips).
import { describe, test, expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { readReferenceTemplate, REFERENCE_GENERATOR_NAMES } from "@metaobjectsdev/codegen-ts";
import { META_BIN, ensureFreshDist } from "./integration/support/built-cli.js";

// `META_BIN` + the stale-dist check come from the shared harness: which dists a
// `node dist/bin/meta.js` run depends on is the part that rots, and it must not be
// stated twice. This gate keeps its REBUILD-in-place behaviour (see ensureFreshDist's
// doc) rather than the throwing variant its sibling uses.
// Inside the workspace so the CLI's jiti can resolve @metaobjectsdev/* while the temp
// project still holds its OWN nearest-wins node_modules (the planted ts-poet).
const WORKSPACE_TMP = resolve(import.meta.dirname, "fixtures", "__tmp__");

const META = JSON.stringify({
  "metadata.root": {
    package: "acme::blog",
    children: [
      { "object.entity": { name: "Author", children: [
        { "source.rdb": { "@table": "authors" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "name", "@required": true, "@maxLength": 200, "@filterable": true } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ] } },
    ],
  },
});

// The scaffolded config shape (`meta init`): owned local generators, `.js`-extensioned
// relative imports, sqlite.
//
// namesFile() is included for CONFIG coverage, but it does not add a second probe of the
// legacy-rewrite arm: names.ts imports no ts-poet combinators (renderNamesDecl is a plain
// string template), so the `legacyBareTsPoetImports` regex above never matches it and the
// legacy and current copies of names.ts are identical bytes. Only the CURRENT-scaffold arm
// gains real coverage from it.
const CONFIG = [
  `import { defineConfig } from "@metaobjectsdev/codegen-ts";`,
  `import { entityFile } from "./codegen/generators/entity.js";`,
  `import { queriesFile } from "./codegen/generators/queries.js";`,
  `import { routesFile } from "./codegen/generators/routes.js";`,
  `import { barrel } from "./codegen/generators/barrel.js";`,
  `import { namesFile } from "./codegen/generators/names.js";`,
  `export default defineConfig({`,
  `  outDir: "src/generated",`,
  `  extStyle: "js",`,
  `  dbImport: "../db",`,
  `  dialect: "sqlite",`,
  `  generators: [entityFile(), queriesFile(), routesFile(), namesFile(), barrel()],`,
  `});`,
].join("\n");

/** The ts-poet copy that @metaobjectsdev/codegen-ts itself loads, plus its runtime
 *  dependency closure (dprint-node — required eagerly by ts-poet's Code.js — and
 *  dprint-node's detect-libc), so the planted copy is loadable in isolation. */
function tsPoetCopySources(): Array<{ pkg: string; dir: string }> {
  const req = createRequire(import.meta.url);
  const codegenTsPkg = req.resolve("@metaobjectsdev/codegen-ts/package.json");
  const tsPoetPkg = createRequire(codegenTsPkg).resolve("ts-poet/package.json");
  const dprintPkg = createRequire(tsPoetPkg).resolve("dprint-node/package.json");
  const detectLibcPkg = createRequire(dprintPkg).resolve("detect-libc/package.json");
  return [
    { pkg: "ts-poet", dir: dirname(tsPoetPkg) },
    { pkg: "dprint-node", dir: dirname(dprintPkg) },
    { pkg: "detect-libc", dir: dirname(detectLibcPkg) },
  ];
}

/**
 * Build the consumer-shaped project: scaffold-content generators + config + metadata,
 * plus a SECOND physical ts-poet copy in the project's own node_modules — the layout a
 * globally-installed (or linked) CLI produces, where the project tree and the CLI tree
 * each hold their own ts-poet.
 */
function scaffoldProject(dir: string, opts: { legacyBareTsPoetImports: boolean }): void {
  mkdirSync(join(dir, "metaobjects"), { recursive: true });
  writeFileSync(join(dir, "metaobjects", "meta.blog.json"), META);
  mkdirSync(join(dir, "codegen", "generators"), { recursive: true });
  for (const name of REFERENCE_GENERATOR_NAMES) {
    let src = readReferenceTemplate(name);
    if (opts.legacyBareTsPoetImports) {
      // Recreate the pre-fix scaffold shape still present in EXISTING adopter repos:
      // ts-poet combinators imported bare instead of via @metaobjectsdev/codegen-ts.
      // Only the loader's ts-poet alias protects this lane.
      src = src.replace(
        /^import \{ ((?:code, )?joinCode, type Code) \} from "@metaobjectsdev\/codegen-ts";$/m,
        `import { $1 } from "ts-poet";`,
      );
    }
    writeFileSync(join(dir, "codegen", "generators", `${name}.ts`), src);
  }
  writeFileSync(join(dir, "metaobjects.config.ts"), CONFIG);
  for (const { pkg, dir: srcDir } of tsPoetCopySources()) {
    cpSync(srcDir, join(dir, "node_modules", pkg), { recursive: true, dereference: true });
  }
}

/** Import statements that appear more than once VERBATIM in a file. Cross-instance
 *  per-section rendering duplicates the exact same import line (the TS2300 class);
 *  two DIFFERENT `import type { A } … / import type { B } …` from one module are
 *  legal TS and a shipped cosmetic quirk of the entity file, so they don't count. */
function duplicateImportLines(content: string): string[] {
  const lines = [...content.matchAll(/^import\s+(?:type\s+)?[^;]*?from\s+"[^"]+";/gm)]
    .map((m) => m[0]);
  return [...new Set(lines.filter((l, i) => lines.indexOf(l) !== i))];
}

describe("meta gen with a split ts-poet dependency tree (global/linked CLI layout)", () => {
  for (const legacy of [false, true] as const) {
    const lane = legacy
      ? "legacy scaffold (bare ts-poet imports) — pinned by the loader's ts-poet alias"
      : "current scaffold — pinned by templates importing via @metaobjectsdev/codegen-ts";
    test(`emits each import once: ${lane}`, async () => {
      ensureFreshDist();
      mkdirSync(WORKSPACE_TMP, { recursive: true });
      const dir = mkdtempSync(join(WORKSPACE_TMP, "mo-split-tree-"));
      try {
        scaffoldProject(dir, { legacyBareTsPoetImports: legacy });
        // The adopter path: the published CLI runs under node (`#!/usr/bin/env node`).
        const proc = Bun.spawn(["node", META_BIN, "gen"], {
          cwd: dir,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [out, err, exit] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect({ exit, out, err }).toMatchObject({ exit: 0 });

        const genDir = join(dir, "src", "generated");
        const queries = readFileSync(join(genDir, "Author.queries.ts"), "utf8");
        // The load-bearing pin: the exact first-touch symptom was THREE of these.
        expect(queries.match(/^import \{ eq \} from "drizzle-orm";$/gm) ?? []).toHaveLength(1);
        // The general invariant, across every emitted file.
        for (const name of readdirSync(genDir).filter((n) => n.endsWith(".ts"))) {
          const content = readFileSync(join(genDir, name), "utf8");
          expect({ file: name, dupes: duplicateImportLines(content) }).toEqual({ file: name, dupes: [] });
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 120_000);
  }
});
