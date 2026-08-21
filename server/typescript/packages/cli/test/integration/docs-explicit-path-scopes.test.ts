/**
 * #327 — an explicit `meta docs <path>` DEFINES the source set; it never extends it.
 *
 * The positional argument has always meant "document this", and before metadata
 * sources were resolvable it did exactly that: the loader read `<path>/metaobjects/`
 * and nothing else. Routing docs through `resolveCollection(<path>)` turned that
 * argument into a *starting point for an upward walk*, so the nearest ancestor
 * `.metaobjects/config.json` was found and ITS declared sources were unioned in.
 * Nothing was lost — every page the argument used to produce is still produced — but
 * unrelated trees were silently added, and this fails OPEN: exit 0, just more pages
 * than anyone asked for, invisible until someone counts them.
 *
 * `resolveCollection` already has the pin: `{ explicitDir }` skips the walk. A bare
 * `meta docs` with no positional keeps discovery, which is the right default for
 * "document the project I am standing in".
 */
import { describe, test, expect } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../../src/index.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");
const WORKSPACE_TMP = resolve(import.meta.dirname, "../fixtures/__tmp__");

/** A second, unrelated package — the "other tree" the ancestor config also declares. */
const OTHER_PACKAGE = JSON.stringify({
  "metadata.root": {
    package: "unrelated",
    children: [
      {
        "object.entity": {
          name: "Invoice",
          children: [
            { "source.rdb": { "@table": "invoices" } },
            { "field.long": { name: "id", "@column": "id" } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
    ],
  },
});

/**
 * Repo root declares BOTH apps' metadata as its sources; each app also holds its own
 * metadata directory, so an explicit path resolves to exactly one of them.
 */
function setupMonorepo(): { root: string; appA: string } {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(WORKSPACE_TMP, "forge-docs-scope-"));
  const appA = join(root, "appA");
  mkdirSync(appA, { recursive: true });
  cpSync(join(FIXTURES, "trainer-website-meta"), appA, { recursive: true });

  mkdirSync(join(root, "appB", "metaobjects"), { recursive: true });
  writeFileSync(join(root, "appB", "metaobjects", "other.json"), OTHER_PACKAGE, "utf8");

  mkdirSync(join(root, ".metaobjects"), { recursive: true });
  writeFileSync(
    join(root, ".metaobjects", "config.json"),
    JSON.stringify({
      schema_version: 1,
      sources: [{ path: "appA/metaobjects" }, { path: "appB/metaobjects" }],
    }),
    "utf8",
  );
  return { root, appA };
}

/** Every emitted markdown page name, at any depth under `dir`. */
function pageNames(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .sort();
}

describe("meta docs <path> — the explicit path defines the source set (#327)", () => {
  test("an explicitly-scoped run does not absorb the ancestor config's other sources", async () => {
    const { root, appA } = setupMonorepo();
    const outDir = join(root, "out");
    try {
      const exit = await run(["docs", appA, "--out", outDir, "--model"]);
      expect(exit).toBe(0);

      const pages = pageNames(outDir);
      // The scoped tree's own entities are documented...
      expect(pages).toContain("User.md");
      // ...and the unrelated tree the ANCESTOR declares is not pulled in.
      expect(pages).not.toContain("Invoice.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a bare `meta docs` still discovers the ancestor collection", async () => {
    const { root, appA } = setupMonorepo();
    const outDir = join(root, "out");
    try {
      // No positional: the project is whatever `resolveCollection` discovers from cwd,
      // which is the root and its two declared sources.
      const exit = await run(["docs", "--cwd", appA, "--out", outDir, "--model"]);
      expect(exit).toBe(0);

      const pages = pageNames(outDir);
      expect(pages).toContain("User.md");
      expect(pages).toContain("Invoice.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
