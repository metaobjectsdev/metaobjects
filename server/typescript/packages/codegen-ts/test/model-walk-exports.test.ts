// The model-walking helpers a from-scratch generator needs are reachable from the PACKAGE
// ROOT — the only import an owned generator is promised (ADR-0034 Amendment 4).
//
// Measured 2026-09-26 by writing a JSON Schema and an OpenAPI generator from nothing: the
// author needed the enum members, the target of a `field.object`, PascalCase/camelCase and
// the served REST address, and every one of them was either package-internal or answerable
// only by re-deriving a rule the engine already owns (a bare-name `@objectRef` match is the
// ADR-0042 bug; a hand-built URL is the #? three-doors bug `servedPath` exists to end).
// Imported from "../src/index.js" deliberately: the test is that the ROOT exports them.
import { describe, expect, test } from "bun:test";
import { InMemoryStringSource, MetaDataLoader, type MetaRoot } from "@metaobjectsdev/metadata";
import {
  enumValues,
  objectRefTarget,
  pluralize,
  servedPath,
  toCamelCase,
  toPascalCase,
  toSnakeCase,
} from "../src/index.js";

const MODEL = JSON.stringify({
  metadata: {
    package: "shop",
    children: [
      { "object.value": { name: "Address", children: [{ "field.string": { name: "city" } }] } },
      {
        "object.entity": {
          name: "Base",
          abstract: true,
          children: [
            { "field.long": { name: "id" } },
            { "field.object": { name: "home", "@objectRef": "Address" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
      {
        "object.entity": {
          name: "OrderLine",
          extends: "Base",
          children: [
            { "source.rdb": { "@table": "order_lines" } },
            { "field.enum": { name: "status", "@values": ["open", "paid"] } },
          ],
        },
      },
    ],
  },
});

// A same-named object in ANOTHER package: a bare-name lookup would be ambiguous here, and the
// package-local rule (ADR-0042) must pick shop::Address for a field declared in `shop`.
const DECOY = JSON.stringify({
  metadata: {
    package: "other",
    children: [{ "object.value": { name: "Address", children: [{ "field.string": { name: "zip" } }] } }],
  },
});

async function load(): Promise<MetaRoot> {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(DECOY, { id: "decoy.json" }),
    new InMemoryStringSource(MODEL, { id: "shop.json" }),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}

describe("model-walking helpers are public", () => {
  test("objectRefTarget resolves package-locally, through an inherited field", async () => {
    const root = await load();
    const line = root.findObject("OrderLine")!;
    const home = line.fields().find((f) => f.name === "home")!;   // inherited from Base
    const target = objectRefTarget(home);
    expect(target?.resolutionKey()).toBe("shop::Address");
  });

  test("objectRefTarget is undefined for a scalar field", async () => {
    const root = await load();
    const id = root.findObject("OrderLine")!.fields().find((f) => f.name === "id")!;
    expect(objectRefTarget(id)).toBeUndefined();
  });

  test("enumValues returns the declared members", async () => {
    const root = await load();
    const status = root.findObject("OrderLine")!.fields().find((f) => f.name === "status")!;
    expect(enumValues(status)).toEqual(["open", "paid"]);
  });

  test("servedPath is the prefix plus the cross-port collection segment", async () => {
    const root = await load();
    expect(servedPath(root.findObject("OrderLine")!, "/api")).toBe("/api/order_lines");
  });

  // The engine's own case helpers, with their exact (narrow) contracts pinned so the docs
  // that name them cannot overstate them.
  test("case helpers", () => {
    expect(toCamelCase("order_line")).toBe("orderLine");     // snake → camel
    expect(toPascalCase("orderLine")).toBe("OrderLine");     // capitalise the first char
    expect(toSnakeCase("OrderLine")).toBe("order_line");
    expect(pluralize("category")).toBe("categories");
  });
});
