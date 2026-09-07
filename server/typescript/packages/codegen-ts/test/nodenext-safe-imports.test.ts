// Launch-blocker B3: generated relative imports must be nodenext-safe.
//
// A newcomer who runs the standard `npm init` + `tsc --init` gets a stock
// `module: nodenext` tsconfig, under which un-extensioned relative imports
// (`from "./Author"`, `from "../db"`) fail with TS2835 — ~60 errors OOTB on the
// generated code. The repo's own `tsconfig.base.json` uses `moduleResolution:
// "bundler"`, which MASKS this. The fix: emit `.js`-extensioned relative imports
// by default. `.js` specifiers resolve correctly under BOTH bundler and nodenext,
// so this is strictly more compatible.
//
// This gate compiles the REAL generated output under a stock nodenext program and
// asserts zero TS2835 (missing-extension) diagnostics — the guarantee holds by
// construction, not by string-match. Unrelated diagnostics (e.g. TS2307 for the
// unresolved `../db` stub or an uninstalled optional `fastify` peer) are ignored;
// only the extension errors this fix targets are asserted.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { runGen, defineConfig } from "../src/index.js";
import { namesFile } from "../src/generators/index.js";
import { barrel } from "../src/generators/barrel.js";
import { entityFile } from "../src/generators/entity-file.js";
import { queriesFile } from "../src/generators/queries-file.js";
import { routesFile } from "../src/generators/routes-file.js";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";

const META = JSON.stringify({
  "metadata.root": {
    package: "acme::blog",
    children: [
      {
        "object.entity": {
          name: "Author",
          children: [
            { "source.rdb": { "@table": "authors" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "name", "@required": true, "@maxLength": 200 } },
            { "field.string": { name: "bio", "@maxLength": 2000 } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } },
          ],
        },
      },
    ],
  },
});

async function loadRoot() {
  const r = await new MetaDataLoader().load([new InMemoryStringSource(META)]);
  if (r.errors.length > 0) throw new Error(r.errors.map((e) => e.message).join("\n"));
  return r.root;
}

// "js" is the value `meta init` scaffolds into metaobjects.config.ts (the shipped
// default). "none" is the opt-out, exercised to prove the compile gate has teeth.
async function genTo(dir: string, extStyle: "js" | "none" = "js"): Promise<void> {
  const root = await loadRoot();
  await runGen({
    config: defineConfig({
      outDir: dir,
      dbImport: "../db",
      dialect: "sqlite",
      extStyle,
      // The list must stay equal to `meta init`'s SCAFFOLDED_GENERATOR_NAMES — this gate's
      // whole claim is about the output a stock scaffold produces, so a generator that
      // init writes but this list omits is emitting relative imports nothing checks.
      // `names` was added to the scaffold set and was outside this gate until now; the
      // names-consumption compile gate cannot substitute, because it runs under
      // `moduleResolution: Bundler`, which accepts extensionless specifiers and so is
      // structurally incapable of reporting TS2835.
      generators: [entityFile(), queriesFile(), routesFile(), barrel(), namesFile()],
    }),
    metadata: root,
  });
}

/** TS2835 = "Relative import paths need explicit file extensions … 'nodenext'". */
function extensionErrorsUnderNodeNext(dir: string): string[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f));
  const program = ts.createProgram(files, {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.code === 2835)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("generated relative imports are nodenext-safe", () => {
  test("scaffolded `js` output emits extensioned relative imports — zero TS2835 under nodenext", async () => {
    const dir = mkdtempSync(join(import.meta.dir, "tmp-nodenext-"));
    try {
      await genTo(dir, "js");
      expect(extensionErrorsUnderNodeNext(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("gate has teeth: explicit extStyle 'none' still reports TS2835 under nodenext", async () => {
    const dir = mkdtempSync(join(import.meta.dir, "tmp-nodenext-none-"));
    try {
      await genTo(dir, "none");
      expect(extensionErrorsUnderNodeNext(dir).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a relative dbImport is extensioned under `js` — routes import `../db.js`", async () => {
    const dir = mkdtempSync(join(import.meta.dir, "tmp-dbimport-"));
    try {
      await genTo(dir, "js");
      const routes = readFileSync(join(dir, "Author.routes.ts"), "utf8");
      expect(routes).toContain('from "../db.js"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
