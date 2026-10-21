// agent/ui.md states how a fractional field is entered: the type, plus step or inputMode when set.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaRoot } from "@metaobjectsdev/metadata";
import { agentDocsFile } from "../src/generators/agent-docs-file.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import type { GenContext } from "../src/generator.js";

async function load(model: unknown): Promise<MetaRoot> {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(model), { id: "meta.json", format: "json" }),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}

// `includeUiTier` defaults TRUE here because every model below describes a project whose
// suite emits forms and hooks; the page is gated on the RUN, not on the metadata, so the
// helper has to state which run it is. The false case is its own test.
function makeCtx(root: MetaRoot, apiPrefix = "", includeUiTier = true): GenContext {
  return {
    entities: root.objects(),
    loadedRoot: root,
    matches: () => true,
    config: { outDir: "/tmp", extStyle: "none", dbImport: "~/db", dialect: "sqlite", includeUiTier } as never,
    renderContext: makeRenderContext({
      dialect: "sqlite",
      loadedRoot: root,
      outDir: "/tmp",
      dbImport: "~/db",
      apiPrefix,
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    }),
    warn: () => {},
  };
}

async function emit(
  root: MetaRoot,
  opts?: Parameters<typeof agentDocsFile>[0],
  apiPrefix = "",
  includeUiTier = true,
): Promise<Map<string, string>> {
  const files = await agentDocsFile(opts).generate(makeCtx(root, apiPrefix, includeUiTier));
  return new Map(files.map((f) => [f.path, f.content]));
}

const MODEL = {
  "metadata.root": {
    package: "acme::shop",
    children: [
      {
        "object.entity": {
          name: "Item",
          children: [
            { "source.rdb": { "@table": "items" } },
            { "field.long": { name: "id", "@required": true } },
            { "field.int": { name: "qty" } },
            { "field.double": { name: "weight" } },
            { "field.decimal": { name: "price", "@precision": 12, "@scale": 2 } },
            { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
          ],
        },
      },
    ],
  },
};

describe("agent/ui.md — the HTML type cell carries step and inputMode", () => {
  test("decimal is text with inputMode, double is number with step, int is plain number", async () => {
    const ui = (await emit(await load(MODEL))).get("agent/ui.md") ?? "";
    const cells = (name: string): string[] =>
      (ui.split("\n").find((l) => l.startsWith(`| \`${name}\``)) ?? "").split("|").map((c) => c.trim());
    expect(cells("price")[4]).toBe("`text` (inputMode `decimal`)");
    expect(cells("weight")[4]).toBe("`number` (step `any`)");
    expect(cells("qty")[4]).toBe("`number`");
  });
});
