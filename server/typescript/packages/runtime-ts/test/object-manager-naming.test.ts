// ADR-0058 — the ObjectManager's column names come from the project's one setting, carried by
// the loaded root, so they are the names codegen and `meta migrate` used. The 1.0 option that
// set them separately is refused rather than dropped.

import { guideUrl } from "@metaobjectsdev/metadata/release-docs";
// The guide links name the tag of the running release (a prerelease keeps main).
const BLOB = guideUrl("");
import { describe, expect, test } from "bun:test";
import { InMemoryStringSource, MetaDataLoader, type MetaRoot } from "@metaobjectsdev/metadata";
import { ObjectManager } from "../src/object-manager.js";
import { inMemoryDriver } from "../src/drivers/in-memory-driver.js";

const META = JSON.stringify({
  "metadata.root": {
    package: "acme",
    children: [{
      "object.entity": {
        name: "Customer",
        children: [
          { "source.rdb": {} },
          { "field.long": { name: "id" } },
          { "field.string": { name: "firstName" } },
          { "identity.primary": { name: "id", "@fields": "id" } },
        ],
      },
    }],
  },
});

async function load(): Promise<MetaRoot> {
  const result = await new MetaDataLoader().load([new InMemoryStringSource(META)]);
  expect(result.errors).toEqual([]);
  return result.root as MetaRoot;
}

describe("ObjectManager column naming (ADR-0058)", () => {
  test("the 1.0 columnNamingStrategy option is refused, naming the setting that replaced it", async () => {
    const root = await load();
    const opts = { metadata: root, driver: inMemoryDriver(), columnNamingStrategy: "literal" };
    expect(() => new ObjectManager(opts as ConstructorParameters<typeof ObjectManager>[0])).toThrow(
      'the ObjectManager columnNamingStrategy option was removed in 1.1.0. Column and table naming is one project setting now, read by every port: "naming" in .metaobjects/config.json, for example "naming": { "columns": "literal" }. Move it there and delete the ObjectManager columnNamingStrategy option. See ' + BLOB + 'docs/features/migrations/physical-naming.md',
    );
  });

  test("with no naming on the root, it reads snake_case columns", async () => {
    const root = await load();
    const driver = inMemoryDriver({ seed: { customers: [{ id: 1, first_name: "Ada" }] }, pkFields: { customers: ["id"] } });
    expect(await new ObjectManager({ metadata: root, driver }).findMany("Customer")).toEqual([{ id: 1, firstName: "Ada" }]);
  });

  test("with literal columns on the root, it reads columns named as the fields", async () => {
    const root = await load();
    root.physicalNaming = { columns: "literal", tables: "snake_case" };
    const driver = inMemoryDriver({ seed: { customers: [{ id: 1, firstName: "Ada" }] }, pkFields: { customers: ["id"] } });
    expect(await new ObjectManager({ metadata: root, driver }).findMany("Customer")).toEqual([{ id: 1, firstName: "Ada" }]);
  });
});
