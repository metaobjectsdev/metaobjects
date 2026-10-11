/**
 * The two ways to run a stock generator, end to end, through the BUILT CLI.
 *
 * 1.0 made an owned copy the only path for `entity` / `queries` / `routes` / `barrel`;
 * 1.1 restored the package import (ADR-0034 Amendment 5). Both are supported, so both
 * are driven here the way an adopter drives them — `metaobjects.config.ts`, `meta gen`,
 * `meta verify --codegen` — rather than by calling the factories directly, because the
 * failure 1.0 shipped lived in the config LOADER and no factory-level test could see it.
 *
 * Three claims, one test each:
 *
 *   1. Importing the four from the package generates, and the drift gate is clean.
 *   2. An owned copy bound to the package emits what the import emits. This is the
 *      migration note's promise in both directions: an adopter can drop an unmodified
 *      owned copy for the import (or eject one they were importing) and regenerate
 *      nothing they did not expect.
 *   3. What DOES change on a default eject is only where the HTTP-adapter import points,
 *      because `meta eject` hands over that source too. Pinned so the migration note
 *      can say "these lines and no others" and stay true.
 *
 * Subprocess-per-command for the reason `verify-codegen-ejected-generator` gives: the
 * config is re-read under a fresh name each load but the modules it imports are cached.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { meta, requireFreshDist } from "./support/built-cli.js";

const FIXTURES = resolve(import.meta.dirname, "..", "fixtures");
// Inside the workspace, so an ejected template's `@metaobjectsdev/codegen-ts` import
// resolves by walking up to the workspace root.
const WORKSPACE_TMP = join(FIXTURES, "__tmp__");
const OUT = "generated";
const STOCK = ["entity", "queries", "routes", "barrel"] as const;
const RUNTIME_PACKAGE = "@metaobjectsdev/runtime-ts";

function config(imports: string, generators: string): string {
  return [
    `import { defineConfig } from "@metaobjectsdev/codegen-ts";`,
    imports,
    `export default defineConfig({`,
    `  outDir: ${JSON.stringify(OUT)},`,
    `  dialect: "sqlite",`,
    `  dbImport: "~/db",`,
    `  extStyle: "none",`,
    `  generators: [${generators}],`,
    `});`,
  ].join("\n");
}

/** As shipped: the package's factories, no copy in the repo. */
const IMPORTED = config(
  `import { entityFile, queriesFile, routesFile, barrel } from "@metaobjectsdev/codegen-ts/generators";`,
  `entityFile(), queriesFile(), routesFile(), barrel()`,
);

const OWNED_IMPORTS = [
  `import { entityFile } from "./codegen/generators/entity.js";`,
  `import { queriesFile } from "./codegen/generators/queries.js";`,
  `import { routesFile } from "./codegen/generators/routes.js";`,
  `import { barrel } from "./codegen/generators/barrel.js";`,
].join("\n");

/** Owned copies, with the two that import the HTTP adapter pointed back at the package. */
const OWNED_ON_PACKAGE_RUNTIME = config(
  OWNED_IMPORTS,
  `entityFile({ runtimeImport: ${JSON.stringify(RUNTIME_PACKAGE)} }), queriesFile(), ` +
    `routesFile({ runtimeImport: ${JSON.stringify(RUNTIME_PACKAGE)} }), barrel()`,
);

/** Owned copies exactly as `meta eject` wires them: the adapter is the local copy. */
const OWNED_DEFAULT = config(OWNED_IMPORTS, `entityFile(), queriesFile(), routesFile(), barrel()`);

function setupRepo(configSource: string): string {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(WORKSPACE_TMP, "stock-importable-"));
  cpSync(join(FIXTURES, "trainer-website-meta"), root, { recursive: true });
  writeFileSync(join(root, "metaobjects.config.ts"), configSource);
  return root;
}

/** Every generated file, path → contents. */
function generated(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const dir = join(root, OUT);
  for (const f of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!f.isFile()) continue;
    const abs = join(f.parentPath, f.name);
    out.set(abs.slice(dir.length + 1), readFileSync(abs, "utf8"));
  }
  return out;
}

// Precondition once per FILE, not per test: this gate runs the BUILT CLI.
beforeAll(requireFreshDist);

describe("stock generators — imported from the package, or owned", () => {
  test("importing entity, queries, routes and barrel from the package generates and verifies clean", async () => {
    const root = setupRepo(IMPORTED);
    try {
      const gen = await meta(root, "gen");
      expect(gen).toMatchObject({ exit: 0 });

      const files = [...generated(root).keys()];
      expect(files).toContain("User.ts");
      expect(files).toContain("User.queries.ts");
      expect(files).toContain("User.routes.ts");
      expect(files).toContain("index.ts");

      expect(await meta(root, "verify", "--codegen")).toMatchObject({ exit: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("an owned copy bound to the package emits exactly what the import emits", async () => {
    const root = setupRepo(IMPORTED);
    try {
      expect(await meta(root, "gen")).toMatchObject({ exit: 0 });
      const imported = generated(root);

      // Take ownership of all four, changing nothing about them.
      expect(await meta(root, "eject", ...STOCK)).toMatchObject({ exit: 0 });
      writeFileSync(join(root, "metaobjects.config.ts"), OWNED_ON_PACKAGE_RUNTIME);

      // The committed output was written by the PACKAGE's generators. If the owned
      // copies would write anything else, this is where it shows.
      expect(await meta(root, "verify", "--codegen")).toMatchObject({ exit: 0 });

      expect(await meta(root, "gen")).toMatchObject({ exit: 0 });
      expect(generated(root)).toEqual(imported);

      // And back: dropping the unmodified copies for the import is equally a no-op.
      writeFileSync(join(root, "metaobjects.config.ts"), IMPORTED);
      expect(await meta(root, "verify", "--codegen")).toMatchObject({ exit: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  test("a default eject moves only the HTTP-adapter import lines", async () => {
    const root = setupRepo(IMPORTED);
    try {
      expect(await meta(root, "gen")).toMatchObject({ exit: 0 });
      const imported = generated(root);

      expect(await meta(root, "eject", ...STOCK)).toMatchObject({ exit: 0 });
      writeFileSync(join(root, "metaobjects.config.ts"), OWNED_DEFAULT);
      expect(await meta(root, "gen")).toMatchObject({ exit: 0 });
      const owned = generated(root);

      expect([...owned.keys()].sort()).toEqual([...imported.keys()].sort());

      const changed: string[] = [];
      for (const [path, before] of imported) {
        const after = owned.get(path) ?? "";
        if (after === before) continue;
        changed.push(path);
        // Compared as line SETS: the import block is sorted by specifier, so moving one
        // import from a package name to a relative path also moves the line it sits on.
        const a = new Set(before.split("\n"));
        const b = new Set(after.split("\n"));
        const onlyImported = [...a].filter((l) => !b.has(l));
        const onlyOwned = [...b].filter((l) => !a.has(l));
        expect({ path, lines: onlyOwned.length }).toEqual({ path, lines: onlyImported.length });
        // The package line names the runtime package; the owned line names the copy.
        for (const line of onlyImported) {
          expect({ path, line }).toEqual({ path, line: expect.stringContaining(RUNTIME_PACKAGE) });
        }
        for (const line of onlyOwned) {
          expect({ path, line }).toEqual({ path, line: expect.stringContaining("codegen/runtime/") });
        }
      }
      // Only the two generators whose output imports the adapter are affected: the
      // entity module (allowlist types) and the routes module (mount helpers).
      expect(changed.sort()).toEqual(
        [...imported.keys()].filter((p) => !p.endsWith(".queries.ts") && p !== "index.ts").sort(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
