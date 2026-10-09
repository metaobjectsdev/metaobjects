import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  InMemoryStringSource,
  MetaDataLoader,
  MetaMeasure,
  OBJECT_REPORT_ATTR_DIMENSIONS,
  OBJECT_REPORT_ATTR_MEASURES,
  OBJECT_REPORT_ATTR_SPINE,
  TYPE_MEASURE,
  loadUris,
  measureDerivedSubType,
  reportMeasureItemName,
  reportShape,
  reportSpineHops,
  type MetaObject,
  type MetaRoot,
} from "../src/index.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..");
const MODEL = join(REPO_ROOT, "fixtures", "conformance", "reporting-vocabulary", "input", "meta.shop.json");

async function load(): Promise<MetaRoot> {
  const result = await loadUris([pathToFileURL(MODEL).href]);
  expect(result.errors).toEqual([]);
  return result.root;
}
const report = (root: MetaRoot, name: string): MetaObject => {
  const found = root.objects().find((o) => o.name === name);
  if (found === undefined) throw new Error(`no object ${name}`);
  return found;
};
const brief = (root: MetaRoot, name: string) =>
  reportShape(report(root, name), root).fields.map((f) => [f.name, f.role, f.subType, f.required]);

describe("reportShape (FR-044 Table B)", () => {
  test("dimensions come first, in listed order, then measures", async () => {
    const root = await load();
    expect(brief(root, "ProgramEngagement")).toEqual([
      ["program", "dimension", "long", false],
      ["starters", "measure", "long", true],
      ["daysEngaged", "measure", "long", true],
      ["avgDaysPerStarter", "measure", "decimal", false],
      ["lastActivityAt", "measure", "timestamp", false],
    ]);
  });

  test("a time dimension derives <name><Grain> typed date", async () => {
    const root = await load();
    expect(brief(root, "DailyRevenue")).toEqual([
      ["purchasedAtDay", "dimension", "date", false],
      ["purchases", "measure", "long", true],
      ["revenue", "measure", "currency", false],
    ]);
  });

  test("sum of a currency keeps the currency field as its type source", async () => {
    const root = await load();
    const revenue = reportShape(report(root, "DailyRevenue"), root).fields.find((f) => f.name === "revenue");
    expect(revenue?.typeSource?.name).toBe("amountCents");
  });

  test("no dimensions yields measures only", async () => {
    const root = await load();
    expect(brief(root, "StoreTotals").map((f) => f[1])).toEqual(["measure", "measure", "measure"]);
  });
});

// ---------------------------------------------------------------------------
// Reference resolution (final fix wave A2 / A3 / A8). The shape must agree with the
// loader's `validateReporting` about what a reference names, or a model that loads
// clean fails (or is silently mistyped) when it is lowered or read.
// ---------------------------------------------------------------------------

const file = (pkg: string, children: unknown[]): InMemoryStringSource =>
  new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: pkg, children } }));

async function loadInline(files: InMemoryStringSource[]): Promise<MetaRoot> {
  const { root, errors } = await new MetaDataLoader().load(files);
  expect(errors).toEqual([]);
  return root;
}

/** `a::Base` (abstract): members whose bare `@of` names `Base`. */
const sharedBase = {
  "object.entity": {
    name: "Base",
    abstract: true,
    children: [
      { "field.long": { name: "id" } },
      { "field.string": { name: "kind" } },
      { "identity.primary": { name: "pk", "@fields": ["id"] } },
      { "dimension.attribute": { name: "kind", "@of": "Base.kind" } },
      { "measure.aggregate": { name: "events", "@agg": "count", "@of": "Base.id" } },
      { "measure.aggregate": { name: "lastKind", "@agg": "max", "@of": "Base.kind" } },
    ],
  },
};
const ev = (extra: unknown[] = []) => ({
  "object.entity": {
    name: "Ev",
    extends: "a::Base",
    children: [{ "source.rdb": { "@table": "evs" } }, ...extra],
  },
});
const evReport = (attrs: Record<string, unknown> = {}) => ({
  "object.report": {
    name: "R",
    "@from": "Ev",
    "@dimensions": ["kind"],
    "@measures": ["events", "lastKind"],
    ...attrs,
    children: [{ "source.rdb": { "@kind": "view", "@view": "v_r" } }],
  },
});
/** The report with one attr replaced, WITHOUT the loader (the loaded tree is frozen, and
 *  the loader refuses these values): what a caller building a tree in code can hand in. */
function withAttr(node: MetaObject, name: string, value: unknown): MetaObject {
  const stub = Object.create(node) as MetaObject;
  Object.defineProperty(stub, "attr", { value: (n: string) => (n === name ? value : node.attr(n)) });
  return stub;
}

const typed = (root: MetaRoot) =>
  reportShape(report(root, "R"), root).fields.map((f) => [f.name, f.subType, f.typeSource?.parent?.resolutionKey()]);

describe("reportShape reference resolution", () => {
  test("a bare @of on a member inherited from another package resolves in the DECLARING entity's package", async () => {
    const root = await loadInline([file("a", [sharedBase]), file("b", [ev(), evReport()])]);
    expect(typed(root)).toEqual([
      ["kind", "string", "a::Base"],
      ["events", "long", undefined],
      ["lastKind", "string", "a::Base"],
    ]);
  });

  test("a same-named decoy in the report's package does not capture the reference", async () => {
    const decoy = {
      "object.entity": { name: "Base", children: [{ "field.int": { name: "id" } }, { "field.int": { name: "kind" } }] },
    };
    const root = await loadInline([file("a", [sharedBase]), file("b", [decoy, ev(), evReport()])]);
    expect(typed(root)).toEqual([
      ["kind", "string", "a::Base"],
      ["events", "long", undefined],
      ["lastKind", "string", "a::Base"],
    ]);
  });

  test("without @via the field is read from @from, so a field @from redeclares wins (as in the loader)", async () => {
    const root = await loadInline([
      file("a", [sharedBase]),
      file("b", [ev([{ "field.int": { name: "kind" } }]), evReport()]),
    ]);
    expect(typed(root)).toEqual([
      ["kind", "int", "b::Ev"],
      ["events", "long", undefined],
      ["lastKind", "int", "b::Ev"],
    ]);
  });

  test("a dotted @measures item names the measure by its last segment (loader rule R3)", async () => {
    const root = await loadInline([
      file("a", [sharedBase]),
      file("b", [ev(), evReport({ "@measures": ["Ev.events", "a::Base.lastKind"] })]),
    ]);
    expect(typed(root).map((f) => f[0])).toEqual(["kind", "events", "lastKind"]);
  });

  test("reportMeasureItemName: bare, dotted and package-qualified", () => {
    expect(reportMeasureItemName("total")).toBe("total");
    expect(reportMeasureItemName("Sale.total")).toBe("total");
    expect(reportMeasureItemName("acme::shop::Sale.total")).toBe("total");
  });

  test("a dotted @measures item whose qualifier is not @from (or an ancestor of it) does not resolve", async () => {
    const root = await loadInline([file("a", [sharedBase]), file("b", [ev(), evReport()])]);
    // Past the loader, which refuses this as ERR_INVALID_REPORT / ERR_REPORT_FOREIGN_MEASURE.
    const r = withAttr(report(root, "R"), OBJECT_REPORT_ATTR_MEASURES, ["Nope.events"]);
    expect(() => reportShape(r, root)).toThrow("report 'R': measure 'Nope.events' on 'Ev' does not resolve.");
  });

  test("a time dimension item with no grain, or a grain outside the closed set, does not resolve", async () => {
    const root = await load();
    const r = report(root, "DailyRevenue");
    expect(() => reportShape(withAttr(r, OBJECT_REPORT_ATTR_DIMENSIONS, ["purchasedAt"]), root)).toThrow(
      "report 'DailyRevenue': time dimension 'purchasedAt' grain '' does not resolve.",
    );
    expect(() => reportShape(withAttr(r, OBJECT_REPORT_ATTR_DIMENSIONS, ["purchasedAt:fortnight"]), root)).toThrow(
      "report 'DailyRevenue': time dimension 'purchasedAt' grain 'fortnight' does not resolve.",
    );
  });
});

// ---------------------------------------------------------------------------
// Table C of docs/superpowers/plans/2026-10-09-fr-044-zero-rows-and-measure-defaults.md:
// under @spine a column of the spine entity is not nullable when it is @required or a
// primary-key column; a dimension beyond the spine is; a measure with @default is not.
// ---------------------------------------------------------------------------

const catalog = {
  "object.entity": {
    name: "Catalog",
    children: [
      { "source.rdb": { "@table": "catalogs" } },
      { "field.long": { name: "id" } },
      { "field.string": { name: "name", "@required": true } },
      { "identity.primary": { name: "pk", "@fields": ["id"] } },
    ],
  },
};
const program = {
  "object.entity": {
    name: "Program",
    children: [
      { "source.rdb": { "@table": "programs" } },
      // No @required: a key column is not nullable because it is the key.
      { "field.long": { name: "id" } },
      { "field.string": { name: "title", "@required": true } },
      { "field.string": { name: "subtitle" } },
      { "field.timestamp": { name: "publishedAt", "@required": true } },
      { "field.long": { name: "catalogId" } },
      { "identity.primary": { name: "pk", "@fields": ["id"] } },
      { "identity.reference": { name: "fkCatalog", "@references": "Catalog", "@fields": ["catalogId"] } },
      { "relationship.association": { name: "catalog", "@objectRef": "Catalog", "@cardinality": "one" } },
    ],
  },
};
const purchase = {
  "object.entity": {
    name: "Purchase",
    children: [
      { "source.rdb": { "@table": "purchases" } },
      { "field.long": { name: "id" } },
      { "field.long": { name: "programId" } },
      { "field.int": { name: "minutes", "@required": true } },
      { "field.currency": { name: "amountCents", "@currency": "USD" } },
      { "field.double": { name: "score" } },
      { "field.timestamp": { name: "purchasedAt" } },
      { "identity.primary": { name: "pk", "@fields": ["id"] } },
      { "identity.reference": { name: "fkProgram", "@references": "Program", "@fields": ["programId"] } },
      { "relationship.association": { name: "program", "@objectRef": "Program", "@cardinality": "one" } },
      { "dimension.attribute": { name: "programId", "@of": "Program.id", "@via": "Purchase.program" } },
      { "dimension.attribute": { name: "programTitle", "@of": "Program.title", "@via": "Purchase.program" } },
      { "dimension.attribute": { name: "programSubtitle", "@of": "Program.subtitle", "@via": "Purchase.program" } },
      { "dimension.time": { name: "publishedAt", "@of": "Program.publishedAt", "@via": "Purchase.program", "@grains": ["hour", "month"] } },
      { "dimension.attribute": { name: "catalogId", "@of": "Catalog.id", "@via": "Purchase.program.catalog" } },
      // Catalog.name is @required, but one hop beyond a Purchase.program spine its join is LEFT OUTER.
      { "dimension.attribute": { name: "catalogName", "@of": "Catalog.name", "@via": "Purchase.program.catalog" } },
      { "dimension.attribute": { name: "minutes", "@of": "Purchase.minutes" } },
      { "measure.aggregate": { name: "purchases", "@agg": "count", "@of": "Purchase.id" } },
      { "measure.aggregate": { name: "revenue", "@agg": "sum", "@of": "Purchase.amountCents", "@default": 0 } },
      { "measure.aggregate": { name: "revenueRaw", "@agg": "sum", "@of": "Purchase.amountCents" } },
      { "measure.aggregate": { name: "avgMinutes", "@agg": "avg", "@of": "Purchase.minutes", "@default": 0 } },
      { "measure.aggregate": { name: "avgMinutesRaw", "@agg": "avg", "@of": "Purchase.minutes" } },
      { "measure.aggregate": { name: "minMinutes", "@agg": "min", "@of": "Purchase.minutes", "@default": -1 } },
      { "measure.aggregate": { name: "minMinutesRaw", "@agg": "min", "@of": "Purchase.minutes" } },
      { "measure.aggregate": { name: "totalScore", "@agg": "sum", "@of": "Purchase.score" } },
      { "measure.aggregate": { name: "avgScore", "@agg": "avg", "@of": "Purchase.score" } },
      { "measure.aggregate": { name: "lastAt", "@agg": "max", "@of": "Purchase.purchasedAt" } },
      { "measure.ratio": { name: "share", "@numerator": "revenue", "@denominator": "purchases", "@default": 0 } },
      { "measure.ratio": { name: "shareRaw", "@numerator": "revenue", "@denominator": "purchases" } },
    ],
  },
};
const ALL_MEASURES = [
  "purchases",
  "revenue",
  "revenueRaw",
  "avgMinutes",
  "avgMinutesRaw",
  "minMinutes",
  "minMinutesRaw",
  "share",
  "shareRaw",
];
const spineSales = {
  "object.report": {
    name: "SpineSales",
    "@from": "Purchase",
    "@spine": "Purchase.program",
    "@dimensions": ["programId", "programTitle", "programSubtitle", "publishedAt:hour", "publishedAt:month", "catalogId", "catalogName"],
    "@measures": ALL_MEASURES,
  },
};
const plainSales = {
  "object.report": {
    name: "PlainSales",
    "@from": "Purchase",
    "@dimensions": ["programId", "programTitle", "programSubtitle", "catalogId", "catalogName", "minutes"],
    "@measures": ALL_MEASURES,
  },
};
const catalogSales = {
  "object.report": {
    name: "CatalogSales",
    "@from": "Purchase",
    "@spine": "Purchase.program.catalog",
    "@dimensions": ["catalogId", "catalogName"],
    "@measures": ["purchases", "revenue"],
  },
};
const salesModel = () => loadInline([file("acme", [catalog, program, purchase, spineSales, plainSales, catalogSales])]);
const requiredOf = (root: MetaRoot, name: string) =>
  Object.fromEntries(reportShape(report(root, name), root).fields.map((f) => [f.name, f.required]));
const measureNamed = (root: MetaRoot, entity: string, name: string): MetaMeasure => {
  const m = report(root, entity)
    .children()
    .find((c) => c.type === TYPE_MEASURE && c.name === name);
  if (!(m instanceof MetaMeasure)) throw new Error(`no measure ${entity}.${name}`);
  return m;
};

describe("reportShape Table C (FR-044 @spine and measure @default)", () => {
  test("under @spine, a column of the spine entity is required when it is a key or @required", async () => {
    const required = requiredOf(await salesModel(), "SpineSales");
    expect(required["programId"]).toBe(true); // Program.id: no @required, in identity.primary
    expect(required["programTitle"]).toBe(true); // Program.title: @required
    expect(required["programSubtitle"]).toBe(false); // Program.subtitle: optional
    // A time dimension over a @required spine column, at either grain path (timestamp / date).
    expect(required["publishedAtHour"]).toBe(true);
    expect(required["publishedAtMonth"]).toBe(true);
  });

  test("under @spine, a dimension one hop beyond the spine is not required, even over a key or a @required field", async () => {
    const required = requiredOf(await salesModel(), "SpineSales");
    expect(required["catalogId"]).toBe(false); // Catalog.id: a key, beyond the spine
    expect(required["catalogName"]).toBe(false); // Catalog.name: @required, beyond the spine
  });

  test("a two-hop spine: a dimension whose @via equals the whole spine is on it", async () => {
    const required = requiredOf(await salesModel(), "CatalogSales");
    expect(required["catalogId"]).toBe(true);
    expect(required["catalogName"]).toBe(true);
  });

  test("the same dimensions in a report without @spine keep today's values (the key one is not required)", async () => {
    const required = requiredOf(await salesModel(), "PlainSales");
    expect(required["programId"]).toBe(false);
    expect(required["programTitle"]).toBe(false);
    expect(required["programSubtitle"]).toBe(false);
    expect(required["catalogId"]).toBe(false);
    expect(required["catalogName"]).toBe(false);
    expect(required["minutes"]).toBe(true); // no @via, @of @required: unchanged
  });

  test("a sum, an avg, a min and a ratio are required with @default and not without; a count always is", async () => {
    const root = await salesModel();
    for (const name of ["SpineSales", "PlainSales"]) {
      const required = requiredOf(root, name);
      expect([name, required]).toEqual([
        name,
        expect.objectContaining({
          purchases: true,
          revenue: true,
          revenueRaw: false,
          avgMinutes: true,
          avgMinutesRaw: false,
          minMinutes: true,
          minMinutesRaw: false,
          share: true,
          shareRaw: false,
        }),
      ]);
    }
  });

  test("a count with a @default (past the loader, which refuses it) is still required", async () => {
    const withCountDefault = JSON.parse(JSON.stringify(purchase)) as typeof purchase;
    const count = withCountDefault["object.entity"].children.find(
      (c) => "measure.aggregate" in c && c["measure.aggregate"].name === "purchases",
    ) as { "measure.aggregate": Record<string, unknown> };
    count["measure.aggregate"]["@default"] = 5;
    const { root, errors } = await new MetaDataLoader().load([
      file("acme", [catalog, program, withCountDefault, plainSales]),
    ]);
    expect(errors.map((e) => e.message.includes("@default cannot apply to @agg: count"))).toEqual([true]);
    expect(requiredOf(root, "PlainSales")["purchases"]).toBe(true);
  });

  test("subtypes and type sources are untouched by @default", async () => {
    const root = await salesModel();
    const shape = reportShape(report(root, "SpineSales"), root).fields;
    expect(shape.map((f) => [f.name, f.subType, f.typeSource?.name])).toEqual([
      ["programId", "long", "id"],
      ["programTitle", "string", "title"],
      ["programSubtitle", "string", "subtitle"],
      ["publishedAtHour", "timestamp", "publishedAt"],
      ["publishedAtMonth", "date", undefined],
      ["catalogId", "long", "id"],
      ["catalogName", "string", "name"],
      ["purchases", "long", undefined],
      ["revenue", "currency", "amountCents"],
      ["revenueRaw", "currency", "amountCents"],
      ["avgMinutes", "decimal", undefined],
      ["avgMinutesRaw", "decimal", undefined],
      ["minMinutes", "int", "minutes"],
      ["minMinutesRaw", "int", "minutes"],
      ["share", "decimal", undefined],
      ["shareRaw", "decimal", undefined],
    ]);
  });

  test("an identity.primary inherited from an abstract base makes the key column required (ADR-0039)", async () => {
    const keyed = {
      "object.entity": {
        name: "Keyed",
        abstract: true,
        children: [{ "field.long": { name: "id" } }, { "identity.primary": { name: "pk", "@fields": ["id"] } }],
      },
    };
    const inheritedProgram = {
      "object.entity": {
        name: "Program",
        extends: "Keyed",
        children: program["object.entity"].children.filter(
          (c) => !("identity.primary" in c) && !("field.long" in c && c["field.long"].name === "id"),
        ),
      },
    };
    const root = await loadInline([file("acme", [keyed, catalog, inheritedProgram, purchase, spineSales])]);
    expect(requiredOf(root, "SpineSales")["programId"]).toBe(true);
  });

  test("under @spine, a dimension whose @via does not resolve throws, naming the report", async () => {
    const broken = JSON.parse(JSON.stringify(purchase)) as typeof purchase;
    const dim = broken["object.entity"].children.find(
      (c) => "dimension.attribute" in c && c["dimension.attribute"].name === "programSubtitle",
    ) as { "dimension.attribute": Record<string, unknown> };
    // An owner that is not @from (or an entity it extends): reportingViaHops does not resolve it.
    dim["dimension.attribute"]["@via"] = "Program.catalog";
    // Past the loader, which refuses the @via under rule D2.
    const { root, errors } = await new MetaDataLoader().load([file("acme", [catalog, program, broken, spineSales])]);
    expect(errors.length).toBe(1);
    expect(() => reportShape(report(root, "SpineSales"), root)).toThrow(
      "report 'SpineSales': dimension 'programSubtitle' @via 'Program.catalog' does not resolve.",
    );
  });

  test("a spine written with an abstract base as its owner, over a concrete @from (the inherited fixture)", async () => {
    const fixture = join(REPO_ROOT, "fixtures", "conformance", "reporting-spine-inherited", "input", "meta.shop.json");
    const { root, errors } = await loadUris([pathToFileURL(fixture).href]);
    expect(errors).toEqual([]);
    expect(reportShape(report(root, "ProgramMinutes"), root).fields.map((f) => [f.name, f.required])).toEqual([
      ["programId", true],
      ["programTitle", true],
      ["totalMinutes", true],
    ]);
  });
});

describe("reportSpineHops", () => {
  test("undefined without @spine; the hop names with one", async () => {
    const root = await salesModel();
    const from = report(root, "Purchase");
    expect(reportSpineHops(report(root, "PlainSales"), from, root)).toBeUndefined();
    expect(reportSpineHops(report(root, "SpineSales"), from, root)).toEqual(["program"]);
    expect(reportSpineHops(report(root, "CatalogSales"), from, root)).toEqual(["program", "catalog"]);
  });

  test("the owner may be an entity @from extends, resolved in the report's package", async () => {
    const fixture = join(REPO_ROOT, "fixtures", "conformance", "reporting-spine-inherited", "input", "meta.shop.json");
    const { root } = await loadUris([pathToFileURL(fixture).href]);
    expect(reportSpineHops(report(root, "ProgramMinutes"), report(root, "WorkoutEvent"), root)).toEqual(["program"]);
  });

  test("a @spine that does not resolve throws, naming the report (a tree built in code)", async () => {
    const root = await salesModel();
    const from = report(root, "Purchase");
    // Past the loader, which refuses these under rule R8.
    for (const spine of ["Program.catalog", "Purchase", "Purchase..program"]) {
      const r = withAttr(report(root, "SpineSales"), OBJECT_REPORT_ATTR_SPINE, spine);
      expect(() => reportSpineHops(r, from, root)).toThrow(`report 'SpineSales': @spine '${spine}' does not resolve.`);
      expect(() => reportShape(r, root)).toThrow(`report 'SpineSales': @spine '${spine}' does not resolve.`);
    }
  });
});

describe("measureDerivedSubType (Table B for one measure, listed in a report or not)", () => {
  test("each aggregate and the ratio", async () => {
    const root = await salesModel();
    const from = report(root, "Purchase");
    const subType = (name: string) => measureDerivedSubType(measureNamed(root, "Purchase", name), from, root);
    expect(subType("purchases")).toBe("long"); // count
    expect(subType("revenue")).toBe("currency"); // sum of a currency
    expect(subType("totalScore")).toBe("double"); // sum of a double
    expect(subType("avgMinutes")).toBe("decimal"); // avg of an int
    expect(subType("avgScore")).toBe("double"); // avg of a double
    expect(subType("minMinutes")).toBe("int"); // min keeps the source type
    expect(subType("lastAt")).toBe("timestamp"); // max keeps the source type
    expect(subType("share")).toBe("decimal"); // ratio
  });

  test("agrees with reportShape for every measure a report lists", async () => {
    const root = await salesModel();
    const from = report(root, "Purchase");
    for (const f of reportShape(report(root, "SpineSales"), root).fields) {
      if (f.measure !== undefined) expect([f.name, measureDerivedSubType(f.measure, from, root)]).toEqual([f.name, f.subType]);
    }
  });
});
