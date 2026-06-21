// Two codegen-correctness gates, both exercised via a YAML model (which qualifies
// reference targets to the FQN and uses field-level `extends`):
//
//  1. Field-attribute reads must be EFFECTIVE (own OR inherited via `extends`),
//     not own-only — so an abstract field's `required` / `maxLength` flow into a
//     concrete field that extends it. Reading via ownAttr() silently dropped them.
//  2. An FK whose `@references` resolves to a package-qualified target (as the
//     YAML loader produces) must still emit `.references()` — buildFkMap must
//     strip the package before the target lookup.

import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { renderDrizzleSchema } from "../src/templates/drizzle-schema.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";

const FIXTURE = resolve(import.meta.dir, "fixtures/field-extends-attr.yaml");

async function renderWidget(): Promise<string> {
  const loader = new MetaDataLoader();
  const res = await loader.load([new FileSource(FIXTURE)]);
  expect(res.errors).toEqual([]);
  const ctx = makeRenderContext({
    dialect: "postgres", loadedRoot: res.root, outDir: "/x", dbImport: "~/db",
    pkMap: buildPkMap(res.root), relationMap: buildRelationMap(res.root),
  });
  return renderDrizzleSchema(res.root.findObject("Widget")!, ctx).toString();
}

describe("field-level extends + qualified-ref codegen", () => {
  test("abstract field's required + maxLength are inherited (effective attrs)", async () => {
    const out = await renderWidget();
    // required → .notNull(); maxLength: 200 → varchar(..., { length: 200 }).
    expect(out).toContain('varchar("name", { length: 200 })');
    expect(out).toMatch(/name: varchar\("name", \{ length: 200 \}\)\.notNull\(\)/);
  });

  test("a package-qualified FK target still emits .references()", async () => {
    const out = await renderWidget();
    expect(out).toContain("ownerId: uuid(\"owner_id\").references(() => owners.id)");
  });
});
