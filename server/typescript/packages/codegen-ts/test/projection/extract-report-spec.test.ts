// FR-044 Plan 2, Task 4 — an object.report plus its shape lowers to a dialect-neutral
// ReportViewSpec (contract Table F). These tests assert on the SPEC, never on SQL: the
// renderer is a separate task.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MetaDataLoader,
  InMemoryStringSource,
  OBJECT_REPORT_ATTR_FILTER,
  reportReadModel,
  type MetaObject,
  type MetaRoot,
} from "@metaobjectsdev/metadata";
import { extractReportSpec, temporalOf } from "../../src/projection/extract-report-spec.js";
import { isRelativeNow } from "../../src/projection/report-spec.js";
import type { ReportViewSpec } from "../../src/projection/report-spec.js";

type Json = Record<string, unknown>;

const FIXTURE = resolve(import.meta.dir, "../../../../../../fixtures/codegen-noop/reporting/with/meta.shop.json");

/** The shared reporting fixture, with extra members and reports appended for these cases. */
function shopModel(mutate?: (children: Json[]) => void): Json {
  const model = JSON.parse(readFileSync(FIXTURE, "utf8")) as { "metadata.root": { children: Json[] } };
  const children = model["metadata.root"].children;
  const entity = (name: string): Json[] => {
    const hit = children.find((c) => (c["object.entity"] as Json | undefined)?.name === name);
    return (hit!["object.entity"] as { children: Json[] }).children;
  };
  const purchase = entity("Purchase");
  purchase.push(
    { "field.timestamp": { name: "createdAt", "@column": "created_ts" } },
    { "field.double": { name: "score" } },
    { "dimension.time": { name: "createdAt", "@of": "Purchase.createdAt", "@grains": ["month"] } },
    { "measure.aggregate": { name: "scoreTotal", "@agg": "sum", "@of": "Purchase.score" } },
  );
  children.push(
    { "object.report": { name: "ProgramTitles", "@from": "Purchase", "@dimensions": ["programTitle"], "@measures": ["purchases"] } },
    { "object.report": { name: "ProgramOnly", "@from": "Purchase", "@dimensions": ["program"], "@measures": ["purchases"] } },
    {
      "object.report": {
        name: "SegmentAndFilter", "@from": "Purchase", "@measures": ["purchases"],
        "@segment": "active", "@filter": { status: "refunded" },
      },
    },
    {
      "object.report": {
        name: "Range", "@from": "Purchase", "@measures": ["purchases"],
        "@filter": { amountCents: { gte: 100, lte: 500 } },
      },
    },
    { "object.report": { name: "Scores", "@from": "Purchase", "@measures": ["scoreTotal"] } },
    {
      "object.report": {
        name: "CreatedByMonth", "@from": "Purchase", "@dimensions": ["createdAt:month"], "@measures": ["purchases"],
      },
    },
  );
  mutate?.(children);
  return model;
}

async function load(model: Json): Promise<MetaRoot> {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(model))]);
  expect(errors).toEqual([]);
  return root;
}

async function spec(
  name: string,
  opts: { model?: Json; strategy?: "snake_case" | "literal" } = {},
): Promise<ReportViewSpec> {
  const root = await load(opts.model ?? shopModel());
  const report = root.findObject(name);
  if (report === undefined) throw new Error(`no report ${name}`);
  return extractReportSpec(report, root, { columnNamingStrategy: opts.strategy ?? "snake_case" });
}

describe("extractReportSpec", () => {
  test("a no-dimension report has no joins and only aggregate columns", async () => {
    const s = await spec("StoreTotals");
    expect(s.joinTree.joins).toEqual([]);
    expect(s.columns.map((c) => c.kind)).toEqual(["aggregate", "aggregate", "aggregate"]);
    expect(s.viewName).toBe("v_store_totals");
    expect(s.joinTree.baseEntity).toBe("acme::shop::Purchase");
    expect(s.joinTree.baseAlias).toBe("p");
    expect(s.where).toBeUndefined();
  });

  test("a @via dimension adds one join with the #209 join type", async () => {
    const s = await spec("ProgramTitles");
    expect(s.joinTree.joins).toHaveLength(1);
    const join = s.joinTree.joins[0]!;
    expect(join.relationship).toBe("program");
    // programId carries no @required in this fixture, so the hop is LEFT.
    expect(join.joinType).toBe("left");
    const dim = s.columns[0]!;
    expect(dim.kind).toBe("dimension");
    if (dim.kind !== "dimension") throw new Error("unreachable");
    expect(dim.fieldName).toBe("programTitle");
    expect(dim.dbColAlias).toBe("program_title");
    // The ref lands on the JOIN alias, not the base alias.
    expect(dim.ref).toBe(`${join.alias}.title`);
    expect(join.alias).not.toBe(s.joinTree.baseAlias);
  });

  test("a required belongs-to FK joins INNER", async () => {
    const model = shopModel((children) => {
      const purchase = children.find((c) => (c["object.entity"] as Json | undefined)?.name === "Purchase")!;
      const fields = (purchase["object.entity"] as { children: Json[] }).children;
      const programId = fields.find((f) => (f["field.long"] as Json | undefined)?.name === "programId")!;
      (programId["field.long"] as Json)["@required"] = true;
    });
    const s = await spec("ProgramTitles", { model });
    expect(s.joinTree.joins[0]!.joinType).toBe("inner");
  });

  test("an unlisted @via dimension adds no join", async () => {
    const s = await spec("ProgramOnly");
    expect(s.joinTree.joins).toEqual([]);
    const dim = s.columns[0]!;
    if (dim.kind !== "dimension") throw new Error("expected a dimension");
    expect(dim.ref).toBe("p.program_id");
  });

  test("report @segment and @filter combine with AND, segment first", async () => {
    const s = await spec("SegmentAndFilter");
    expect(s.where).toEqual({
      kind: "and",
      clauses: [
        { kind: "cmp", ref: "p.status", op: "eq", value: "active" },
        { kind: "cmp", ref: "p.status", op: "eq", value: "refunded" },
      ],
    });
  });

  test("a relative value becomes a RelativeNow with the field's temporal kind", async () => {
    const s = await spec("DailyRevenue");
    expect(s.where).toEqual({
      kind: "cmp",
      ref: "p.purchased_at",
      op: "gte",
      value: { kind: "relativeNow", duration: "-P90D", temporal: "instant" },
    });
    expect(isRelativeNow((s.where as { value: unknown }).value)).toBe(true);
    expect(isRelativeNow({ now: "-P90D" })).toBe(false);
    expect(isRelativeNow(null)).toBe(false);
  });

  test("two operators on one field both survive", async () => {
    const s = await spec("Range");
    expect(s.where).toEqual({
      kind: "and",
      clauses: [
        { kind: "cmp", ref: "p.amount_cents", op: "gte", value: 100 },
        { kind: "cmp", ref: "p.amount_cents", op: "lte", value: 500 },
      ],
    });
  });

  test("a measure's @segment and @filter become its aggregate filter", async () => {
    const totals = await spec("StoreTotals");
    const purchases = totals.columns[0]!;
    if (purchases.kind !== "aggregate") throw new Error("expected an aggregate");
    expect(purchases.aggregate.agg).toBe("count");
    expect(purchases.aggregate.filter).toEqual({ kind: "cmp", ref: "p.status", op: "eq", value: "active" });
    // A measure with neither a segment nor a filter has no aggregate filter.
    const engagement = await spec("ProgramEngagement");
    const lastActivity = engagement.columns.find((c) => c.fieldName === "lastActivityAt")!;
    if (lastActivity.kind !== "aggregate") throw new Error("expected an aggregate");
    expect(lastActivity.aggregate.filter).toBeUndefined();
  });

  test("a measure's own @filter is read without a segment", async () => {
    const model = shopModel((children) => {
      const purchase = children.find((c) => (c["object.entity"] as Json | undefined)?.name === "Purchase")!;
      (purchase["object.entity"] as { children: Json[] }).children.push(
        { "measure.aggregate": { name: "bigOnes", "@agg": "count", "@of": "Purchase.id", "@segment": "active", "@filter": { refunded: false } } },
      );
      children.push({ "object.report": { name: "Big", "@from": "Purchase", "@measures": ["bigOnes"] } });
    });
    const s = await spec("Big", { model });
    const c = s.columns[0]!;
    if (c.kind !== "aggregate") throw new Error("expected an aggregate");
    expect(c.aggregate.filter).toEqual({
      kind: "and",
      clauses: [
        { kind: "cmp", ref: "p.status", op: "eq", value: "active" },
        { kind: "cmp", ref: "p.refunded", op: "eq", value: false },
      ],
    });
  });

  test("a tuple @of yields several refs and distinct: true", async () => {
    const s = await spec("ProgramEngagement");
    const days = s.columns.find((c) => c.fieldName === "daysEngaged")!;
    if (days.kind !== "aggregate") throw new Error("expected an aggregate");
    expect(days.aggregate.refs).toEqual(["w.program_id", "w.customer_email", "w.week_number", "w.day_number"]);
    expect(days.aggregate.distinct).toBe(true);
    expect(days.aggregate.cast).toBeUndefined();
    // The report's @segment scopes the whole report, not each measure.
    expect(s.where).toEqual({ kind: "cmp", ref: "w.event_type", op: "eq", value: "exercise_complete" });
  });

  test("a ratio carries both operand aggregates in full", async () => {
    const s = await spec("ProgramEngagement");
    const ratio = s.columns.find((c) => c.fieldName === "avgDaysPerStarter")!;
    if (ratio.kind !== "ratio") throw new Error("expected a ratio");
    expect(ratio.numerator.refs).toHaveLength(4);
    expect(ratio.numerator.distinct).toBe(true);
    expect(ratio.denominator.refs).toEqual(["w.customer_email"]);
    expect(ratio.denominator.distinct).toBe(true);
    expect(ratio.dbColAlias).toBe("avg_days_per_starter");
  });

  test("an operand that is not listed in @measures is still resolved", async () => {
    const model = shopModel((children) => {
      children.push({
        "object.report": { name: "RatioOnly", "@from": "WorkoutEvent", "@measures": ["avgDaysPerStarter"] },
      });
    });
    const s = await spec("RatioOnly", { model });
    expect(s.columns.map((c) => c.kind)).toEqual(["ratio"]);
    const ratio = s.columns[0]!;
    if (ratio.kind !== "ratio") throw new Error("expected a ratio");
    // Neither operand is listed, and both arrive as full aggregates over the base alias.
    const listed = await spec("ProgramEngagement");
    const same = listed.columns.find((c) => c.fieldName === "avgDaysPerStarter")!;
    if (same.kind !== "ratio") throw new Error("expected a ratio");
    expect(ratio.numerator).toEqual(same.numerator);
    expect(ratio.denominator).toEqual(same.denominator);
    expect(ratio.numerator.refs).toHaveLength(4);
    expect(ratio.denominator.refs).toEqual(["w.customer_email"]);
  });

  test("an integral sum is cast to bigint; a currency sum too; a floating sum to double", async () => {
    const revenue = (await spec("DailyRevenue")).columns.find((c) => c.fieldName === "revenue")!;
    if (revenue.kind !== "aggregate") throw new Error("expected an aggregate");
    expect(revenue.aggregate.cast).toBe("bigint");
    const scores = (await spec("Scores")).columns[0]!;
    if (scores.kind !== "aggregate") throw new Error("expected an aggregate");
    expect(scores.aggregate.cast).toBe("double");
    // count and max never cast.
    const lastActivity = (await spec("ProgramEngagement")).columns.find((c) => c.fieldName === "lastActivityAt")!;
    if (lastActivity.kind !== "aggregate") throw new Error("expected an aggregate");
    expect(lastActivity.aggregate.cast).toBeUndefined();
  });

  test("a time dimension carries its grain and the field's temporal kind", async () => {
    const s = await spec("DailyRevenue");
    const dim = s.columns[0]!;
    if (dim.kind !== "timeDimension") throw new Error("expected a timeDimension");
    expect(dim).toEqual({
      kind: "timeDimension",
      fieldName: "purchasedAtDay",
      dbColAlias: "purchased_at_day",
      ref: "p.purchased_at",
      grain: "day",
      temporal: "instant",
    });
  });

  test("refuses a @from with no writable source", async () => {
    const model = shopModel((children) => {
      children.push(
        {
          "object.entity": {
            name: "Ghost",
            children: [
              { "field.long": { name: "id" } },
              { "identity.primary": { name: "id", "@fields": ["id"] } },
              { "measure.aggregate": { name: "ghosts", "@agg": "count", "@of": "Ghost.id" } },
            ],
          },
        },
        { "object.report": { name: "GhostReport", "@from": "Ghost", "@measures": ["ghosts"] } },
      );
    });
    const root = await load(model);
    expect(() => extractReportSpec(root.findObject("GhostReport")!, root, { columnNamingStrategy: "snake_case" }))
      .toThrow(/report 'GhostReport'.*'Ghost'.*no table/);
  });

  test("the output alias is the naming strategy applied to the derived name, not an inherited @column", async () => {
    const s = await spec("CreatedByMonth");
    const dim = s.columns[0]!;
    if (dim.kind !== "timeDimension") throw new Error("expected a timeDimension");
    expect(dim.dbColAlias).toBe("created_at_month");
    expect(dim.ref).toBe("p.created_ts");
    const literal = await spec("CreatedByMonth", { strategy: "literal" });
    const lit = literal.columns[0]!;
    expect(lit.dbColAlias).toBe("createdAtMonth");
    expect((lit as { ref: string }).ref).toBe("p.created_ts");
  });
});

describe("temporalOf", () => {
  test("date, instant and naive", async () => {
    const root = await load(shopModel((children) => {
      const purchase = children.find((c) => (c["object.entity"] as Json | undefined)?.name === "Purchase")!;
      (purchase["object.entity"] as { children: Json[] }).children.push(
        { "field.timestamp": { name: "localAt", "@localTime": true } },
      );
    }));
    const purchase = root.findObject("Purchase")!;
    const field = (n: string) => purchase.fields().find((f) => f.name === n)!;
    expect(temporalOf(field("purchasedOn"))).toBe("date");
    expect(temporalOf(field("purchasedAt"))).toBe("instant");
    expect(temporalOf(field("localAt"))).toBe("naive");
  });
});

// ---------------------------------------------------------------------------
// Final fix wave (FR-044): refusals and reference resolution.
// ---------------------------------------------------------------------------

const CTX = { columnNamingStrategy: "snake_case" } as const;

const file = (pkg: string, children: Json[]): InMemoryStringSource =>
  new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: pkg, children } }));

async function loadFiles(files: InMemoryStringSource[]): Promise<MetaRoot> {
  const { root, errors } = await new MetaDataLoader().load(files);
  expect(errors).toEqual([]);
  return root;
}

const view = (name: string): Json => ({ "source.rdb": { "@kind": "view", "@view": name } });

/** The node with one attr replaced, WITHOUT the loader (the loaded tree is frozen and the
 *  loader refuses these values): what a caller building a tree in code can hand in. */
function withAttr(node: MetaObject, name: string, value: unknown): MetaObject {
  const stub = Object.create(node) as MetaObject;
  Object.defineProperty(stub, "attr", { value: (n: string) => (n === name ? value : node.attr(n)) });
  return stub;
}

describe("extractReportSpec: a @from in a TPH hierarchy", () => {
  /** `User` owns the table and the discriminator; `Admin` is a TPH subtype sharing it. */
  const tph = (reports: Json[]): InMemoryStringSource =>
    file("acme", [
      {
        "object.entity": {
          name: "User",
          "@discriminator": "kind",
          children: [
            { "source.rdb": { "@table": "users" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "kind" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
            { "measure.aggregate": { name: "users", "@agg": "count", "@of": "User.id" } },
          ],
        },
      },
      { "object.entity": { name: "Admin", extends: "User", "@discriminatorValue": "ADMIN", children: [] } },
      ...reports,
    ]);
  const report = (name: string, from: string, extra: Json = {}, source: Json = view("v_r")): Json => ({
    "object.report": { name, "@from": from, "@measures": ["users"], ...extra, children: [source] },
  });

  test("a derived report @from a TPH subtype is refused, naming the report and the subtype", async () => {
    const root = await loadFiles([tph([report("Admins", "Admin")])]);
    expect(() => extractReportSpec(root.findObject("Admins")!, root, CTX)).toThrow(
      "report 'Admins': @from 'Admin' is a TPH subtype: it shares the table of 'User' with every other " +
        "subtype, so a view derived from it would aggregate all of their rows. Declare the report " +
        "@from 'User' with an @filter on the discriminator field 'kind' (for example { \"kind\": \"ADMIN\" }).",
    );
  });

  test("a report @from the TPH base is accepted and reads the shared table unscoped", async () => {
    const root = await loadFiles([tph([report("Users", "User")])]);
    const s = extractReportSpec(root.findObject("Users")!, root, CTX);
    expect(s.joinTree.baseEntity).toBe("acme::User");
    expect(s.where).toBeUndefined();
  });

  test("a base report with an @filter on the discriminator lowers to a WHERE on that column", async () => {
    const root = await loadFiles([tph([report("Admins", "User", { "@filter": { kind: "ADMIN" } })])]);
    const s = extractReportSpec(root.findObject("Admins")!, root, CTX);
    expect(s.where).toEqual({ kind: "cmp", ref: "u.kind", op: "eq", value: "ADMIN" });
  });

  test("the runtime read model does not look at @from's TPH position: it serves whatever relation the source names", async () => {
    // An @sql or @unmanaged view over a subtype is the author's body, so it is not refused
    // (build-projection-views.test.ts); the read model's shape is the same Table B either way.
    const root = await loadFiles([tph([report("Admins", "Admin")])]);
    const model = reportReadModel(root.findObject("Admins")!, root);
    expect(model?.fields().map((f) => f.name)).toEqual(["users"]);
  });
});

describe("extractReportSpec: references resolve as the loader resolves them", () => {
  /** `a::Base` (abstract) declares members with BARE references; `b::Ev extends a::Base`. */
  const shared = (): InMemoryStringSource =>
    file("a", [
      {
        "object.entity": {
          name: "Owner",
          children: [
            { "source.rdb": { "@table": "owners" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "label" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Base",
          abstract: true,
          children: [
            { "field.long": { name: "id" } },
            { "field.string": { name: "kind" } },
            { "field.long": { name: "ownerId" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
            { "identity.reference": { name: "ownerRef", "@fields": ["ownerId"], "@references": "a::Owner" } },
            { "relationship.association": { name: "owner", "@objectRef": "a::Owner", "@cardinality": "one" } },
            { "dimension.attribute": { name: "kind", "@of": "Base.kind" } },
            { "dimension.attribute": { name: "ownerLabel", "@of": "Owner.label", "@via": "Base.owner" } },
            { "measure.aggregate": { name: "events", "@agg": "count", "@of": "Base.id" } },
          ],
        },
      },
    ]);
  const consumer = (extra: Json[] = []): InMemoryStringSource =>
    file("b", [
      ...extra,
      { "object.entity": { name: "Ev", extends: "a::Base", children: [{ "source.rdb": { "@table": "evs" } }] } },
      {
        "object.report": {
          name: "R",
          "@from": "Ev",
          "@dimensions": ["kind", "ownerLabel"],
          "@measures": ["Ev.events"],
          children: [view("v_r")],
        },
      },
    ]);

  const refs = (s: ReportViewSpec): unknown[] =>
    s.columns.map((c) => (c.kind === "aggregate" ? c.aggregate.refs : (c as { ref: string }).ref));

  test("a bare @of / @via inherited from another package resolves in the declaring entity's package", async () => {
    const root = await loadFiles([shared(), consumer()]);
    const s = extractReportSpec(root.findObject("R")!, root, CTX);
    expect(s.joinTree.baseEntity).toBe("b::Ev");
    expect(s.joinTree.joins.map((j) => [j.relationship, j.targetEntity])).toEqual([["owner", "a::Owner"]]);
    expect(refs(s)).toEqual(["e.kind", `${s.joinTree.joins[0]!.alias}.label`, ["e.id"]]);
  });

  test("same-named decoys in the report's package do not capture the references", async () => {
    const decoys: Json[] = [
      { "object.entity": { name: "Base", children: [{ "field.int": { name: "id" } }, { "field.int": { name: "kind" } }] } },
      {
        "object.entity": {
          name: "Owner",
          children: [{ "source.rdb": { "@table": "decoy_owners" } }, { "field.int": { name: "label", "@column": "decoy" } }],
        },
      },
    ];
    const root = await loadFiles([shared(), consumer(decoys)]);
    const s = extractReportSpec(root.findObject("R")!, root, CTX);
    expect(s.joinTree.joins.map((j) => j.targetEntity)).toEqual(["a::Owner"]);
    expect(refs(s)).toEqual(["e.kind", `${s.joinTree.joins[0]!.alias}.label`, ["e.id"]]);
  });
});

describe("extractReportSpec: the @via walk starts at @from whatever its package looks like", () => {
  /** `F` with a to-one reference to `P`, and a report grouping by P's title through it. */
  const facts = (pkg: string, pTable = "ps"): InMemoryStringSource =>
    file(pkg, [
      {
        "object.entity": {
          name: "P",
          children: [
            { "source.rdb": { "@table": pTable } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "title" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
      {
        "object.entity": {
          name: "F",
          children: [
            { "source.rdb": { "@table": `${pTable}_facts` } },
            { "field.long": { name: "id" } },
            { "field.long": { name: "pId" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
            { "identity.reference": { name: "pRef", "@fields": ["pId"], "@references": "P" } },
            { "dimension.attribute": { name: "pTitle", "@of": "P.title", "@via": "F.pRef" } },
            { "measure.aggregate": { name: "facts", "@agg": "count", "@of": "F.id" } },
          ],
        },
      },
      {
        "object.report": {
          name: "ByP",
          "@from": "F",
          "@dimensions": ["pTitle"],
          "@measures": ["facts"],
          children: [view("v_by_p")],
        },
      },
    ]);
  const joinsOf = (root: MetaRoot, reportKey: string): unknown[] => {
    const report = root.objects().find((o) => o.resolutionKey() === reportKey)!;
    const s = extractReportSpec(report, root, CTX);
    return [s.joinTree.baseEntity, ...s.joinTree.joins.map((j) => [j.relationship, j.targetEntity])];
  };

  test.each(["acme", "com.acme", "com.acme::shop.v2"])(
    "a @via dimension lowers to one join in package '%s' (a package name may contain a dot)",
    async (pkg) => {
      const root = await loadFiles([facts(pkg)]);
      expect(joinsOf(root, `${pkg}::ByP`)).toEqual([`${pkg}::F`, ["pRef", `${pkg}::P`]]);
    },
  );

  test("the walk starts at THIS report's @from when another package has an entity of the same short name", async () => {
    // Loaded in both orders: neither `F` may win by load order.
    for (const files of [[facts("one", "ps1"), facts("two", "ps2")], [facts("two", "ps2"), facts("one", "ps1")]]) {
      const root = await loadFiles(files);
      expect(joinsOf(root, "one::ByP")).toEqual(["one::F", ["pRef", "one::P"]]);
      expect(joinsOf(root, "two::ByP")).toEqual(["two::F", ["pRef", "two::P"]]);
    }
  });
});

describe("extractReportSpec: refusals that name what is wrong", () => {
  test("refuses an abstract @from, naming the report and the entity", async () => {
    const root = await loadFiles([
      file("acme", [
        {
          "object.entity": {
            name: "Shape",
            abstract: true,
            children: [
              { "source.rdb": { "@table": "shapes" } },
              { "field.long": { name: "id" } },
              { "identity.primary": { name: "pk", "@fields": ["id"] } },
              { "measure.aggregate": { name: "shapes", "@agg": "count", "@of": "Shape.id" } },
            ],
          },
        },
        { "object.report": { name: "Shapes", "@from": "Shape", "@measures": ["shapes"], children: [view("v_shapes")] } },
      ]),
    ]);
    expect(() => extractReportSpec(root.findObject("Shapes")!, root, CTX)).toThrow(
      /report 'Shapes'.*'Shape'.*no table \(it is abstract/,
    );
  });

  test("a @via hop with no foreign key in the model is refused, naming the hop and what it needs", async () => {
    // The loader accepts a to-one relationship with no identity.reference behind it.
    const model = shopModel((children) => {
      const purchase = children.find((c) => (c["object.entity"] as Json | undefined)?.name === "Purchase")!;
      const kids = (purchase["object.entity"] as { children: Json[] }).children;
      kids.splice(kids.findIndex((k) => "identity.reference" in k), 1);
    });
    const root = await load(model);
    expect(() => extractReportSpec(root.findObject("ProgramTitles")!, root, CTX)).toThrow(
      "report 'ProgramTitles': dimension 'programTitle' @via 'Purchase.program' cannot be joined at hop 'program' " +
        "on 'acme::shop::Purchase': the model declares no foreign key for it. A view joins a hop through an " +
        "identity.reference; declare one on 'Purchase' whose @references is 'Program' (with the foreign-key " +
        "field in @fields).",
    );
  });

  test("a @via whose later hop does not resolve is refused, not joined part-way", async () => {
    const root = await load(shopModel());
    const titles = root.findObject("ProgramTitles")!;
    const from = root.findObject("Purchase")!;
    const dim = from.children().find((c) => c.name === "programTitle")!;
    // Past the loader (rule D2 refuses an unknown hop): a two-hop path whose second hop is nothing.
    const via = Object.create(dim) as typeof dim & { via(): string };
    Object.defineProperty(via, "via", { value: () => "Purchase.program.nowhere" });
    const fromStub = Object.create(from) as MetaObject;
    Object.defineProperty(fromStub, "children", { value: () => from.children().map((c) => (c === dim ? via : c)) });
    const rootStub = Object.create(root) as MetaRoot;
    const fromKey = from.resolutionKey();
    Object.defineProperty(rootStub, "children", {
      value: () => root.children().map((c) => (c.resolutionKey() === fromKey ? fromStub : c)),
    });
    Object.defineProperty(rootStub, "objects", {
      value: () => root.objects().map((c) => (c.resolutionKey() === fromKey ? fromStub : c)),
    });
    expect(() => extractReportSpec(titles, rootStub, CTX)).toThrow(
      /report 'ProgramTitles': dimension 'programTitle' @via 'Purchase.program.nowhere' cannot be joined at hop 'nowhere' on 'acme::shop::Program': it names no relationship or identity.reference/,
    );
  });

  test("a filter field that is not a field of @from is refused by name", async () => {
    const root = await load(shopModel());
    // Past the loader (rule S1 refuses an unknown filter field).
    const r = withAttr(root.findObject("StoreTotals")!, OBJECT_REPORT_ATTR_FILTER, { nope: 1 });
    expect(() => extractReportSpec(r, root, CTX)).toThrow(
      `report 'StoreTotals' @filter: filter field "nope" is not a field of 'Purchase'.`,
    );
  });

  test("an empty `in` list is refused at lowering, naming the report and the field", async () => {
    const model = shopModel((children) => {
      children.push({
        "object.report": { name: "NoStatuses", "@from": "Purchase", "@measures": ["purchases"], "@filter": { status: { in: [] } } },
      });
    });
    const root = await load(model);
    expect(() => extractReportSpec(root.findObject("NoStatuses")!, root, CTX)).toThrow(
      `report 'NoStatuses' @filter: the 'in' list on "status" is empty, which no row can match and no ` +
        `database accepts as SQL (IN ()). List at least one value, or remove the clause.`,
    );
  });
});
