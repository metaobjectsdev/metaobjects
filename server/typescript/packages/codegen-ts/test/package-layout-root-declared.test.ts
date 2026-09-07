// `outputLayout: "package"` must fold by the package the author DECLARED, whether
// they declared it once at the file root or on each object.
//
// A file may say `{"metadata.root": {"package": "acme::blog", …}}` or put `package`
// on every object. The loader treats these as equivalent — `resolutionKey()` folds
// the file default, so both resolve to `acme::blog::Widget`. They were NOT
// equivalent to codegen: every path decision read `obj.package`, which is the OWN
// declared package and is `undefined` for the root-level form, so
// `packageToPath(undefined)` returned "" and every file landed flat. Measured
// before the fix: with `outputLayout: "package"` the emitted tree was
// BYTE-IDENTICAL to `flat`. Not a broken build — a config key that reads as
// honoured and does nothing.
//
// It mattered because root-level is the form the product TEACHES:
// `docs/ports/typescript.md`'s quickstart uses it, and across this repo's own
// metadata it is 614 files against 7 using object-level.
//
// It survived because the ONE fixture behind the package-layout golden
// (`fixtures/packaged-shape.json`) is one of those 7. The gate for package layout
// was written on the rare form, so the common form had never been generated in
// package layout by any test.
//
// This gate therefore asserts on EMITTED PATHS rather than on which accessor a
// call site uses. A new generator that reaches for `.package` again fails here
// without anyone having to remember to add it to a list.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";

import { runGen, defineConfig } from "../src/index.js";
import { entityFile } from "../src/generators/entity-file.js";
import { queriesFile } from "../src/generators/queries-file.js";
import { routesFile } from "../src/generators/routes-file.js";
import { namesFile } from "../src/generators/index.js";

const PKG = "acme::commerce";
const PKG_DIR = "acme/commerce";

const ENTITY = {
  "object.entity": {
    name: "Widget",
    children: [
      { "source.rdb": { "@table": "widgets" } },
      { "field.long": { name: "id" } },
      { "field.string": { name: "label", "@required": true, "@maxLength": 50 } },
      { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
    ],
  },
};

/** The same model, declaring its package at the file ROOT. */
const ROOT_DECLARED = { "metadata.root": { package: PKG, children: [ENTITY] } };

/** The same model, declaring its package on the OBJECT. */
const OBJECT_DECLARED = {
  "metadata.root": {
    children: [{ "object.entity": { ...ENTITY["object.entity"], package: PKG } }],
  },
};

async function emit(model: unknown, outputLayout: "flat" | "package"): Promise<string[]> {
  const { root, errors } = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(model), { id: "meta.json" }),
  ]);
  expect(errors.map((e) => e.message)).toEqual([]);

  const dir = mkdtempSync(join(import.meta.dir, "tmp-pkg-layout-"));
  try {
    await runGen({
      config: defineConfig({
        outDir: dir,
        extStyle: "none",
        dbImport: "~/db",
        dialect: "sqlite",
        outputLayout,
        generators: [entityFile(), queriesFile(), routesFile(), namesFile()],
      }),
      metadata: root,
    });
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const f = join(d, n);
        if (statSync(f).isDirectory()) walk(f);
        else out.push(relative(dir, f).split("\\").join("/"));
      }
    };
    walk(dir);
    return out.sort();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("outputLayout: package folds by the DECLARED package, however it was declared", () => {
  test("a root-declared package folds — it used to emit flat", async () => {
    const files = await emit(ROOT_DECLARED, "package");
    expect(files.length).toBeGreaterThan(0);
    const unfolded = files.filter((f) => !f.startsWith(`${PKG_DIR}/`));
    expect(unfolded).toEqual([]);
  });

  test("root-declared and object-declared emit the SAME tree", async () => {
    // The two authoring forms are equivalent to the loader; nothing downstream
    // may make them differ. Stated as an equality rather than two separate
    // expectations so a future change that breaks only one of them is named.
    expect(await emit(ROOT_DECLARED, "package")).toEqual(
      await emit(OBJECT_DECLARED, "package"),
    );
  });

  test("package layout is not byte-identical to flat — the setting does something", async () => {
    // The exact symptom, pinned: before the fix these two were the same list, so
    // any assertion that only checked "package layout emits files" passed.
    const asPackage = await emit(ROOT_DECLARED, "package");
    const asFlat = await emit(ROOT_DECLARED, "flat");
    expect(asPackage).not.toEqual(asFlat);
    expect(asFlat.every((f) => !f.includes("/"))).toBe(true);
  });
});
