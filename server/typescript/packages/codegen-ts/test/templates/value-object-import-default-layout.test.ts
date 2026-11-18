// rc.19 fix round 2 (N2): a ctx-less valueObjectImport resolves under the default layout
// (DEFAULT_OUTPUT_LAYOUT, "flat"), like every other fallback.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { valueObjectImport } from "../../src/templates/value-object-import.js";

describe("valueObjectImport without a render context", () => {
  test("names the value object's module in the flat output directory", async () => {
    const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify({
      "metadata.root": { package: "acme::blog", children: [
        { "object.value": { name: "Address", children: [{ "field.string": { name: "street" } }] } },
      ] },
    }))]);
    expect(errors).toEqual([]);
    const vo = root.children().find((c) => c.name === "Address")!;
    // A file at the root of outDir importing acme::blog's Address.
    expect(valueObjectImport(undefined, vo, "index.ts").specifier).toBe("./Address.js");
  });
});
