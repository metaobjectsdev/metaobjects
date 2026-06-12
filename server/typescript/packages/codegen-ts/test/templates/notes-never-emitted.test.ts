// D5 cross-template guard — no MetaObjects TS codegen template emits @notes content.
//
// readDocAttrs intentionally omits notes, so this passes by construction today.
// The point of the test is to keep it that way: if any new template ever wires
// notes into its output, CI catches it here regardless of where it slipped in.

import { describe, expect, test } from "bun:test";
import {
  MetaDataLoader,
  InMemoryStringSource,
} from "@metaobjectsdev/metadata";
import { renderEntityFile } from "../../src/templates/entity-file.js";
import { renderZodValidators } from "../../src/templates/zod-validators.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";

const NOTES_MARKER = "__INTERNAL_NOTES_MARKER__";

const fixtureJson = {
  "metadata.root": {
    package: "acme",
    children: [
      {
        "object.entity": {
          name: "Subscriber",
          "@description": "Public-facing description.",
          "@notes": NOTES_MARKER,
          children: [
            { "field.long": { name: "id", "@notes": NOTES_MARKER } },
            {
              "field.string": {
                name: "email",
                "@description": "User email.",
                "@notes": NOTES_MARKER,
              },
            },
            {
              "identity.primary": {
                "name": "id",
                "@fields": "id",
                "@generation": "increment",
                "@notes": NOTES_MARKER,
              },
            },
          ],
        },
      },
    ],
  },
};

describe("D5: @notes never reaches user-facing TS codegen output", () => {
  test("renderEntityFile output omits @notes content", async () => {
    const result = await new MetaDataLoader().load([
      new InMemoryStringSource(JSON.stringify(fixtureJson)),
    ]);
    expect(result.errors).toEqual([]);
    const root = result.root;
    const entity = root.objects()[0]!;
    const ctx = makeRenderContext({
      dialect: "sqlite",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    expect(renderEntityFile(entity, ctx)).not.toContain(NOTES_MARKER);
  });

  test("renderZodValidators output omits @notes content", async () => {
    const result = await new MetaDataLoader().load([
      new InMemoryStringSource(JSON.stringify(fixtureJson)),
    ]);
    expect(result.errors).toEqual([]);
    const entity = result.root.objects()[0]!;
    expect(renderZodValidators(entity).toString()).not.toContain(NOTES_MARKER);
  });
});
