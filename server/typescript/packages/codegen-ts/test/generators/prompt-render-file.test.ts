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
      { "object.entity": { name: "Foo", children: [{ "field.string": { name: "id" } }, { "identity.primary": { "name": "id", "@fields": "id" } }] } },
    ]);
    const gen = promptRender();
    const out = await gen.generate(makeCtx(root));
    expect(out).toEqual([]);
  });

  test("emits one file of render handles that import each payload's own interface (ADR-0056)", async () => {
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
    // The payload type is the value object's OWN interface, declared by entityFile() in its
    // module — imported, never re-declared here.
    expect(out[0]!.content).toContain('import type { NpcPromptPayload } from "./NpcPromptPayload.js";');
    expect(out[0]!.content).not.toContain("export interface");
    expect(out[0]!.content).toContain(
      "export function renderNpcTurn(payload: NpcPromptPayload, provider: Provider): string",
    );
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

  test("emits nothing when there are value objects but no prompts (it declares no types)", async () => {
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
    expect(out).toEqual([]);
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

  test("never imports a payloads.js module no generator emits", async () => {
    const root = await loadRoot([
      { "object.value": { name: "P", children: [{ "field.string": { name: "x", "@required": true } }] } },
      { "template.prompt": { name: "p1", "@payloadRef": "P", "@textRef": "p/1", "@format": "text" } },
    ]);
    const out = await promptRender().generate(makeCtx(root));
    expect(out[0]!.content).not.toContain('from "./payloads.js"');
  });

  test("declares no nested interface either — a shared nested value object stays in its own module", async () => {
    // Two payloads each reference a Lens. ADR-0056: none of the three shapes is declared here;
    // the handles import PayloadA / PayloadB, and Lens stays in the module entityFile() writes.
    const root = await loadRoot([
      {
        "object.value": {
          name: "Lens",
          children: [
            { "field.string": { name: "participantId" } },
            { "field.string": { name: "participantName" } },
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
    expect(content).not.toContain("export interface");
    expect(content).toContain('import type { PayloadA } from "./PayloadA.js";');
    expect(content).toContain('import type { PayloadB } from "./PayloadB.js";');
    expect(content).not.toContain("Lens");
  });
});
