// B1 — a cross-package M:N names import must resolve to the actual file on disk.
//
// `resolveJunctionColumn` (routes-file.ts) used to build the `<Junction>Names` /
// `<Target>Names` import with `siblingSpecifier(ctx.selfTarget, entity.package, …)`,
// where `entity` is the JUNCTION or TARGET object — but the routes file being emitted
// lives in the SOURCE entity's package. Under `outputLayout: "package"`, with the
// junction/target in a DIFFERENT package from the source, that produced a
// same-directory import (`./ArticleLabel.names.js`) inside `shop/blog/Article.routes.ts`
// pointing at a file that actually lives in `shop/tags/` — TS2307 on a documented
// layout. The existing M:N names-consumption coverage (m2m-codegen.test.ts,
// `NAMES_META`) is single-package and flat, so it cannot see this: there,
// `fromPackage === entity.package` regardless of which one is used, by construction.
//
// This test runs a REAL `runGen` (writing to a temp dir) rather than asserting on the
// import string alone — a string assertion would have passed for the broken code too
// (a same-directory specifier is a perfectly well-formed string; it is simply wrong).
// The assertion that actually discriminates is `existsSync` on the file the emitted
// import specifier resolves to.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve as resolvePath } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { runGen, defineConfig } from "../../src/index.js";
import { namesFile } from "../../src/generators/index.js";
import { entityFile } from "../../src/generators/entity-file.js";
import { routesFile } from "../../src/generators/routes-file.js";

// Article (shop::blog) <—many:many—> Label (shop::tags), through ArticleLabel
// (shop::tags) — junction AND target both in a DIFFERENT package from the source, so
// all three `resolveJunctionColumn` call sites in `renderM2mMount` (source column,
// target column via the junction; target PK column via the target) cross a package
// boundary.
const META = {
  "metadata.root": {
    children: [
      { "object.entity": { name: "Article", package: "shop::blog", children: [
        { "source.rdb": { "@table": "articles" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "headline", "@required": true } },
        { "relationship.association": {
            name: "labels", "@cardinality": "many",
            "@objectRef": "shop::tags::Label", "@through": "shop::tags::ArticleLabel",
        } },
        { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
      ] } },
      { "object.entity": { name: "Label", package: "shop::tags", children: [
        { "source.rdb": { "@table": "labels" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "name", "@required": true } },
        { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
      ] } },
      { "object.entity": { name: "ArticleLabel", package: "shop::tags", children: [
        { "source.rdb": { "@table": "article_labels" } },
        { "field.long": { name: "articleId", "@required": true } },
        { "field.long": { name: "labelId", "@required": true } },
        { "identity.primary": { name: "id", "@fields": ["articleId", "labelId"] } },
        { "identity.reference": { name: "fkArticle", "@fields": "articleId", "@references": "shop::blog::Article" } },
        { "identity.reference": { name: "fkLabel", "@fields": "labelId", "@references": "Label" } },
      ] } },
    ],
  },
};

async function loadRoot() {
  const res = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(META))]);
  expect(res.errors).toEqual([]);
  return res.root;
}

describe("renderRoutesFile — cross-package M:N names imports resolve to the right directory (B1)", () => {
  test("Article.routes.ts's <Junction>Names / <Target>Names imports point at files that actually exist on disk", async () => {
    const root = await loadRoot();
    const tmp = mkdtempSync(join(tmpdir(), "codegen-m2m-xpkg-"));
    try {
      const result = await runGen({
        config: defineConfig({
          outDir: tmp,
          extStyle: "js",
          dbImport: "../db",
          dialect: "sqlite",
          outputLayout: "package",
          generators: [entityFile(), namesFile(), routesFile()],
        }),
        metadata: root,
      });
      expect(result.files.length).toBeGreaterThan(0);

      const routesPath = join(tmp, "shop", "blog", "Article.routes.ts");
      expect(existsSync(routesPath)).toBe(true);
      const content = readFileSync(routesPath, "utf-8");

      // Every relative "<X>.names.js" import this file makes must resolve to a file
      // that actually exists — the assertion the pre-fix code failed: it emitted
      // "./ArticleLabel.names.js" / "./Label.names.js" (same-directory), which resolve
      // to shop/blog/*.names.ts — files that were never written there.
      const importRe = /from "(\.[^"]+\.names\.js)"/g;
      const specifiers = [...content.matchAll(importRe)].map((m) => m[1]!);
      expect(specifiers.length).toBeGreaterThan(0);
      for (const spec of specifiers) {
        // Generated modules are emitted as `.ts` on disk; the import specifier says
        // `.js` per Node ESM/nodenext convention (extStyle "js") — swap the extension
        // back to check the SOURCE file the specifier is meant to resolve to.
        const resolved = resolvePath(dirname(routesPath), spec).replace(/\.js$/, ".ts");
        expect(
          existsSync(resolved),
          `import "${spec}" from Article.routes.ts does not resolve to a real file (${resolved})`,
        ).toBe(true);
      }

      // Specifically: the junction + target names artifacts are one package DIRECTORY
      // over ("../tags/…"), never same-directory ("./…") — the shape the bug produced.
      expect(content).toContain('from "../tags/ArticleLabel.names.js"');
      expect(content).toContain('from "../tags/Label.names.js"');
      expect(content).not.toContain('from "./ArticleLabel.names.js"');
      expect(content).not.toContain('from "./Label.names.js"');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
