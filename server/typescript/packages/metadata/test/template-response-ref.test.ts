import { describe, test, expect } from "bun:test";
import { MetaDataLoader } from "../src/index.ts";

function meta(responseRef: string) {
  return JSON.stringify({
    "metadata.root": { package: "t::ai", children: [
      { "object.value": { name: "ReqVO", children: [{ "field.string": { name: "q" } }] } },
      { "object.value": { name: "ResVO", children: [{ "field.string": { name: "a" } }] } },
      { "template.prompt": { name: "P", "@payloadRef": "ReqVO", "@responseRef": responseRef, "@textRef": "p/x", "@format": "xml" } },
    ] },
  });
}

describe("template.prompt @responseRef", () => {
  test("resolves to an object.value", async () => {
    const r = await MetaDataLoader.fromString(meta("ResVO"), "json");
    expect(r.errors).toEqual([]);
    const prompt = r.root.ownChildren().find((c: { name: string }) => c.name === "P")!;
    expect(prompt.ownAttr("responseRef")).toBe("ResVO");
  });
  test("unresolved @responseRef is a loader error", async () => {
    const r = await MetaDataLoader.fromString(meta("NoSuchVO"), "json");
    expect(r.errors.some((e: { code?: string }) => e.code === "ERR_INVALID_TEMPLATE")).toBe(true);
  });
});
