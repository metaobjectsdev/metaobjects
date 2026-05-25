import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { mermaidErDiagram } from "../../src/generators/mermaid-er.js";
import type { GenContext } from "../../src/generator.js";

async function loadRoot() {
  const result = await new MetaDataLoader().load([
    new InMemoryStringSource(
      JSON.stringify({
        "metadata.root": {
          children: [
            {
              "object.entity": {
                name: "User",
                "@description": "A user.",
                children: [
                  { "field.long": { name: "id" } },
                  { "identity.primary": { "@fields": "id", "@generation": "increment" } },
                ],
              },
            },
          ],
        },
      }),
    ),
  ]);
  expect(result.errors).toEqual([]);
  return result.root;
}

function makeCtx(root: Awaited<ReturnType<typeof loadRoot>>): GenContext {
  return {
    entities: root.objects().filter((o) => o.isEntity()),
    loadedRoot: root,
    matches: () => true,
    config: {} as never,
    warn: () => {},
  };
}

describe("mermaidErDiagram() generator factory", () => {
  test("returns a Generator that emits one file at the default outFile", async () => {
    const gen = mermaidErDiagram();
    const root = await loadRoot();
    const files = await gen.generate(makeCtx(root));
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("docs/model.md");
    expect(files[0]!.content).toContain("```mermaid");
  });

  test("honors a custom outFile", async () => {
    const gen = mermaidErDiagram({ outFile: "docs/erd.md" });
    const root = await loadRoot();
    const files = await gen.generate(makeCtx(root));
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("docs/erd.md");
  });

  test("respects opts.target", async () => {
    const gen = mermaidErDiagram({ target: "site" });
    expect(gen.target).toBe("site");
  });
});
