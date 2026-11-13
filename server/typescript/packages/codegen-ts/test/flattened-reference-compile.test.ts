// A reference over a member of a flattened value object (`Plan.address.countryId`), and the
// view shapes the loaders accept around it. Each case is lowered end to end, or refused by
// name: never a dropped column, a join on a column that does not exist, or the wrong join.
//
//   - the generated model tier (entity, names, queries with the reverse finder) compiles: the
//     finder reads the member's flat key (`addressCountryId`), the Drizzle table property;
//   - `meta migrate`'s foreign key and a view's join name the member's real column;
//   - a passthrough `@from` onto a flattened member reads that column;
//   - two references onto one target join it twice, and each passthrough reads the join its
//     own `@via` walked;
//   - an origin `@segment`, which the view lowering does not express yet, is refused;
//   - a projection that extends another projection, whose fields and `@filter` the view
//     lowering does not inherit yet, is refused naming the projection.

import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { COMPILE_TEST_TIMEOUT_MS } from "./compile-timeout.js";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { InMemoryStringSource, MetaDataLoader, type MetaObject, type MetaRoot } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "@metaobjectsdev/migrate-ts";
import { entityFile } from "../src/generators/entity-file.js";
import { namesFile } from "../src/generators/names-file.js";
import { queriesFile } from "../src/generators/queries-file.js";
import { barrel } from "../src/generators/barrel.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import { buildProjectionViews } from "../src/projection/build-projection-views.js";
import type { EmittedFile, GenContext } from "../src/generator.js";

setDefaultTimeout(COMPILE_TEST_TIMEOUT_MS);

const pk = { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } };

const ENTITIES = [
  { "object.entity": { name: "Country", children: [
    { "source.rdb": { "@table": "countries" } },
    { "field.long": { name: "id" } },
    { "field.string": { name: "name", "@maxLength": 80 } },
    pk,
  ]}},
  { "object.value": { name: "Address", children: [
    { "field.string": { name: "city", "@maxLength": 80 } },
    { "field.long": { name: "countryId" } },
  ]}},
  { "object.entity": { name: "Plan", children: [
    { "source.rdb": { "@table": "plans" } },
    { "field.long": { name: "id" } },
    { "field.object": { name: "address", "@objectRef": "Address", "@storage": "flattened" } },
    pk,
    { "identity.reference": { name: "countryRef", "@fields": "address.countryId", "@references": "Country" } },
    { "relationship.association": { name: "country", "@cardinality": "one", "@objectRef": "Country" } },
  ]}},
];

async function load(children: unknown[]): Promise<MetaRoot> {
  const result = await new MetaDataLoader({ strict: true }).load([
    new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: "demo", children } }), { id: "flattened-reference.json" }),
  ]);
  expect(result.errors.map((e) => e.message)).toEqual([]);
  return result.root;
}

async function generate(root: MetaRoot): Promise<EmittedFile[]> {
  const renderContext = makeRenderContext({
    dialect: "postgres", loadedRoot: root, outDir: "/x", dbImport: "./db",
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root), includeNames: true,
  });
  const genCtx = (g: { filter?: (e: MetaObject) => boolean }): GenContext => ({
    entities: root.objects(), loadedRoot: root, matches: (e) => g.filter?.(e) ?? true, projectRoot: "/x",
    config: { outDir: "/x", extStyle: "none", dbImport: "./db", dialect: "postgres" } as never,
    renderContext, warn: () => {},
  });
  const generators = [entityFile(), namesFile(), queriesFile(), barrel()];
  return (await Promise.all(generators.map((g) => g.generate(genCtx(g))))).flat();
}

function viewSql(root: MetaRoot): string {
  return buildProjectionViews(root, { dialect: "postgres" }).map((v) => v.sql).join("\n");
}

describe("a reference over a flattened value-object member", () => {
  test("the model tier compiles, and the reverse finder reads the member's flat key", async () => {
    const files = await generate(await load(ENTITIES));
    const queries = files.find((f) => f.path === "Plan.queries.ts")!.content;
    expect(queries).toContain("findPlansByAddressCountry(");
    expect(queries).toContain("plans.addressCountryId");
    // Under the package so drizzle-orm and zod resolve to their real types.
    const dir = mkdtempSync(join(import.meta.dir, "tmp-flattened-reference-"));
    try {
      for (const f of files) writeFileSync(join(dir, f.path), f.content);
      const program = ts.createProgram(files.map((f) => join(dir, f.path)), {
        strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true,
      });
      const diagnostics = ts.getPreEmitDiagnostics(program).map((d) =>
        `${d.file?.fileName.slice(dir.length + 1) ?? ""} ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
      expect(diagnostics).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("meta migrate's foreign key names the member's column", async () => {
    const schema = buildExpectedSchema(await load(ENTITIES), { dialect: "postgres" });
    const plans = schema.tables.find((t) => t.name === "plans")!;
    expect(plans.foreignKeys.map((fk) => fk.columns)).toEqual([["address_country_id"]]);
  });

  test("a view joins through the member's column, and a passthrough reads a member", async () => {
    const root = await load([...ENTITIES,
      { "object.projection": { name: "PlanExtract", children: [
        { "source.rdb": { "@kind": "view", "@view": "v_plan_extract" } },
        { "field.long": { name: "id", extends: "Plan.id" } },
        { "field.string": { name: "city", children: [{ "origin.passthrough": { "@from": "Plan.address.city" } }] } },
        { "field.string": { name: "countryName", children: [{ "origin.passthrough": { "@from": "Country.name", "@via": "Plan.countryRef" } }] } },
        { "identity.primary": { name: "pk", extends: "Plan.pk" } },
      ]}},
    ]);
    const sql = viewSql(root);
    expect(sql).toContain("p.address_city AS city");
    expect(sql).toContain("c.id = p.address_country_id");
  });
});

describe("two references onto one target", () => {
  test("each passthrough reads the join its own @via walked", async () => {
    const root = await load([
      { "object.entity": { name: "User", children: [
        { "source.rdb": { "@table": "users" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "name", "@maxLength": 80, "@required": true } },
        pk,
      ]}},
      { "object.entity": { name: "Account", children: [
        { "source.rdb": { "@table": "accounts" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "ownerId", "@required": true } },
        { "field.long": { name: "approverId" } },
        pk,
        { "identity.reference": { name: "owner", "@fields": "ownerId", "@references": "User" } },
        { "identity.reference": { name: "approver", "@fields": "approverId", "@references": "User" } },
      ]}},
      { "object.projection": { name: "AccountView", children: [
        { "source.rdb": { "@kind": "view", "@view": "v_accounts" } },
        { "field.long": { name: "id", extends: "Account.id" } },
        { "field.string": { name: "ownerName", children: [{ "origin.passthrough": { "@from": "User.name", "@via": "Account.owner" } }] } },
        { "field.string": { name: "approverName", children: [{ "origin.passthrough": { "@from": "User.name", "@via": "Account.approver" } }] } },
        { "identity.primary": { name: "pk", extends: "Account.pk" } },
      ]}},
    ]);
    const sql = viewSql(root);
    expect(sql).toContain("u.name AS owner_name");
    expect(sql).toContain("u0.name AS approver_name");
    expect(sql).toContain("u.id = a.owner_id");
    expect(sql).toContain("u0.id = a.approver_id");
  });
});

describe("an origin the view lowering does not express yet", () => {
  test("an origin @segment is refused by name, never dropped", async () => {
    const root = await load([
      { "object.entity": { name: "Case", children: [
        { "source.rdb": { "@table": "cases" } },
        { "field.long": { name: "id" } },
        pk,
      ]}},
      { "object.entity": { name: "CaseEvent", children: [
        { "source.rdb": { "@table": "case_events" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "caseId", "@required": true } },
        { "field.timestamp": { name: "createdAt" } },
        { "field.boolean": { name: "active" } },
        pk,
        { "identity.reference": { name: "caseRef", "@fields": "caseId", "@references": "Case" } },
        { "segment.filter": { name: "live", "@filter": { active: true } } },
      ]}},
      { "object.projection": { name: "CaseSummary", children: [
        { "source.rdb": { "@kind": "view", "@view": "v_case_summary" } },
        { "field.long": { name: "id", extends: "Case.id" } },
        { "field.timestamp": { name: "firstLive", children: [{ "origin.aggregate": {
          "@agg": "min", "@of": "CaseEvent.createdAt", "@via": "Case.caseEvents", "@segment": "live",
        } }] } },
        { "identity.primary": { name: "pk", extends: "Case.pk" } },
      ]}},
    ]);
    expect(() => viewSql(root)).toThrow(/CaseSummary: field "firstLive" cannot be lowered into the view: its @segment/);
  });
});

// The shared fixtures for these shapes, lowered by the one view builder `meta migrate` uses:
// each lowers, or throws the refusal named here. None may load and then lose a column.
const CONFORMANCE = join(import.meta.dir, "../../../../../fixtures/conformance");

async function loadFixture(name: string): Promise<MetaRoot> {
  const dir = join(CONFORMANCE, name, "input");
  const sources = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) =>
    new InMemoryStringSource(readFileSync(join(dir, f), "utf8"), { id: f, format: "json" }));
  const result = await new MetaDataLoader().load(sources);
  expect(result.errors.map((e) => e.message)).toEqual([]);
  return result.root;
}

describe("the shared fixtures, through the view builder", () => {
  test.each([
    "origin-passthrough-flattened-member",
    "origin-passthrough-two-references-one-target",
    "reference-flattened-member",
  ])("%s lowers", async (name) => {
    expect(viewSql(await loadFixture(name))).toContain("SELECT");
  });

  test.each([
    ["origin-computed-case-over-joined", /field "label" cannot be lowered into the view: its @expr/],
    ["origin-computed-literal-unifies", /field "statusOrZero" cannot be lowered into the view: its @expr/],
    ["origin-correlated-filter-and-segment", /cannot be lowered into the view: its @segment/],
    ["origin-segment-scoped", /cannot be lowered into the view: its @segment/],
    ["origin-filter-relative-now", /relative-date filter value .* cannot be lowered to a view/],
    ["projection-filter-relative-now", /relative-date filter value .* cannot be lowered to a view/],
    ["projection-filter-joined-path", /view @filter field "caseId.status" did not resolve to a view column/],
    ["projection-filter-unprojected-base-field", /view @filter field "deleted" did not resolve to a view column/],
    ["entity-derived-filter-gate", /did not resolve to a view column/],
    ["projection-extends-abstract-projection", /Projection DataAggregationPlans cannot be lowered into a view: it extends PlanExtract,/],
    ["projection-extends-filtered-projection", /Projection ExportPlans cannot be lowered into a view: it extends LivePlans,/],
    ["projection-extends-projection-own-identity", /Projection ExportPlans cannot be lowered into a view: it extends GatedPlans,/],
  ] as const)("%s is refused by name", async (name, refusal) => {
    const root = await loadFixture(name);
    expect(() => viewSql(root)).toThrow(refusal);
  });

  test("a correlated operand in an aggregate @filter is refused", async () => {
    // The fixture's two correlated origins also carry @segment, which is refused first;
    // without it, the base-row comparison is what the builder meets.
    const dir = join(CONFORMANCE, "origin-correlated-filter-and-segment", "input");
    const sources = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) =>
      new InMemoryStringSource(readFileSync(join(dir, f), "utf8").replace(/"@segment": "live",\s*/g, ""), { id: f, format: "json" }));
    const result = await new MetaDataLoader().load(sources);
    expect(result.errors.map((e) => e.message)).toEqual([]);
    expect(() => viewSql(result.root)).toThrow(/field "statusPlaced" cannot be lowered into the view: .*base-row field/);
  });
});
