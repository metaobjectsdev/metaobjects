// `meta gen --list` prints each generator's catalog description, and for the two inbound
// prompt-tier generators it had them backwards: `output-parser` read "tolerant" and
// `extractor` read "strict", while the emitted code is the other way round —
// `parse<Name>` is a strict JSON.parse + schema parse that throws on any mismatch, and
// `extract<Name>` runs the TOLERANT extract over dirty model text, throwing only when a
// @required field is lost (a cold external review of 1.0.9-rc.1 caught it). Pin each
// description against the behaviour of the code the generator actually emits.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaObject } from "@metaobjectsdev/metadata";
import { getGenerator } from "../src/generator-registry.js";
import { outputParser } from "../src/generators/output-parser-file.js";
import { extractor } from "../src/generators/extractor-file.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import type { GenContext, Generator } from "../src/generator.js";

const MODEL = {
  "metadata.root": {
    package: "t",
    children: [
      { "object.value": { name: "Req", children: [{ "field.string": { name: "q" } }] } },
      {
        "object.value": {
          name: "Answer",
          children: [
            { "field.string": { name: "summary", "@required": true } },
            { "field.double": { name: "score" } },
          ],
        },
      },
      {
        "template.prompt": {
          name: "Ask",
          "@payloadRef": "Req",
          "@responseRef": "Answer",
          "@textRef": "ask",
        },
      },
    ],
  },
};

async function emit(g: Generator): Promise<string> {
  const result = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(MODEL))]);
  expect(result.errors.map((e) => e.message)).toEqual([]);
  const root = result.root;
  const ctx: GenContext = {
    entities: root.objects(),
    loadedRoot: root,
    matches: (e: MetaObject) => g.filter?.(e) ?? true,
    projectRoot: "/tmp/x",
    config: { outDir: "/tmp/x", extStyle: "js", dbImport: "~/db", dialect: "postgres" } as never,
    renderContext: makeRenderContext({
      dialect: "postgres",
      loadedRoot: root,
      outDir: "/tmp/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    }),
    warn: () => {},
  };
  const files = await g.generate(ctx);
  expect(files.length).toBe(1);
  return files[0]!.content;
}

describe("catalog descriptions of the inbound prompt tier match the emitted code", () => {
  test("output-parser: a STRICT parse, plus a tolerant extractLenient", async () => {
    const src = await emit(outputParser());
    expect(src).toContain("Schema.parse(JSON.parse(text))");
    expect(src).toContain("export function extractLenientAsk");
    const d = getGenerator("output-parser")?.description ?? "";
    expect(d).toMatch(/\bstrict\b/i);
    expect(d).toMatch(/\btolerant\b/i);
    expect(d.indexOf("strict")).toBeLessThan(d.indexOf("tolerant"));
  });

  test("extractor: TOLERANT recovery, throwing only on a lost @required field", async () => {
    const src = await emit(extractor());
    expect(src).toContain("extractLenientAskWithLoader");
    expect(src).toContain("lostRequired()");
    const d = getGenerator("extractor")?.description ?? "";
    expect(d).toMatch(/\btolerant\b/i);
    expect(d).not.toMatch(/\bstrict\b/i);
    expect(d).toContain("@required");
  });
});
