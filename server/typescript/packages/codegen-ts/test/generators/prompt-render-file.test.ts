import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { promptRender } from "../../src/generators/prompt-render-file.js";
import type { GenContext } from "../../src/generator.js";

async function loadRoot(children: unknown[]) {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(
      JSON.stringify({ "metadata.root": { package: "acme::ai", children } }),
      { id: "meta.json", format: "json" },
    ),
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
            { "field.string": { name: "name", "@required": true } },
            { "field.string": { name: "mood", "@required": true } },
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
      { "object.value": { name: "P", children: [{ "field.string": { name: "x", "@required": true } }] } },
      { "template.prompt": { name: "p1", "@payloadRef": "P", "@textRef": "p/1", "@format": "text" } },
    ]);
    const gen = promptRender({ outFile: "src/render/generated/prompts.ts" });
    const out = await gen.generate(makeCtx(root));
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe("src/render/generated/prompts.ts");
  });

  test("emits payload interface when there are payloads but no prompts", async () => {
    const root = await loadRoot([
      {
        "object.value": {
          name: "JustAPayload",
          children: [{ "field.string": { name: "msg", "@required": true } }],
        },
      },
    ]);
    const gen = promptRender();
    const out = await gen.generate(makeCtx(root));
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toContain("export interface JustAPayload");
    expect(out[0]!.content).toContain("msg: string;");
  });

  test("emits render handle when there are prompts but no payload VOs", async () => {
    // Note: a prompt without a resolvable @payloadRef may emit something specific;
    // this tests that the factory doesn't short-circuit when only prompts are present.
    // Declare a placeholder VO outside the test's filter to satisfy @payloadRef
    // resolution, then check that the prompt's render handle still emits.
    const root = await loadRoot([
      {
        "object.value": {
          name: "Holder",
          children: [{ "field.string": { name: "x", "@required": true } }],
        },
      },
      {
        "template.prompt": {
          name: "onlyPrompt",
          "@payloadRef": "Holder",
          "@textRef": "p/only",
          "@format": "text",
        },
      },
    ]);
    // Filter the factory to skip the Holder VO so we only test the prompt path.
    // (Use a custom filter to exclude object.value entities for this test.)
    const gen = promptRender({ outFile: "out.ts" });
    // Wrap ctx.matches to skip the Holder VO so payloads list is effectively empty.
    const ctx = makeCtx(root);
    const filteredCtx: typeof ctx = { ...ctx, matches: (e) => e.name !== "Holder" };
    const out = await gen.generate(filteredCtx);
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe("out.ts");
    expect(out[0]!.content).toMatch(/onlyPrompt/i);
  });

  test("output carries the @generated sentinel header", async () => {
    const root = await loadRoot([
      { "object.value": { name: "P", children: [{ "field.string": { name: "x", "@required": true } }] } },
      { "template.prompt": { name: "p1", "@payloadRef": "P", "@textRef": "p/1", "@format": "text" } },
    ]);
    const out = await promptRender().generate(makeCtx(root));
    expect(out[0]!.content).toContain("@generated by @metaobjectsdev/codegen-ts");
  });

  test("hoists the @metaobjectsdev/render import exactly once across many prompts", async () => {
    const root = await loadRoot([
      { "object.value": { name: "P", children: [{ "field.string": { name: "x", "@required": true } }] } },
      { "template.prompt": { name: "alpha",   "@payloadRef": "P", "@textRef": "p/a", "@format": "text" } },
      { "template.prompt": { name: "beta",    "@payloadRef": "P", "@textRef": "p/b", "@format": "text" } },
      { "template.prompt": { name: "gamma",   "@payloadRef": "P", "@textRef": "p/c", "@format": "text" } },
      { "template.prompt": { name: "delta",   "@payloadRef": "P", "@textRef": "p/d", "@format": "text" } },
    ]);
    const out = await promptRender().generate(makeCtx(root));
    const content = out[0]!.content;
    const renderImports = content.match(/import \{ render, type Provider \} from "@metaobjectsdev\/render";/g);
    expect(renderImports).toHaveLength(1);
    // Every render handle still emits its function body.
    expect(content).toMatch(/renderAlpha/);
    expect(content).toMatch(/renderBeta/);
    expect(content).toMatch(/renderGamma/);
    expect(content).toMatch(/renderDelta/);
  });

  test("strips the standalone payloads.js import that generateRenderHandle emits", async () => {
    const root = await loadRoot([
      { "object.value": { name: "P", children: [{ "field.string": { name: "x", "@required": true } }] } },
      { "template.prompt": { name: "p1", "@payloadRef": "P", "@textRef": "p/1", "@format": "text" } },
    ]);
    const out = await promptRender().generate(makeCtx(root));
    expect(out[0]!.content).not.toContain('from "./payloads.js"');
  });

  test("emits each shared nested payload interface exactly once across multiple payloads", async () => {
    // Two payloads each reference a Lens. The lens shape should appear in the
    // emitted file only once (no duplicate interface declaration).
    const root = await loadRoot([
      {
        "object.value": {
          name: "Lens",
          children: [
            { "field.string": { name: "wizardId" } },
            { "field.string": { name: "wizardName" } },
          ],
        },
      },
      {
        "object.value": {
          name: "PayloadA",
          children: [
            { "field.string": { name: "qa" } },
            { "field.object": { name: "items", "@objectRef": "Lens", isArray: true } },
          ],
        },
      },
      {
        "object.value": {
          name: "PayloadB",
          children: [
            { "field.string": { name: "qb" } },
            { "field.object": { name: "items", "@objectRef": "Lens", isArray: true } },
          ],
        },
      },
      { "template.prompt": { name: "a", "@payloadRef": "PayloadA", "@textRef": "p/a", "@format": "text" } },
      { "template.prompt": { name: "b", "@payloadRef": "PayloadB", "@textRef": "p/b", "@format": "text" } },
    ]);
    const out = await promptRender().generate(makeCtx(root));
    const content = out[0]!.content;
    const lensMatches = content.match(/export interface Lens \{/g);
    expect(lensMatches).toHaveLength(1);
    // Sanity: both payload interfaces still emit.
    expect(content).toContain("export interface PayloadA {");
    expect(content).toContain("export interface PayloadB {");
  });
});
