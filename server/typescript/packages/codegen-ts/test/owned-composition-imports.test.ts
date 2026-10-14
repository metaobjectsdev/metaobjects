import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * A composition an adopter OWNS may only call what the package exports.
 *
 * ADR-0034 gives an adopter an ownable copy of each generator, and the reference templates
 * carry their composer's body verbatim — so every engine primitive the body calls must be
 * reachable from the engine entry, `@metaobjectsdev/codegen-ts/engine` (ADR-0034 Amendment 8),
 * or the file an adopter was handed does not compile.
 *
 * History, because it is why this gate exists. The routes tier used to keep its composition
 * (M:N junction traversal, TPH per-subtype route sets) in the engine as `renderRoutesFile`,
 * and the template told an adopter retargeting to another HTTP framework to copy that body
 * out of the package source. Measured 2026-09-07, two of the sixteen symbols that body
 * imported — `routesHandlerName` and `TPH_POLYMORPHIC_VERBS` — were not exported, so the
 * documented escape ended in `TS2305: has no exported member`. Since ADR-0034 Amendment 3's
 * 2026-09-24 ruling the composition IS in the template (`renderRoutes` / `renderRoutesHono`),
 * so the question moved from "is the body copyable" to "does the copied body import only
 * public names" — the same defect, asked of the file the adopter now actually has.
 *
 * The required set is DERIVED from each template's own import statement rather than listed
 * here: a hand-kept list is the same defect one level up.
 */

const PKG = join(import.meta.dir, "..");

/** The reference templates whose composition is the relocated engine body. */
const OWNED_COMPOSITIONS = [
  "src/reference/routes.ts",
  "src/reference/routes-hono.ts",
  "src/reference/entity.ts",
  "src/reference/queries.ts",
] as const;

/** Named imports a module takes from the engine entry — multi-line bodies included. */
function engineNamedImports(source: string): string[] {
  const names = new Set<string>();
  const re = /import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*"@metaobjectsdev\/codegen-ts\/engine"/g;
  for (const m of source.matchAll(re)) {
    for (const raw of m[1]!.replace(/\/\/[^\n]*/g, "").split(",")) {
      const name = raw
        .replace(/\/\/[^\n]*/g, "")
        .replace(/^\s*type\s+/, "")
        .split(/\s+as\s+/)[0]!
        .trim();
      if (name) names.add(name);
    }
  }
  return [...names].sort();
}

/** Everything the engine entry exports, by name, as the TypeScript checker resolves it. */
function publicSurface(): Set<string> {
  const entry = join(PKG, "src/engine.ts");
  const program = ts.createProgram({
    rootNames: [entry],
    options: { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, noEmit: true, skipLibCheck: true },
  });
  const checker = program.getTypeChecker();
  const module = checker.getSymbolAtLocation(program.getSourceFile(entry)!)!;
  return new Set(checker.getExportsOfModule(module).map((s) => s.name));
}

describe("a composition an adopter owns imports only public API", () => {
  const surface = publicSurface();

  test("the routes templates carry the composition, not a call into the engine", () => {
    // The premise of the 2026-09-24 ruling: owning `routes` means owning what it emits. A
    // template that went back to delegating would pass the import check below vacuously.
    expect(readFileSync(join(PKG, "src/reference/routes.ts"), "utf8")).not.toMatch(/\brenderRoutesFile\(/);
    expect(readFileSync(join(PKG, "src/reference/routes-hono.ts"), "utf8")).not.toMatch(/\brenderRoutesFileHono\(/);
  });

  for (const template of OWNED_COMPOSITIONS) {
    test(`${template} — every engine import is reachable from the engine entry`, () => {
      const required = engineNamedImports(readFileSync(join(PKG, template), "utf8"));
      expect(required.length).toBeGreaterThan(0);
      const missing = required.filter((n) => !surface.has(n));
      expect(missing).toEqual([]);
    });
  }
});
