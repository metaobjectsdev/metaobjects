import { describe, test, expect, beforeAll } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";

// Regression: a cross-package identity.reference must still resolve to a
// physical FK. Its `targetEntity` carries a package prefix (here the explicit
// FQN "p2::Bbb"; equivalently the loader-qualified form for a bare cross-package
// ref), but entityToTable is keyed by the bare entity name — so resolveTargetTable
// must fall back to the bare suffix after the last "::". Pre-fix this silently
// produced zero FKs for every cross-package reference.
describe("buildExpectedSchema — cross-package FK resolution", () => {
  let root: MetaData;
  beforeAll(async () => {
    const aaa = JSON.stringify({ "metadata.root": { package: "p1", children: [
      { "object.entity": { name: "Aaa", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "bbbId" } },
        { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
        { "identity.reference": { name: "ref_bbb", "@fields": "bbbId", "@references": "p2::Bbb" } },
        { "source.rdb": { name: "src", "@table": "aaas" } },
      ] } },
    ] } });
    const bbb = JSON.stringify({ "metadata.root": { package: "p2", children: [
      { "object.entity": { name: "Bbb", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
        { "source.rdb": { name: "src", "@table": "bbbs" } },
      ] } },
    ] } });
    root = (await new MetaDataLoader().load([new InMemoryStringSource(aaa), new InMemoryStringSource(bbb)])).root;
  });

  test("emits an FK from the cross-package referencing table to its target", () => {
    const snap = buildExpectedSchema(root, { dialect: "postgres" });
    const aaas = snap.tables.find((t) => t.name === "aaas");
    expect(aaas?.foreignKeys.length).toBe(1);
    expect(aaas?.foreignKeys[0]).toMatchObject({ columns: ["bbb_id"], refTable: "bbbs", refColumns: ["id"] });
  });
});

// Regression: a cross-package FK whose TARGET's single-column PK is NOT named
// "id" must reference that actual PK column. resolvedTargetPkField looks the
// (FQN) targetEntity up in findObject (bare-keyed) to read the target's primary
// identity — pre-fix the FQN missed, so the FK column silently defaulted to "id".
describe("buildExpectedSchema — cross-package FK to a non-id PK target", () => {
  let root: MetaData;
  beforeAll(async () => {
    const child = JSON.stringify({ "metadata.root": { package: "p1", children: [
      { "object.entity": { name: "Child", children: [
        { "field.long": { name: "id" } },
        { "field.string": { name: "parentCode" } },
        { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
        { "identity.reference": { name: "ref_parent", "@fields": "parentCode", "@references": "p2::Parent" } },
        { "source.rdb": { name: "src", "@table": "children" } },
      ] } },
    ] } });
    const parent = JSON.stringify({ "metadata.root": { package: "p2", children: [
      { "object.entity": { name: "Parent", children: [
        { "field.string": { name: "code" } },
        { "identity.primary": { name: "pk", "@fields": ["code"], "@generation": "assigned" } },
        { "source.rdb": { name: "src", "@table": "parents" } },
      ] } },
    ] } });
    root = (await new MetaDataLoader().load([new InMemoryStringSource(child), new InMemoryStringSource(parent)])).root;
  });

  test("FK references the target's actual PK column (code), not a defaulted id", () => {
    const snap = buildExpectedSchema(root, { dialect: "postgres" });
    const children = snap.tables.find((t) => t.name === "children");
    expect(children?.foreignKeys.length).toBe(1);
    expect(children?.foreignKeys[0]).toMatchObject({ columns: ["parent_code"], refTable: "parents", refColumns: ["code"] });
  });
});
