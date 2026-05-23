import { describe, test, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemorySource } from "../src/loader/meta-data-source.js";
import { canonicalSerialize } from "../src/serializer-json.js";
import { TYPE_PROMPT } from "../src/shared/base-types.js";

// Loads a list of top-level nodes through the full MetaDataLoader pipeline.
async function load(children: unknown[]) {
  const loader = new MetaDataLoader();
  const json = JSON.stringify({ "metadata.root": { package: "test", children } });
  const result = await loader.load([new InMemorySource(json)]);
  return { errors: result.errors.map((e) => e.message), root: result.root };
}

// A minimal entity to sit alongside the prompt nodes.
const npc = {
  "object.entity": {
    name: "Npc",
    children: [
      { "field.string": { name: "name" } },
      { "identity.primary": { "@fields": "name" } },
    ],
  },
};

describe("prompt.* metatype", () => {
  test("prompt is a registered base type", () => {
    expect(TYPE_PROMPT).toBe("prompt");
  });

  test("loads prompt.template + prompt.fragment with no errors", async () => {
    const { errors } = await load([
      npc,
      { "prompt.fragment": { name: "combatRules", "@textRef": "common/combat-rules" } },
      {
        "prompt.template": {
          name: "npcTurn",
          "@payloadRef": "NpcPromptPayload",
          "@textRef": "npc/turn",
          "@outputFormat": "xml",
        },
      },
    ]);
    expect(errors).toEqual([]);
  });

  test("round-trips prompt nodes through the canonical serializer", async () => {
    const { root } = await load([
      npc,
      { "prompt.template": { name: "npcTurn", "@payloadRef": "P", "@textRef": "npc/turn" } },
    ]);
    const out = JSON.parse(canonicalSerialize(root));
    const kids = out["metadata.root"].children as Array<Record<string, any>>;
    const tmpl = kids.find((c) => c["prompt.template"])!;
    expect(tmpl["prompt.template"].name).toBe("npcTurn");
    expect(tmpl["prompt.template"]["@payloadRef"]).toBe("P");
    expect(tmpl["prompt.template"]["@textRef"]).toBe("npc/turn");
  });

  test("prompt.template missing required @payloadRef → error", async () => {
    const { errors } = await load([
      npc,
      { "prompt.template": { name: "bad", "@textRef": "npc/turn" } },
    ]);
    expect(errors.length).toBeGreaterThan(0);
  });

  test("prompt.fragment missing required @textRef → error", async () => {
    const { errors } = await load([npc, { "prompt.fragment": { name: "bad" } }]);
    expect(errors.length).toBeGreaterThan(0);
  });

  test("unknown prompt subtype → error", async () => {
    const { errors } = await load([
      npc,
      { "prompt.bogus": { name: "x", "@textRef": "y" } },
    ]);
    expect(errors.length).toBeGreaterThan(0);
  });
});
