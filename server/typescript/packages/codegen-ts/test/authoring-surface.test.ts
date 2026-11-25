// ADR-0034 Amendment 12 — the generator-authoring surface is named, promised and pinned by name.
//
// Three checks:
//   1. `AUTHORING_SURFACE` is the shared manifest's `surface.typescript`, role for role.
//   2. Every surface module is an engine module, so an owned copy reaches it through the engine
//      entry (`@metaobjectsdev/codegen-ts/engine`).
//   3. The names the engine entry exports FROM the surface modules equal the committed snapshot
//      (`authoring-surface.snapshot.json`). Removing or renaming one is a major of this package
//      (docs/compatibility-policy.md); adding one is a minor. Either way the diff to the snapshot
//      is the review. Regenerate with UPDATE_AUTHORING_SURFACE=1 after deciding the change.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { AUTHORING_SURFACE, ENGINE_MODULES } from "../src/engine-surface.js";

const PKG = resolve(import.meta.dir, "..");
const PACKAGES = resolve(PKG, "..");
const REPO = resolve(PACKAGES, "../../..");
const MANIFEST = join(REPO, "fixtures/generator-registry-conformance/registry.json");
const SNAPSHOT = join(PKG, "test/authoring-surface.snapshot.json");

interface Manifest {
  surface: Record<string, unknown>;
}

const surfaceModules = (): string[] => Object.values(AUTHORING_SURFACE).flat();

/** For each surface module, the names the engine entry exports that are declared in it. */
function exportedNamesBySurfaceModule(): Record<string, string[]> {
  const entry = join(PKG, "src/engine.ts");
  const program = ts.createProgram({
    rootNames: [entry],
    options: {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
    },
  });
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(entry)!)!;
  const wanted = new Set(surfaceModules());
  const out: Record<string, string[]> = Object.fromEntries([...wanted].sort().map((m) => [m, []]));
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    for (const decl of target.declarations ?? []) {
      const key = relative(PACKAGES, decl.getSourceFile().fileName).split("\\").join("/");
      if (wanted.has(key) && !out[key]!.includes(exported.name)) out[key]!.push(exported.name);
    }
  }
  for (const names of Object.values(out)) names.sort();
  return out;
}

describe("the generator-authoring surface (ADR-0034 Amendment 12)", () => {
  test("is the shared manifest's surface.typescript", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
    expect(manifest.surface.typescript).toEqual(AUTHORING_SURFACE);
  });

  test("is part of the engine an owned copy may import", () => {
    const engine = new Set(ENGINE_MODULES);
    expect(surfaceModules().filter((m) => !engine.has(m))).toEqual([]);
  });

  test("exports exactly the snapshotted names through the engine entry", () => {
    const actual = exportedNamesBySurfaceModule();
    if (process.env.UPDATE_AUTHORING_SURFACE === "1") {
      writeFileSync(SNAPSHOT, `${JSON.stringify(actual, null, 2)}\n`);
    }
    const expected = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Record<string, string[]>;
    for (const [module, names] of Object.entries(actual)) {
      expect(names.length, `${module} exports nothing through the engine entry`).toBeGreaterThan(0);
    }
    expect(actual).toEqual(expected);
  });
});
