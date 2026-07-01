// ADR-0039 — own-accessor discipline. A concrete field/entity that `extends` an
// abstract base MUST inherit its properties + members through codegen. Reading a
// field's effective property (isArray / precision / scale / maxLength / @objectRef
// / @storage) or an entity's member set through an own-only accessor silently
// dropped everything inherited via `extends`. This gate renders the Drizzle schema
// for a fixture whose concrete `Contact` extends both an abstract `BaseEntity`
// (id/createdAt PK) and several abstract fields, and asserts the inherited values
// land in the generated output.
//
// Companion to the metadata-level conformance fixture
// fixtures/conformance/extends-abstract-field-inheritance (which gates the
// effective serializer). This one gates the codegen fan-out.

import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { renderDrizzleSchema } from "../src/templates/drizzle-schema.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";

const FIXTURE = resolve(import.meta.dir, "fixtures/extends-abstract-field-inheritance.yaml");

async function renderContact(): Promise<string> {
  const loader = new MetaDataLoader();
  const res = await loader.load([new FileSource(FIXTURE)]);
  expect(res.errors).toEqual([]);
  const ctx = makeRenderContext({
    dialect: "postgres", loadedRoot: res.root, outDir: "/x", dbImport: "~/db",
    pkMap: buildPkMap(res.root), relationMap: buildRelationMap(res.root),
  });
  return renderDrizzleSchema(res.root.findObject("Contact")!, ctx).toString();
}

describe("ADR-0039 — abstract-field/entity extends inheritance in codegen", () => {
  test("inherited isArray:true on a scalar field emits a native array column", async () => {
    const out = await renderContact();
    // field.string tags extends Tags (isArray:true, maxLength:40) → varchar[] array column.
    // The trailing .array() proves the inherited native isArray flag was resolved.
    expect(out).toMatch(/tags:\s*varchar\("tags",\s*\{\s*length:\s*40\s*\}\)\.array\(\)/);
  });

  test("inherited maxLength flows into the (array) element type", async () => {
    const out = await renderContact();
    // maxLength:40 is inherited from the abstract Tags field (effective attr).
    expect(out).toContain('varchar("tags", { length: 40 })');
  });

  test("inherited precision/scale on a decimal field emit numeric(12, 2)", async () => {
    const out = await renderContact();
    expect(out).toMatch(/balance:\s*numeric\("balance",\s*\{\s*precision:\s*12,\s*scale:\s*2\s*\}\)/);
  });

  test("inherited @objectRef + @storage:jsonb + isArray on field.object emit a jsonb column", async () => {
    const out = await renderContact();
    // addresses extends AddressBag (objectRef acme::Address, storage jsonb, isArray) → jsonb column.
    expect(out).toMatch(/addresses:\s*jsonb\("addresses"\)/);
  });

  test("BaseEntity's PK members are inherited (id present, PK-generated)", async () => {
    const out = await renderContact();
    // id + createdAt inherited from the abstract BaseEntity via extends.
    expect(out).toContain('id: uuid("id")');
    expect(out).toContain('createdAt: timestamp("created_at"');
    // id is the primary key (defaultRandom / primaryKey) — inherited identity.primary.
    expect(out).toMatch(/id: uuid\("id"\)[\s\S]*?\.primaryKey\(\)/);
  });
});
