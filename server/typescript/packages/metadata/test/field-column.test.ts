import { describe, expect, test } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { MetaObject } from "../src/core/object/meta-object.js";
import { MetaField } from "../src/core/field/meta-field.js";
import { resolveColumnName } from "../src/naming.js";

async function loadDoc(doc: unknown) {
  return new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(doc))]);
}

const meta = {
  "metadata.root": {
    package: "acme",
    children: [
      {
        "object.entity": {
          name: "P",
          children: [
            { "source.rdb": { "@table": "p" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "firstName", "@column": "first_name" } },
            { "field.string": { name: "lastName" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
          ],
        },
      },
    ],
  },
};

describe("field @column", () => {
  test("@column round-trips and resolveColumnName prefers it", async () => {
    const { root, errors } = await loadDoc(meta);
    expect(errors).toHaveLength(0);
    const p = root
      .ownChildren()
      .find((o) => o.name === "P") as MetaObject;
    expect(p).toBeDefined();
    const firstName = p.fields().find((f) => f.name === "firstName") as MetaField;
    const lastName = p.fields().find((f) => f.name === "lastName") as MetaField;
    expect(firstName).toBeDefined();
    expect(lastName).toBeDefined();
    // @column attr is stored and resolveColumnName returns it
    expect(resolveColumnName(firstName)).toBe("first_name");
    // getter also returns it
    expect(firstName.column).toBe("first_name");
    // no @column → derived from name via snake_case
    expect(resolveColumnName(lastName)).toBe("last_name");
    expect(lastName.column).toBeUndefined();
  });
});
