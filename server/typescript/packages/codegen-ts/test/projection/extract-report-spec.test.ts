// FR-044 Plan 2, Task 4 — an object.report plus its shape lowers to a dialect-neutral
// ReportViewSpec (contract Table F). These tests assert on the SPEC, never on SQL: the
// renderer is a separate task.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
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
    expect(days.aggregate.refs).toEqual(["w.program_id", "w.week_number", "w.day_number"]);
    expect(days.aggregate.distinct).toBe(true);
    expect(days.aggregate.cast).toBeUndefined();
    // The report's @segment scopes the whole report, not each measure.
    expect(s.where).toEqual({ kind: "cmp", ref: "w.event_type", op: "eq", value: "exercise_complete" });
  });

  test("a ratio carries both operand aggregates in full", async () => {
    const s = await spec("ProgramEngagement");
    const ratio = s.columns.find((c) => c.fieldName === "avgDaysPerStarter")!;
    if (ratio.kind !== "ratio") throw new Error("expected a ratio");
    expect(ratio.numerator.refs).toHaveLength(3);
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
