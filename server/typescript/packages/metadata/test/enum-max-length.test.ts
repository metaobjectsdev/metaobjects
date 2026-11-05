// A string-stored field.enum's column length: its @maxLength, else the project's
// enums.maxLength (carried on the loaded root, like the naming rules), else none (an
// unbounded text column, as before). Every member must fit the length that applies; the
// loader checks an explicit @maxLength, and the resolver refuses a project default that a
// member overflows, so every consumer that sizes the column refuses the same model.

import { describe, expect, test } from "bun:test";
import {
  MetaDataLoader,
  InMemoryStringSource,
  MetaModelError,
  resolveEnumMaxLength,
  type MetaField,
  type MetaObject,
  type MetaRoot,
} from "../src/index.js";

async function load(statusDecl: Record<string, unknown>): Promise<MetaRoot> {
  const doc = { "metadata.root": { package: "acme", children: [
    { "object.entity": { name: "Order", children: [
      { "source.rdb": {} },
      { "field.long": { name: "id" } },
      { "field.enum": { name: "status", ...statusDecl } },
      { "identity.primary": { name: "pk", "@fields": "id" } },
    ] } },
  ] } };
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(doc))]);
  expect(errors).toEqual([]);
  return root as MetaRoot;
}

const status = (root: MetaRoot): MetaField =>
  (root.findObject("Order") as MetaObject).fields().find((f) => f.name === "status")!;

const VALUES = ["DRAFT", "PUBLISHED", "ARCHIVED"];

describe("resolveEnumMaxLength", () => {
  test("@maxLength is the column length", async () => {
    expect(resolveEnumMaxLength(status(await load({ "@values": VALUES, "@maxLength": 20 })))).toBe(20);
  });

  test("no @maxLength and no project default: none", async () => {
    expect(resolveEnumMaxLength(status(await load({ "@values": VALUES })))).toBeUndefined();
  });

  test("the project default applies when the field declares none", async () => {
    const root = await load({ "@values": VALUES });
    root.enumDefaults = { maxLength: 32 };
    expect(resolveEnumMaxLength(status(root))).toBe(32);
  });

  test("@maxLength beats the project default, either way round", async () => {
    const root = await load({ "@values": VALUES, "@maxLength": 9 });
    root.enumDefaults = { maxLength: 32 };
    expect(resolveEnumMaxLength(status(root))).toBe(9);
  });

  test("an @intValueMap enum has no length, whatever the default", async () => {
    const root = await load({ "@values": VALUES, "@intValueMap": { DRAFT: 0, PUBLISHED: 1, ARCHIVED: 2 } });
    root.enumDefaults = { maxLength: 4 };
    expect(resolveEnumMaxLength(status(root))).toBeUndefined();
  });

  test("a member longer than the project default is refused, naming the field and the member", async () => {
    const root = await load({ "@values": ["DRAFT", "AWAITING_REVIEW"] });
    root.enumDefaults = { maxLength: 9 };
    expect(() => resolveEnumMaxLength(status(root))).toThrow(MetaModelError);
    expect(() => resolveEnumMaxLength(status(root))).toThrow(/"Order\.status".*"AWAITING_REVIEW".*enums\.maxLength 9/);
  });
});
