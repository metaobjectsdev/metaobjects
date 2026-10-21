// A fractional field must be submittable from the generated form.
//
// `<input type="number">` with no `step` has an implicit step of 1, so the browser's native
// validation refuses `12.5` ("enter a valid value"). Both form tiers (the `<Entity>` meta
// spread by `useEntityForm`, and the nested sub-form in codegen-ts-react) now agree:
//   double / float -> type="number" step="any"
//   decimal        -> type="text" inputMode="decimal" (a number input parses to a double, which
//                     is wrong past 15 digits; the value stays a string on the wire)
//   int / long / currency -> type="number", step left at its default of 1.

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { renderEntityConstants } from "../src/templates/entity-constants.js";
import { numericInputControl } from "../src/templates/field-meta.js";

const TEMP_DIRS: string[] = [];
afterAll(() => {
  for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true });
});

const MODEL = {
  "metadata.root": {
    package: "shop",
    children: [
      {
        "object.entity": {
          name: "Item",
          children: [
            { "source.rdb": { "@table": "items" } },
            { "field.long": { name: "id" } },
            { "field.int": { name: "qty" } },
            { "field.double": { name: "weight" } },
            { "field.float": { name: "ratio" } },
            { "field.decimal": { name: "price", "@precision": 12, "@scale": 2 } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
    ],
  },
};

type Meta = { htmlType?: string; step?: string; inputMode?: string };

describe("form descriptor — fractional inputs", () => {
  test("emitted meta carries step / inputMode by subtype", async () => {
    const loaded = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(MODEL))]);
    expect(loaded.errors.map((e) => e.message)).toEqual([]);
    const item = loaded.root.findObject("Item");
    if (item === undefined) throw new Error("Item not loaded");
    const dir = mkdtempSync(join(import.meta.dir, "tmp-form-frac-"));
    TEMP_DIRS.push(dir);
    const file = join(dir, "Item.constants.ts");
    writeFileSync(file, renderEntityConstants(item, "/api").toString());
    const mod = (await import(pathToFileURL(file).href)) as { Item: Record<string, Meta> };
    expect(mod.Item.qty).toMatchObject({ htmlType: "number" });
    expect(mod.Item.qty?.step).toBeUndefined();
    expect(mod.Item.weight).toMatchObject({ htmlType: "number", step: "any" });
    expect(mod.Item.ratio).toMatchObject({ htmlType: "number", step: "any" });
    expect(mod.Item.price).toMatchObject({ htmlType: "text", inputMode: "decimal" });
    expect(mod.Item.price?.step).toBeUndefined();
  });

  test("the shared helper is what both tiers call", () => {
    expect(numericInputControl("int")).toEqual({ htmlType: "number" });
    expect(numericInputControl("long")).toEqual({ htmlType: "number" });
    expect(numericInputControl("currency")).toEqual({ htmlType: "number" });
    expect(numericInputControl("double")).toEqual({ htmlType: "number", step: "any" });
    expect(numericInputControl("float")).toEqual({ htmlType: "number", step: "any" });
    expect(numericInputControl("decimal")).toEqual({ htmlType: "text", inputMode: "decimal" });
    expect(numericInputControl("string")).toBeUndefined();
  });
});
