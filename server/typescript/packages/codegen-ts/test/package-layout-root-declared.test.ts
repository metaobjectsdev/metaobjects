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
//
// PATHS ARE NOT ENOUGH, and that gap shipped a regression. The barrel emits one
// root-level `index.ts` whose CONTENT is import specifiers pointing at the other
// generators' files. Its path is right whatever it exports, so a barrel still
// reading the bare `.package` emitted `export * from "./Widget"` for a file at
// `acme/commerce/Widget.ts` — TS2307 on a project with nothing wrong with it — and
// this gate could not see it, because it never ran the barrel and compared no
// specifiers. It happened: the fix landed in the built-in generator and not in the
// four reference/owned copies, which are the ones `meta init` actually scaffolds.
// `resolvesAgainstEmittedFiles` below closes that by requiring every specifier the
// barrel exports to name a file the run actually wrote.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";

import { runGen, defineConfig } from "../src/index.js";
import { entityFile } from "../src/generators/entity-file.js";
import { queriesFile } from "../src/generators/queries-file.js";
import { routesFile } from "../src/generators/routes-file.js";
import { namesFile } from "../src/generators/index.js";
import { barrel } from "../src/generators/barrel.js";

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

/**
 * Emit WITH the barrel and return every `export * from "<spec>"` specifier in the
 * generated `index.ts`, paired with the set of files the same run wrote.
 */
async function emitWithBarrel(
  model: unknown,
  outputLayout: "flat" | "package",
): Promise<{ specifiers: string[]; files: string[] }> {
  const { root, errors } = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(model), { id: "meta.json" }),
  ]);
  expect(errors.map((e) => e.message)).toEqual([]);

  const dir = mkdtempSync(join(import.meta.dir, "tmp-pkg-barrel-"));
  try {
    await runGen({
      config: defineConfig({
        outDir: dir,
        extStyle: "none",
        dbImport: "~/db",
        dialect: "sqlite",
        outputLayout,
        generators: [entityFile(), queriesFile(), routesFile(), namesFile(), barrel()],
      }),
      metadata: root,
    });
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const f = join(d, n);
        if (statSync(f).isDirectory()) walk(f);
        else files.push(relative(dir, f).split("\\").join("/"));
      }
    };
    walk(dir);
    const index = readFileSync(join(dir, "index.ts"), "utf8");
    const specifiers = [...index.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
    return { specifiers, files: files.sort() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every barrel specifier must name a file the SAME run emitted. */
function resolvesAgainstEmittedFiles(specifiers: string[], files: string[]): string[] {
  const emitted = new Set(files.map((f) => f.replace(/\.tsx?$/, "")));
  return specifiers
    .filter((spec) => spec.startsWith("."))
    .map((spec) => spec.replace(/^\.\//, "").replace(/\.js$/, ""))
    .filter((spec) => !emitted.has(spec));
}

describe("the barrel's EXPORT SPECIFIERS point at files that exist", () => {
  for (const [label, model] of [
    ["root-declared", ROOT_DECLARED],
    ["object-declared", OBJECT_DECLARED],
  ] as const) {
    test(`${label} package, outputLayout: package`, async () => {
      const { specifiers, files } = await emitWithBarrel(model, "package");
      expect(specifiers.length).toBeGreaterThan(0);
      // Sanity: the run really did fold, so this is the case that can break.
      expect(files.some((f) => f.startsWith(`${PKG_DIR}/`))).toBe(true);
      expect(resolvesAgainstEmittedFiles(specifiers, files)).toEqual([]);
    });
  }

  test("flat layout still resolves", async () => {
    const { specifiers, files } = await emitWithBarrel(ROOT_DECLARED, "flat");
    expect(specifiers.length).toBeGreaterThan(0);
    expect(resolvesAgainstEmittedFiles(specifiers, files)).toEqual([]);
  });
});

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
