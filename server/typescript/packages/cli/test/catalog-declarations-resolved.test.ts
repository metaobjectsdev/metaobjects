// Every compatibility declaration in the catalog is RESOLVED, not trusted.
//
// This is the `@implementedBy` doctrine applied to the catalog. A declaration is a
// promise someone has to remember to keep, and "someone remembers" scales badly across
// five ports and a growing framework set — so `requires` and `runtimePeers` are checked
// against what the generators ACTUALLY EMIT, by running them.
//
// Note what this does NOT do. It never asks whether a generator applies to a model —
// that is `--probe`, which cannot drift because it runs the generators rather than
// describing them. This file is the other half: what a generator NEEDS in order to
// work, which is declared and therefore has to be gated. Conflating the two is how a
// catalog goes quietly wrong as frameworks are added (design §D5).
//
// The gates are deliberately SUBSET checks (declared ⊇ actual), not equality. Over-
// declaring is a documentation defect an adopter can shrug off; under-declaring hands
// them a file that does not compile.

import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, dirname, resolve, sep } from "node:path";
import { loadMemory } from "@metaobjectsdev/sdk";
import { runGen, type MetaobjectsGenConfig } from "@metaobjectsdev/codegen-ts";
import * as coreTpl from "@metaobjectsdev/codegen-ts";
import * as reactTpl from "@metaobjectsdev/codegen-ts-react";
import * as tanstackTpl from "@metaobjectsdev/codegen-ts-tanstack";
import { composeCatalog } from "../src/lib/catalog.js";
import { buildCatalogListing, type GeneratorCatalogRow } from "../src/lib/catalog-listing.js";

const FIXTURE = join(import.meta.dir, "fixtures", "catalog-probe");
const OUT_DIR = "src/generated";

/** Emitted files for one generator: project-relative path → contents. */
type Emission = Map<string, string>;

/** Every generator's emission, keyed by stable name. Empty when it could not run. */
const emissions = new Map<string, Emission>();
/** Which generator emitted a given project-relative path (first writer wins). */
const owners = new Map<string, string>();

/** A path with its extension removed — the form an import specifier can be matched to.
 *  Generated code imports `./Customer.js`; the file on disk is `Customer.ts`. */
function stem(p: string): string {
  return p.replace(/\.[cm]?[jt]sx?$/, "");
}

function walkFiles(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...walkFiles(root, abs));
    else out.push(relative(root, abs));
  }
  return out;
}

/** Every import/export specifier in a source file. */
function specifiersOf(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]{0,400}?from\s+["']([^"']+)["']/g)) {
    if (m[1] !== undefined) found.push(m[1]);
  }
  for (const m of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
    if (m[1] !== undefined) found.push(m[1]);
  }
  return found;
}

/** The npm PACKAGE a bare specifier names — `zod/v4` → `zod`, `@scope/x/y` → `@scope/x`. */
function packageOfSpecifier(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

beforeAll(async () => {
  const metadata = await loadMemory(FIXTURE, {});
  const config: MetaobjectsGenConfig = {
    outDir: OUT_DIR,
    extStyle: "js",
    dialect: "sqlite",
    dbImport: "../db",
    generators: [],
  };

  for (const [name, entry] of Object.entries(composeCatalog())) {
    const root = mkdtempSync(join(tmpdir(), `catalog-emit-${name}-`));
    try {
      // A REAL write, not a dry run: this gate reads the emitted CONTENT, and a
      // dry run reports paths only.
      await runGen({
        config: { ...config, generators: [entry.factory()] },
        metadata,
        projectRoot: root,
        genStateDir: join(root, ".gen-state"),
      });
      const emission: Emission = new Map();
      for (const rel of walkFiles(root)) {
        if (rel.split(sep)[0] === ".gen-state") continue;
        emission.set(rel, readFileSync(join(root, rel), "utf8"));
        if (!owners.has(rel)) owners.set(rel, name);
      }
      emissions.set(name, emission);
    } catch {
      // A generator that cannot run from a bare fixture (render-helper needs a
      // template root, shared-model needs a `files` selection) contributes nothing
      // and is reported by the coverage test below rather than silently skipped.
      emissions.set(name, new Map());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("catalog declarations are resolved against what the generators emit", () => {
  test("the harness actually ran — most generators emitted something", () => {
    const produced = [...emissions.entries()].filter(([, e]) => e.size > 0).map(([n]) => n);
    // If this ever collapses to a handful, every subset check below is vacuously
    // green and the whole file stops gating anything.
    expect(produced.length).toBeGreaterThan(12);
  });

  test("exactly these generators contribute NO evidence — the list may only shrink", () => {
    // A generator that emits nothing here makes every subset check below vacuously
    // green for it, so its declarations are UNVERIFIED. That is a real coverage hole
    // and it is pinned rather than left implicit: a corpus that quietly loses coverage
    // fails nothing.
    //
    // Why each is here, and what it would take to close it:
    //   render-helper   needs an on-disk template root for its build-time drift gate
    //   shared-model    needs a `files` selection `meta gen` supplies at run time
    //   trace-helper    needs an entity extending metaobjects::ai::LlmCallBase
    //   docs, api-docs  emit under a docs config this bare fixture does not carry
    //   template        a PRIMITIVE — registered with a no-op walk, by construction
    //   requirement-tests  emits stubs, which this harness writes but reads no imports
    //                      from beyond `bun:test` (a builtin, deliberately skipped)
    const silent = [...emissions.entries()].filter(([, e]) => e.size === 0).map(([n]) => n).sort();
    expect(silent).toEqual([
      "api-docs",
      "docs",
      "render-helper",
      "shared-model",
      "template",
      "trace-helper",
    ]);
  });

  test("runtimePeers ⊇ the third-party packages the emitted files import", () => {
    const catalog = composeCatalog();
    const undeclared: string[] = [];

    for (const [name, emission] of emissions) {
      const declared = new Set(catalog[name]!.runtimePeers ?? []);
      const seen = new Set<string>();
      for (const source of emission.values()) {
        for (const spec of specifiersOf(source)) {
          // `node:` and `bun:` are runtime builtins, not packages an adopter installs.
          // `bun:test` in particular is what a requirement-tests STUB imports, and
          // telling anyone to `npm i bun:test` would be nonsense.
          if (spec.startsWith(".") || spec.startsWith("node:") || spec.startsWith("bun:")) continue;
          const pkg = packageOfSpecifier(spec);
          // `@metaobjectsdev/*` is `runtimePackage`, not a third-party peer, and is
          // asserted separately below.
          if (pkg.startsWith("@metaobjectsdev/")) continue;
          if (!declared.has(pkg)) seen.add(pkg);
        }
      }
      for (const pkg of [...seen].sort()) undeclared.push(`${name} emits an import of "${pkg}"`);
    }

    expect(
      undeclared,
      "A generator's output imports a third-party package its catalog entry does not\n" +
        "declare, so `meta eject` will not tell an adopter to install it and their first\n" +
        "tsc reports TS2307. Add each to that entry's `runtimePeers`:\n  " +
        undeclared.join("\n  "),
    ).toEqual([]);
  });

  test("runtimePackages ⊇ the @metaobjectsdev runtimes the emitted code imports", () => {
    const catalog = composeCatalog();
    const undeclared: string[] = [];

    for (const [name, emission] of emissions) {
      const declared = new Set(catalog[name]!.runtimePackages ?? []);
      const seen = new Set<string>();
      for (const source of emission.values()) {
        for (const spec of specifiersOf(source)) {
          const pkg = packageOfSpecifier(spec);
          if (!pkg.startsWith("@metaobjectsdev/")) continue;
          if (!declared.has(pkg)) seen.add(pkg);
        }
      }
      for (const pkg of [...seen].sort()) {
        undeclared.push(`${name} emits an import of "${pkg}" but does not declare it in runtimePackages`);
      }
    }

    expect(
      undeclared,
      "Generated code imports a MetaObjects runtime the catalog does not name, so an\n" +
        "adopter is never told to install it:\n  " + undeclared.join("\n  "),
    ).toEqual([]);
  });

  test("requires ⊇ the generators whose emitted paths this generator's output imports", () => {
    const catalog = composeCatalog();
    const undeclared: string[] = [];

    for (const [name, emission] of emissions) {
      const declared = new Set(catalog[name]!.requires ?? []);
      const needed = new Set<string>();
      for (const [rel, source] of emission) {
        for (const spec of specifiersOf(source)) {
          if (!spec.startsWith(".")) continue;
          const target = stem(resolve("/", dirname(rel), spec).slice(1));
          for (const [ownedPath, owner] of owners) {
            // A relative import that resolves to nothing any generator emits is a
            // reference to the adopter's OWN code (routes' `dbImport`, for one) —
            // config, not a generator dependency, so it is deliberately not a
            // `requires` edge.
            if (stem(ownedPath) !== target) continue;
            if (owner !== name && !declared.has(owner)) needed.add(owner);
          }
        }
      }
      for (const dep of [...needed].sort()) {
        undeclared.push(`${name} imports a module "${dep}" emits, but does not declare requires: [..., "${dep}"]`);
      }
    }

    expect(
      undeclared,
      "A generator depends on another generator's output without saying so, so the\n" +
        "requires gate cannot warn an adopter who wires one without the other:\n  " +
        undeclared.join("\n  "),
    ).toEqual([]);
  });

  test("every ejectable entry has a template, and every template has an entry", () => {
    const catalog = composeCatalog();
    const templates = new Set<string>([
      ...coreTpl.REFERENCE_GENERATOR_NAMES,
      ...reactTpl.REFERENCE_GENERATOR_NAMES,
      ...tanstackTpl.REFERENCE_GENERATOR_NAMES,
    ]);

    expect(
      [...templates].filter((n) => !(n in catalog)).sort(),
      "a reference template nothing in the catalog can reach",
    ).toEqual([]);
    expect(
      Object.values(catalog).filter((e) => e.ejectable && !templates.has(e.name)).map((e) => e.name).sort(),
      "an entry claiming to be ejectable with no template to copy",
    ).toEqual([]);
    expect(
      Object.values(catalog).filter((e) => !e.ejectable && templates.has(e.name)).map((e) => e.name).sort(),
      "a template that exists but whose entry says it cannot be ejected",
    ).toEqual([]);
  });

  test("every ejectable entry's facets actually REACH `--list`", async () => {
    // Asserted through the consumer rather than over the template source. A
    // `// use-when:` line being PRESENT and the facet arriving on the row a reader sees
    // are different claims: the header parser takes continuation lines, stops at the
    // next facet, and returns undefined for an empty body, so a marker with nothing
    // after it satisfies a substring check and still reports nothing.
    const rows = await buildCatalogListing();
    const generators = rows.filter(
      (r): r is GeneratorCatalogRow => r.kind === "generator" && r.source.ejectable,
    );
    // Guards the loop below from passing over an empty list.
    expect(generators.length, "no ejectable generator rows to check").toBeGreaterThan(0);

    const missing: string[] = [];
    for (const row of generators) {
      if ((row.useWhen ?? "").trim() === "") missing.push(`${row.name}: no use-when reaches --list`);
      if ((row.emits ?? "").trim() === "") missing.push(`${row.name}: no emits reaches --list`);
    }
    expect(missing, missing.join("\n  ")).toEqual([]);
  });
});
