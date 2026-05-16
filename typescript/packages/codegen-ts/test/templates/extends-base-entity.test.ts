import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemorySource } from "@metaobjects/metadata";
import { renderEntityFile } from "../../src/templates/entity-file.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";

async function loadFixture() {
  const result = await new MetaDataLoader().load([new InMemorySource(
    JSON.stringify({
      "metadata.root": {
        package: "test",
        children: [
          {
            "object.entity": {
              name: "BaseEntity",
              abstract: true,
              children: [
                { "field.long": { name: "id", "@dbColumn": "id" } },
                {
                  "field.timestamp": {
                    name: "createdAt",
                    "@dbColumn": "created_at",
                  },
                },
                { "identity.primary": { "@fields": "id" } },
              ],
            },
          },
          {
            "object.entity": {
              name: "Program",
              extends: "BaseEntity",
              children: [
                { "source.dbTable": { "@name": "programs" } },
                { "field.string": { name: "title", "@dbColumn": "title" } },
              ],
            },
          },
        ],
      },
    }),
  )]);

  if (result.errors.length > 0) {
    throw new Error(
      `Loader errors:\n${result.errors.map((e: Error) => e.message).join("\n")}`,
    );
  }

  const root = result.root;
  const program = root.children().find((o) => o.name === "Program")!;

  const ctx = makeRenderContext({
    dialect: "sqlite",
    loadedRoot: root,
    outDir: "/x",
    dbImport: "~/db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });

  return { root, program, ctx };
}

describe("entity extending BaseEntity — codegen inheritance", () => {
  test("emitted entity file includes own field + inherited fields from BaseEntity", async () => {
    const { program, ctx } = await loadFixture();
    const code = renderEntityFile(program, ctx);
    expect(code).toContain("title"); // own field
    expect(code).toContain("id"); // inherited from BaseEntity
    expect(code).toContain("createdAt"); // inherited from BaseEntity
  });

  test("emitted entity file declares the primary identity inherited from BaseEntity", async () => {
    const { program, ctx } = await loadFixture();
    const code = renderEntityFile(program, ctx);
    // The drizzle schema should reference id as the primary key
    expect(code).toMatch(/primaryKey|integer\(['"]id['"][^)]*\)\.primaryKey/i);
  });
});
