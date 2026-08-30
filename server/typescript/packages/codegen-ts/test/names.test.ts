import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaObject } from "@metaobjectsdev/metadata";
import { resolveObjectNames } from "../src/names.js";

async function load(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "test", children } });
  const r = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (r.errors.length > 0) throw new Error(r.errors.map((e) => e.message).join("\n"));
  return r.root;
}
const obj = (root: Awaited<ReturnType<typeof load>>, name: string) =>
  root.children().find((c) => c.name === name) as MetaObject;

describe("resolveObjectNames", () => {
  test("carries kind and physical name, and both field names", async () => {
    const root = await load([{
      "object.entity": {
        name: "Subscriber",
        children: [
          { "source.rdb": { "@table": "subscribers" } },
          { "field.int": { name: "id" } },
          { "field.timestamp": { name: "createdAt", "@column": "created_at" } },
          { "identity.primary": { name: "id", "@fields": "id" } },
        ],
      },
    }]);
    const n = resolveObjectNames(obj(root, "Subscriber"), "snake_case");
    expect(n?.kind).toBe("table");
    expect(n?.name).toBe("subscribers");
    expect(n?.readOnly).toBe(false);
    // The collision the shape exists for: logical name != physical column.
    expect(n?.fields.createdAt).toEqual({ name: "createdAt", column: "created_at" });
  });

  test("a view-kind source is readOnly and keeps its own kind", async () => {
    // FR-024/ADR-0028 (ERR_ENTITY_PRIMARY_SOURCE_READONLY): an object.entity's PRIMARY
    // source must be writable — a read-only-kind primary source is only legal on an
    // object.projection ("a derived read model is an object.projection"). resolveObjectNames
    // itself is subtype-agnostic (it dispatches on the primary source, never the object
    // subtype — #248), so a projection exercises the readOnly branch without tripping that
    // loader rule.
    const root = await load([{
      "object.projection": {
        name: "Report",
        children: [
          { "source.rdb": { "@kind": "view", "@table": "v_report" } },
          { "field.int": { name: "id" } },
        ],
      },
    }]);
    const n = resolveObjectNames(obj(root, "Report"), "snake_case");
    expect(n?.kind).toBe("view");
    expect(n?.name).toBe("v_report");
    expect(n?.readOnly).toBe(true);
  });

  test("an object with no source resolves to undefined, not a phantom table", async () => {
    // #248: persistability derives from a declared source, never from the subtype.
    const root = await load([{
      "object.value": { name: "Money", children: [{ "field.long": { name: "cents" } }] },
    }]);
    expect(resolveObjectNames(obj(root, "Money"), "snake_case")).toBeUndefined();
  });

  test("an inherited @column resolves through extends", async () => {
    // ADR-0039: resolving accessors, so a concrete field inherits its parent's @column.
    const root = await load([
      {
        "object.entity": {
          name: "BaseThing",
          abstract: true,
          children: [{ "field.string": { name: "firstName", "@column": "given_name" } }],
        },
      },
      {
        "object.entity": {
          name: "Thing",
          extends: "BaseThing",
          children: [
            { "source.rdb": { "@table": "things" } },
            { "field.int": { name: "id" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
          ],
        },
      },
    ]);
    const n = resolveObjectNames(obj(root, "Thing"), "snake_case");
    expect(n?.fields.firstName?.column).toBe("given_name");
  });
});
