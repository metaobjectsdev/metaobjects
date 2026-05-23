import { describe, test, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemorySource } from "../src/loader/meta-data-source.js";
import { canonicalSerialize } from "../src/serializer-json.js";
import { TYPE_TEMPLATE } from "../src/shared/base-types.js";
import {
  TEMPLATE_SUBTYPE_PROMPT,
  TEMPLATE_SUBTYPE_OUTPUT,
} from "../src/template/template-constants.js";

async function load(children: unknown[]) {
  const loader = new MetaDataLoader();
  const json = JSON.stringify({ "metadata.root": { package: "test", children } });
  const result = await loader.load([new InMemorySource(json)]);
  return { errors: result.errors.map((e) => e.message), root: result.root };
}

describe("template.* metatype", () => {
  test("template is a registered base type", () => {
    expect(TYPE_TEMPLATE).toBe("template");
  });

  test("subtype constants", () => {
    expect(TEMPLATE_SUBTYPE_PROMPT).toBe("prompt");
    expect(TEMPLATE_SUBTYPE_OUTPUT).toBe("output");
  });

  test("loads template.prompt + template.output with no errors", async () => {
    const { errors } = await load([
      { "object.value": { name: "AuthorBrief", children: [{ "field.string": { name: "displayName" } }] } },
      {
        "template.output": {
          name: "digest",
          "@payloadRef": "AuthorBrief",
          "@textRef": "email/digest",
          "@format": "html",
        },
      },
      {
        "template.prompt": {
          name: "strategy",
          "@payloadRef": "AuthorBrief",
          "@textRef": "prompt/strategy",
          "@format": "xml",
          "@maxTokens": 4000,
        },
      },
    ]);
    expect(errors).toEqual([]);
  });

  test("round-trips template nodes through the canonical serializer", async () => {
    const { root } = await load([
      { "template.prompt": { name: "strategy", "@payloadRef": "P", "@textRef": "prompt/strategy", "@format": "xml" } },
    ]);
    const out = JSON.parse(canonicalSerialize(root));
    const kids = out["metadata.root"].children as Array<Record<string, any>>;
    const node = kids.find((c) => c["template.prompt"])!;
    expect(node["template.prompt"]["@payloadRef"]).toBe("P");
    expect(node["template.prompt"]["@format"]).toBe("xml");
  });

  test("template.prompt missing required @payloadRef → error", async () => {
    const { errors } = await load([
      { "template.prompt": { name: "bad", "@textRef": "prompt/x", "@format": "xml" } },
    ]);
    expect(errors.length).toBeGreaterThan(0);
  });

  test("template.output missing required @textRef → error", async () => {
    const { errors } = await load([
      { "template.output": { name: "bad", "@payloadRef": "P", "@format": "html" } },
    ]);
    expect(errors.length).toBeGreaterThan(0);
  });

  test("@format outside allowedValues → error", async () => {
    const { errors } = await load([
      { "template.output": { name: "x", "@payloadRef": "P", "@textRef": "r", "@format": "potato" } },
    ]);
    expect(errors.length).toBeGreaterThan(0);
  });

  test("unknown template subtype → error", async () => {
    const { errors } = await load([
      { "template.bogus": { name: "x", "@payloadRef": "P", "@textRef": "r" } },
    ]);
    expect(errors.length).toBeGreaterThan(0);
  });
});
