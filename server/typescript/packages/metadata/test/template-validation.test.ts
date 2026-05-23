import { describe, test, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemorySource } from "../src/loader/meta-data-source.js";

async function load(children: unknown[]) {
  const loader = new MetaDataLoader();
  const json = JSON.stringify({ "metadata.root": { package: "test", children } });
  const result = await loader.load([new InMemorySource(json)]);
  return result.errors.map((e) => ({ code: e.code, message: e.message }));
}

const authorBrief = {
  "object.value": { name: "AuthorBrief", children: [{ "field.string": { name: "displayName" } }] },
};

describe("template load-time validation", () => {
  test("@payloadRef resolving to a real object.value + @requiredSlots that are fields → no errors", async () => {
    const errs = await load([
      authorBrief,
      {
        "template.prompt": {
          name: "strategy",
          "@payloadRef": "AuthorBrief",
          "@textRef": "prompt/strategy",
          "@format": "xml",
          "@requiredSlots": ["displayName"],
        },
      },
    ]);
    expect(errs).toEqual([]);
  });

  test("@payloadRef that doesn't resolve → ERR_INVALID_TEMPLATE", async () => {
    const errs = await load([
      authorBrief,
      { "template.prompt": { name: "bad", "@payloadRef": "NoSuchPayload", "@textRef": "p/x" } },
    ]);
    expect(errs.map((e) => e.code)).toContain("ERR_INVALID_TEMPLATE");
  });

  test("@requiredSlots referencing a non-field on the payload → ERR_INVALID_TEMPLATE", async () => {
    const errs = await load([
      authorBrief,
      {
        "template.prompt": {
          name: "bad",
          "@payloadRef": "AuthorBrief",
          "@textRef": "p/x",
          "@requiredSlots": ["displayName", "notAField"],
        },
      },
    ]);
    expect(errs.map((e) => e.code)).toContain("ERR_INVALID_TEMPLATE");
  });
});
