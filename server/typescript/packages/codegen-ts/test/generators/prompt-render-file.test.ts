import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemorySource } from "@metaobjectsdev/metadata";
import { promptRender } from "../../src/generators/prompt-render-file.js";
import type { GenContext } from "../../src/generator.js";

async function loadRoot(children: unknown[]) {
  const res = await new MetaDataLoader().load([
    new InMemorySource(JSON.stringify({ "metadata.root": { package: "acme::ai", children } })),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}

function makeCtx(root: Awaited<ReturnType<typeof loadRoot>>): GenContext {
  return {
    entities: root.objects(),
    loadedRoot: root,
    matches: () => true,
    config: { outDir: "/tmp/out", dialect: "sqlite" } as never,
    warn: () => {},
  };
}

describe("promptRender() factory", () => {
  test("emits no files when metadata has no payloads and no prompts", async () => {
    const root = await loadRoot([
      { "object.entity": { name: "Foo", children: [{ "field.string": { name: "id" } }, { "identity.primary": { "@fields": "id" } }] } },
    ]);
    const gen = promptRender();
    const out = await gen.generate(makeCtx(root));
    expect(out).toEqual([]);
  });

  test("emits one file aggregating payload interfaces + render handles", async () => {
    const root = await loadRoot([
      {
        "object.value": {
          name: "NpcPromptPayload",
          children: [
            { "field.string": { name: "name" } },
            { "field.string": { name: "mood" } },
          ],
        },
      },
      {
        "template.prompt": {
          name: "npcTurn",
          "@payloadRef": "NpcPromptPayload",
          "@textRef": "npc/turn",
          "@format": "xml",
        },
      },
    ]);
    const gen = promptRender();
    const out = await gen.generate(makeCtx(root));
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe("prompts.ts");
    expect(out[0]!.content).toContain("export interface NpcPromptPayload");
    expect(out[0]!.content).toContain("name: string;");
    expect(out[0]!.content).toContain("mood: string;");
    expect(out[0]!.content).toMatch(/npcTurn/i);
  });

  test("honors a custom outFile option", async () => {
    const root = await loadRoot([
      { "object.value": { name: "P", children: [{ "field.string": { name: "x" } }] } },
      { "template.prompt": { name: "p1", "@payloadRef": "P", "@textRef": "p/1", "@format": "text" } },
    ]);
    const gen = promptRender({ outFile: "src/render/generated/prompts.ts" });
    const out = await gen.generate(makeCtx(root));
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe("src/render/generated/prompts.ts");
  });
});
