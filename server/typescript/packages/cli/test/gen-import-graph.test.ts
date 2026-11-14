// `meta gen` touches no database, so loading it loads no query builder and no driver.
// It used to: the schema advice it prints imported the migrate-ts package root, whose
// introspect / apply / replay modules import kysely, and kysely was a seventh of gen's
// start-up. The gen path reads `@metaobjectsdev/migrate-ts/offline` instead; a driver is
// imported dynamically, by the commands that connect, when they connect.
//
// Walks the STATIC import graph from the gen command (a dynamic `import()` is a lazy load
// by definition, so it is not followed) and fails naming the chain that reaches one.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const GEN = resolve(import.meta.dir, "..", "src", "commands", "gen.ts");
const DATABASE_PACKAGES = [/^kysely(\/|$)/, /^pg(\/|$)/, /^@libsql\//, /^better-sqlite3$/, /^bun:sqlite$/];

const transpiler = new Bun.Transpiler({ loader: "ts" });

function staticImports(file: string): string[] {
  return transpiler
    .scanImports(readFileSync(file, "utf-8"))
    .filter((i) => i.kind === "import-statement")
    .map((i) => i.path);
}

describe("the meta gen import graph", () => {
  test("reaches no database package statically", () => {
    const parent = new Map<string, string>();
    const seen = new Set<string>([GEN]);
    const queue = [GEN];
    const hits: string[] = [];
    while (queue.length > 0) {
      const file = queue.shift()!;
      for (const spec of staticImports(file)) {
        if (DATABASE_PACKAGES.some((re) => re.test(spec))) {
          const chain = [spec, file];
          for (let p = parent.get(file); p !== undefined; p = parent.get(p)) chain.push(p);
          hits.push(chain.reverse().join("\n  -> "));
          continue;
        }
        if (spec.startsWith("node:")) continue;
        let target: string;
        try {
          target = Bun.resolveSync(spec, dirname(file));
        } catch {
          continue;
        }
        // Follow this repository's own sources only; a third-party package is a leaf.
        if (target.includes("/node_modules/") || !/\.(ts|tsx|js|mjs)$/.test(target)) continue;
        if (seen.has(target)) continue;
        seen.add(target);
        parent.set(target, file);
        queue.push(target);
      }
    }
    expect(seen.size).toBeGreaterThan(50);
    expect(hits).toEqual([]);
  });
});
