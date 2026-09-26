import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A composition an adopter OWNS may only call what the package exports.
 *
 * ADR-0034 gives an adopter an ownable copy of each generator, and the reference templates
 * carry their composer's body verbatim — so every engine primitive the body calls must be
 * reachable from `@metaobjectsdev/codegen-ts`, or the file an adopter was handed does not
 * compile.
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

/** Named imports a module takes from `@metaobjectsdev/codegen-ts` — multi-line bodies included. */
function engineNamedImports(source: string): string[] {
  const names = new Set<string>();
  const re = /import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*"@metaobjectsdev\/codegen-ts"/g;
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

/** Everything the package's public entry re-exports, by name. */
function publicSurface(): Set<string> {
  const index = readFileSync(join(PKG, "src/index.ts"), "utf8");
  const names = new Set<string>();
  for (const m of index.matchAll(
    /export\s*(?:type\s+)?\{([^}]*)\}\s*from\s*"[^"]*"/g,
  )) {
    for (const raw of m[1]!.replace(/\/\/[^\n]*/g, "").split(",")) {
      // Line comments inside an export list are prose, not names.
      const part = raw.replace(/\/\/[^\n]*/g, "").replace(/^\s*type\s+/, "").trim();
      // `a as b` re-exports under b — the name an adopter can import.
      const name = (part.includes(" as ") ? part.split(/\s+as\s+/)[1] : part)?.trim();
      if (name) names.add(name);
    }
  }
  for (const m of index.matchAll(
    /export\s+(?:declare\s+)?(?:const|function|class|type|interface)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    names.add(m[1]!);
  }
  return names;
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
    test(`${template} — every engine import is reachable from the package entry`, () => {
      const required = engineNamedImports(readFileSync(join(PKG, template), "utf8"));
      expect(required.length).toBeGreaterThan(0);
      const missing = required.filter((n) => !surface.has(n));
      expect(missing).toEqual([]);
    });
  }
});
