import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  FIELD_ATTR_COLUMN,
  FIELD_ATTR_CURRENCY,
  FIELD_ATTR_LOCAL_TIME,
  FIELD_ATTR_REQUIRED,
  FIELD_ATTR_VALUES,
  InMemoryStringSource,
  MetaDataLoader,
  OBJECT_SUBTYPE_REPORT,
  SOURCE_KIND_VIEW,
  TYPE_FIELD,
  TYPE_IDENTITY,
  canonicalSerialize,
  isMetaSource,
  loadUris,
  reportReadModel,
  resolveTableName,
  type MetaObject,
  type MetaRoot,
} from "../src/index.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..");
const MODEL = join(REPO_ROOT, "fixtures", "persistence-conformance", "canonical", "meta.fitness.json");

async function load(): Promise<MetaRoot> {
  const result = await loadUris([pathToFileURL(MODEL).href]);
  expect(result.errors).toEqual([]);
  return result.root;
}
const object = (root: MetaRoot, name: string): MetaObject => {
  const found = root.objects().find((o) => o.name === name);
  if (found === undefined) throw new Error(`no object ${name}`);
  return found;
};
const model = (root: MetaRoot, name: string): MetaObject => reportReadModel(object(root, name), root);
const fieldsOf = (m: MetaObject) => m.children().filter((c) => c.type === TYPE_FIELD);

describe("reportReadModel (FR-044 Table B as a detached read model)", () => {
  test("ProgramMinutes has eleven field children in Table B order with the Table B subtypes", async () => {
    const root = await load();
    expect(fieldsOf(model(root, "ProgramMinutes")).map((f) => [f.name, f.subType])).toEqual([
      ["program", "long"],
      ["programTitle", "string"],
      ["weeks", "long"],
      ["longWeeks", "long"],
      ["labels", "long"],
      ["slots", "long"],
      ["totalMinutes", "long"],
      ["avgMinutes", "decimal"],
      ["minMinutes", "int"],
      ["maxMinutes", "int"],
      ["longShare", "decimal"],
    ]);
  });

  test("min keeps the source field's subtype: minMinutes is field.int", async () => {
    const root = await load();
    const min = model(root, "ProgramMinutes").fields().find((f) => f.name === "minMinutes");
    expect(min?.type).toBe(TYPE_FIELD);
    expect(min?.subType).toBe("int");
  });

  test("@required comes from the derived shape, not from the type source", async () => {
    const root = await load();
    const m = model(root, "ProgramMinutes");
    const required = Object.fromEntries(m.fields().map((f) => [f.name, f.attr(FIELD_ATTR_REQUIRED)]));
    expect(required["program"]).toBe(true); // no @via, @of required
    expect(required["programTitle"]).toBe(false); // reached by @via
    expect(required["weeks"]).toBe(true); // a count is never null
    expect(required["minMinutes"]).toBe(false); // Week.durationMinutes is required; a min is not
  });

  test("a currency sum carries @currency from its type source", async () => {
    const root = await load();
    const listValue = model(root, "ProgramsByMonth").fields().find((f) => f.name === "listValue");
    expect(listValue?.subType).toBe("currency");
    expect(listValue?.attr(FIELD_ATTR_CURRENCY)).toBe("USD");
  });

  test("an enum dimension carries @values; an hour bucket carries its source's @localTime", async () => {
    const root = await load();
    const status = model(root, "ProgramsByMonth").fields().find((f) => f.name === "status");
    expect(status?.subType).toBe("enum");
    expect(status?.attr(FIELD_ATTR_VALUES)).toEqual(["DRAFT", "PUBLISHED", "ARCHIVED"]);
    // Asset.recordedAt is an instant: no @localTime to carry.
    const hour = model(root, "AssetActivity").fields().find((f) => f.name === "recordedAtHour");
    expect(hour?.subType).toBe("timestamp");
    expect(hour?.hasAttr(FIELD_ATTR_LOCAL_TIME)).toBe(false);
  });

  test("@column is never carried: Program.createdAt's created_ts does not reach a derived field", async () => {
    const root = await load();
    for (const name of ["ProgramMinutes", "ProgramsByMonth", "ProgramsByWeek", "AssetActivity"]) {
      for (const f of model(root, name).fields()) expect(f.hasAttr(FIELD_ATTR_COLUMN)).toBe(false);
    }
  });

  test("the model keeps the report's name and subtype, has no identity, and is frozen", async () => {
    const root = await load();
    const m = model(root, "ProgramMinutes");
    expect(m.name).toBe("ProgramMinutes");
    expect(m.subType).toBe(OBJECT_SUBTYPE_REPORT);
    expect(m.resolutionKey()).toBe(object(root, "ProgramMinutes").resolutionKey());
    expect(m.children().some((c) => c.type === TYPE_IDENTITY)).toBe(false);
    expect(m.isFrozen()).toBe(true);
  });

  test("the model's read-only source has the report's physical name", async () => {
    const root = await load();
    const m = model(root, "ProgramMinutes");
    const sources = m.children().filter(isMetaSource);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.isReadOnly()).toBe(true);
    expect(sources[0]!.effectiveKind).toBe(SOURCE_KIND_VIEW);
    expect(sources[0]!.physicalName).toBe("v_program_minutes");
    // A copy: the report's own source node is not re-parented.
    const own = object(root, "ProgramMinutes").children().find(isMetaSource)!;
    expect(sources[0]).not.toBe(own);
    expect(own.parent).toBe(object(root, "ProgramMinutes"));
  });

  test("the model is detached: it has no parent and the root does not list it", async () => {
    const root = await load();
    const m = model(root, "ProgramMinutes");
    expect(m.parent).toBeUndefined();
    expect(root.objects()).not.toContain(m);
    expect(root.children()).not.toContain(m);
  });

  test("root.objects() is unchanged in length and the root serialises byte-identically", async () => {
    const root = await load();
    const before = canonicalSerialize(root);
    const count = root.objects().length;
    for (const o of root.objects()) {
      if (o.subType === OBJECT_SUBTYPE_REPORT) reportReadModel(o, root);
    }
    expect(root.objects().length).toBe(count);
    expect(canonicalSerialize(root)).toBe(before);
  });

  test("the model is cached per report node", async () => {
    const root = await load();
    expect(model(root, "ProgramMinutes")).toBe(model(root, "ProgramMinutes"));
    expect(model(root, "ProgramMinutes")).not.toBe(model(root, "FitnessTotals"));
  });

  // What the loader permits (asserted by `errors` below, not assumed): a report may
  // declare two read-only sources, and @role defaults to primary.
  const multiSource = async (sources: unknown[]): Promise<MetaRoot> => {
    const result = await new MetaDataLoader().load([
      new InMemoryStringSource(
        JSON.stringify({
          "metadata.root": {
            package: "acme",
            children: [
              { "object.entity": { name: "Sale", children: [
                { "source.rdb": { "@table": "sales" } },
                { "field.long": { name: "id" } },
                { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
                { "measure.aggregate": { name: "sales", "@agg": "count", "@of": "Sale.id" } },
              ] } },
              { "object.report": { name: "Totals", "@from": "Sale", "@measures": ["sales"], children: sources } },
            ],
          },
        }),
      ),
    ]);
    expect(result.errors.map((e) => e.message)).toEqual([]);
    return result.root;
  };

  test("a replica read-only source declared before the primary view: the model holds the primary", async () => {
    const root = await multiSource([
      { "source.rdb": { name: "rep", "@kind": "view", "@view": "v_totals_replica", "@role": "replica" } },
      { "source.rdb": { name: "pri", "@kind": "view", "@view": "v_totals", "@role": "primary" } },
    ]);
    const m = model(root, "Totals");
    const sources = m.children().filter(isMetaSource);
    expect(sources.map((s) => [s.physicalName, s.role])).toEqual([["v_totals", "primary"]]);
    expect(resolveTableName(m)).toBe("v_totals");
  });

  test("a read-only source with no explicit @role is the one read", async () => {
    const root = await multiSource([{ "source.rdb": { "@kind": "view", "@view": "v_only" } }]);
    const m = model(root, "Totals");
    expect(m.children().filter(isMetaSource).map((s) => [s.physicalName, s.role])).toEqual([["v_only", "primary"]]);
    expect(resolveTableName(m)).toBe("v_only");
  });

  test("the canonical reports resolve their table to the declared view", async () => {
    const root = await load();
    expect(resolveTableName(model(root, "ProgramMinutes"))).toBe("v_program_minutes");
    expect(resolveTableName(model(root, "AssetActivity"))).toBe("v_asset_activity");
  });

  test("a sourceless report yields a model with the fields and no source", async () => {
    const result = await new MetaDataLoader().load([
      new InMemoryStringSource(
        JSON.stringify({
          "metadata.root": {
            package: "acme",
            children: [
              { "object.entity": { name: "Sale", children: [
                { "source.rdb": { "@table": "sales" } },
                { "field.long": { name: "id" } },
                { "field.currency": { name: "amountCents", "@currency": "EUR" } },
                { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
                { "measure.aggregate": { name: "revenue", "@agg": "sum", "@of": "Sale.amountCents" } },
              ] } },
              { "object.report": { name: "Revenue", "@from": "Sale", "@measures": ["revenue"] } },
            ],
          },
        }),
      ),
    ]);
    expect(result.errors.map((e) => e.message)).toEqual([]);
    const m = model(result.root, "Revenue");
    expect(m.fields().map((f) => [f.name, f.subType, f.attr(FIELD_ATTR_CURRENCY)])).toEqual([
      ["revenue", "currency", "EUR"],
    ]);
    expect(m.children().some(isMetaSource)).toBe(false);
  });
});
