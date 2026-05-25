// navigator.test.ts — exercises the bracket-segment grammar (`type[subType]`)
// in the navigate() helper (Fix 3b).

import { describe, expect, test } from "bun:test";
import { MetaDataLoader } from "../../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../../src/loader/meta-data-source.js";
import { navigate } from "./navigator.js";

// A minimal document containing an `identity.primary` child — this node has
// NO `name` attribute, so it is a nameless node that can only be addressed via
// the bracket segment grammar `identity[primary]`.
const DOC = JSON.stringify({
  "metadata.root": {
    "package": "test",
    "children": [
      {
        "object.entity": {
          "name": "Widget",
          "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": "id" } },
          ],
        },
      },
    ],
  },
});

async function loadTree() {
  const loader = new MetaDataLoader();
  const source = new InMemoryStringSource(DOC, { id: "meta.json", format: "json" });
  const result = await loader.load([source]);
  if (result.errors.length > 0) {
    throw new Error(
      `fixture load failed: ${result.errors.map((e) => e.message).join(", ")}`,
    );
  }
  return result.root;
}

describe("navigate — bracket segment grammar", () => {
  test("bracket segment `identity[primary]` reaches the nameless identity node", async () => {
    const root = await loadTree();
    // Navigate: root → object:Widget → identity[primary]
    const node = navigate(root, ["object:Widget", "identity[primary]"]);
    expect(node).toBeDefined();
    expect(node!.type).toBe("identity");
    expect(node!.subType).toBe("primary");
  });

  test("non-matching bracket segment `identity[secondary]` returns undefined", async () => {
    const root = await loadTree();
    // There is no secondary identity in the tree — navigate should return undefined.
    const node = navigate(root, ["object:Widget", "identity[secondary]"]);
    expect(node).toBeUndefined();
  });

  test("colon segment `object:Widget` still works alongside bracket segments", async () => {
    const root = await loadTree();
    const objectNode = navigate(root, ["object:Widget"]);
    expect(objectNode).toBeDefined();
    expect(objectNode!.name).toBe("Widget");
  });
});
