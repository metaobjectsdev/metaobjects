import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A reference template that says "copy this body out of the package source" is making a promise
 * the exports map has to keep.
 *
 * ADR-0034 gives an adopter an ownable copy of each generator, and most tiers relocate the whole
 * composition into that copy — `entity.ts` and `queries.ts` carry the composer's body verbatim, so
 * every primitive they call is public by construction. The routes tier does NOT: its composition
 * (M:N junction traversal, TPH per-subtype route sets) stays in the engine as `renderRoutesFile`,
 * and the template's `customize:` note tells an adopter retargeting to another HTTP framework to
 * copy that body out of the package source.
 *
 * That instruction was UNTRUE. Measured 2026-09-07 against the published surface: of the sixteen
 * symbols `renderRoutesFile`'s body imports from inside the package, fourteen resolved from
 * `@metaobjectsdev/codegen-ts` and two did not — `routesHandlerName` and `TPH_POLYMORPHIC_VERBS`,
 * both `TS2305: has no exported member`. So the documented escape ended in a file that does not
 * compile, on the ONE tier every adopter outside Fastify and Hono has to retarget. The whole
 * ownership story is what the project offers instead of a codegen package per framework (FR-040),
 * and it was load-bearing exactly where it was broken.
 *
 * This gate DERIVES the required set from the body rather than restating it, because a hand-kept
 * list is the same defect one level up: `renderRoutesFile` gains an import, nobody re-reads this
 * file, and the escape silently breaks again.
 *
 * It is deliberately scoped to the compositions a template tells you to copy. A body nobody is
 * invited to copy owes nothing.
 */

const PKG = join(import.meta.dir, "..");

/** Compositions a reference template instructs an adopter to copy out of the package source. */
const COPYABLE_COMPOSITIONS = [
  {
    body: "src/templates/routes-file.ts",
    invitedBy: "src/reference/routes.ts",
    // The sentence in that template that makes the promise. Matched on the fragment that fits
    // one line, because the header is comment-wrapped and the full sentence spans two. If it is
    // reworded, this test's premise changed and the pairing has to be re-read rather than the
    // string patched.
    promise: "copy `renderRoutesFile`'s body out",
  },
] as const;

/** Named imports a module takes from paths INSIDE the package (relative specifiers). */
function internalNamedImports(source: string): string[] {
  const names = new Set<string>();
  // `import { a, type B, c as d } from "./x.js"` / "../y.js" — multi-line bodies included.
  const re = /import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*"(\.[^"]*)"/g;
  for (const m of source.matchAll(re)) {
    for (const raw of m[1]!.split(",")) {
      const name = raw
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
    for (const raw of m[1]!.split(",")) {
      const part = raw.replace(/^\s*type\s+/, "").trim();
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

describe("a composition an adopter is told to copy imports only public API", () => {
  const surface = publicSurface();

  for (const { body, invitedBy, promise } of COPYABLE_COMPOSITIONS) {
    test(`${body} — every internal import is reachable from the package entry`, () => {
      const template = readFileSync(join(PKG, invitedBy), "utf8");
      // The premise: the reference template really does invite the copy. If this fails, the
      // instruction moved or was withdrawn — decide which before touching the assertion below.
      expect(template).toContain(promise);

      const required = internalNamedImports(readFileSync(join(PKG, body), "utf8"));
      expect(required.length).toBeGreaterThan(0);

      const missing = required.filter((n) => !surface.has(n));
      expect(missing).toEqual([]);
    });
  }
});
