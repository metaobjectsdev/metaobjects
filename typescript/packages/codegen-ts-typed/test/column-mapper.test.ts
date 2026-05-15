import { describe, it, expect } from "bun:test";
import { Loader, metaOf } from "@metaobjects/metadata";
import type { MetaRoot, MetaObject } from "@metaobjects/metadata";
import { mapColumnType } from "../src/column-mapper.js";

function loadField(json: string, entityName: string, fieldName: string) {
  const { root, errors } = new Loader().loadJson(json);
  if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
  const meta = metaOf(root) as MetaRoot;
  const entity = meta.findObject(entityName) as MetaObject;
  const field = entity.findField(fieldName);
  if (!field) throw new Error(`field ${fieldName} not found`);
  return field;
}

const SAMPLE = JSON.stringify({
  metadata: {
    package: "acme",
    children: [{
      object: {
        name: "Widget", subType: "entity",
        children: [
          { field: { name: "id", subType: "long" } },
          { field: { name: "label", subType: "string", "@maxLength": 80 } },
          { field: { name: "active", subType: "boolean", "@required": true } },
          { identity: { subType: "primary", "@fields": "id" } },
        ],
      },
    }],
  },
});

describe("mapColumnType — typed MetaField", () => {
  it("maps a long field to sqlite integer", () => {
    const spec = mapColumnType(loadField(SAMPLE, "Widget", "id"), "sqlite", "snake_case");
    expect(spec.fnName).toBe("integer");
    expect(spec.dbName).toBe("id");
  });

  it("maps a string field with @maxLength to postgres varchar", () => {
    const spec = mapColumnType(loadField(SAMPLE, "Widget", "label"), "postgres", "snake_case");
    expect(spec.fnName).toBe("varchar");
    expect(spec.fnOptions).toEqual({ length: 80 });
  });

  it("a @required field gets .notNull()", () => {
    const spec = mapColumnType(loadField(SAMPLE, "Widget", "active"), "sqlite", "snake_case");
    expect(spec.modifiers).toContain(".notNull()");
  });
});
