// Doc pages are keyed by package, whatever the target's outputLayout (which places code).
//
// A page named by its short name alone collides twice over: two nodes that share a short name
// in different packages (a layered model's `enterprise::party::Address` beside the
// application's `core::common::Address`) want one file, and two names that differ only in case
// (`ProductNdc`, `ProductNDC`) want one file on a case-insensitive filesystem. The package path
// is part of every page path, so the first pair are two pages; the second, in one package, is
// refused by name rather than written as one file that silently replaces the other.

import { describe, it, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { docsFile } from "../../src/generators/docs-file.js";
import { apiDocsFile } from "../../src/generators/api-docs-file.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import type { GenContext } from "../../src/generator.js";

function value(pkg: string, name: string): string {
  return JSON.stringify({
    "metadata.root": {
      package: pkg,
      children: [{ "object.value": { name, children: [{ "field.string": { name: "line1" } }] } }],
    },
  });
}

async function loadRoot(sources: string[]) {
  const res = await new MetaDataLoader().load(
    sources.map((s, i) => new InMemoryStringSource(s, { id: `src${i}.json`, format: "json" })),
  );
  expect(res.errors).toEqual([]);
  return res.root;
}

/** A docs target with no outputLayout: the default a project gets. */
function makeCtx(root: Awaited<ReturnType<typeof loadRoot>>): GenContext {
  return {
    entities: root.objects(),
    loadedRoot: root,
    matches: () => true,
    config: { outDir: "/tmp", extStyle: "none", dbImport: "~/db", dialect: "sqlite" } as never,
    renderContext: makeRenderContext({
      dialect: "sqlite", loadedRoot: root, outDir: "/tmp", dbImport: "~/db",
      pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
    }),
    warn: () => {},
  };
}

const TWO_ADDRESSES = [value("enterprise::party", "Address"), value("core::common", "Address")];

describe("doc pages are keyed by package", () => {
  it("two same-named nodes in two packages are two model pages, both linked from the index", async () => {
    const out = await docsFile().generate(makeCtx(await loadRoot(TWO_ADDRESSES)));
    const paths = out.map((f) => f.path).sort();
    expect(paths).toEqual(["README.md", "core/common/Address.md", "enterprise/party/Address.md"]);
    const readme = out.find((f) => f.path === "README.md")!.content;
    // Readable: the index tells the two apart by package.
    expect(readme).toContain("[Address (core::common)](./core/common/Address.md)");
    expect(readme).toContain("[Address (enterprise::party)](./enterprise/party/Address.md)");
  });

  it("two same-named nodes in two packages are two api pages, both linked from the api index", async () => {
    const out = await apiDocsFile().generate(makeCtx(await loadRoot(TWO_ADDRESSES)));
    const paths = out.map((f) => f.path);
    expect(paths).toContain("api/core/common/Address.md");
    expect(paths).toContain("api/enterprise/party/Address.md");
    const index = out.find((f) => f.path === "api/README.md")!.content;
    expect(index).toContain("(./core/common/Address.md)");
    expect(index).toContain("(./enterprise/party/Address.md)");
    expect(index).toContain("Address (core::common)");
    expect(index).toContain("Address (enterprise::party)");
  });

  it("a unique short name keeps its bare label", async () => {
    const out = await docsFile().generate(makeCtx(await loadRoot([value("acme::shop", "Cart")])));
    const readme = out.find((f) => f.path === "README.md")!.content;
    expect(readme).toContain("[Cart](./acme/shop/Cart.md)");
  });

  it("names that differ only in case, in one package, are refused rather than overwritten", async () => {
    const root = await loadRoot([value("acme::products", "ProductNdc"), value("acme::products", "ProductNDC")]);
    for (const gen of [docsFile(), apiDocsFile()]) {
      let err: Error | undefined;
      try {
        await gen.generate(makeCtx(root));
      } catch (e) {
        err = e as Error;
      }
      expect(err, `${gen.name}: expected a refusal`).toBeDefined();
      expect(err!.message).toContain("acme::products::ProductNdc");
      expect(err!.message).toContain("acme::products::ProductNDC");
      expect(err!.message).toContain("case-insensitive");
    }
  });
});
