// FR-044 — validateReporting: one test (or more) per row of the rule table in
// docs/superpowers/plans/2026-10-03-fr-044-plan-1-reporting-vocabulary.md.
//
// Every broken model is the clean spec §4 model (Purchase / Program /
// WorkoutEvent + three reports) with exactly one change, and every test
// asserts the FULL error-code list — one broken rule must produce exactly one
// error, never a cascade.

import { describe, expect, test } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { ISO_DURATION_RE } from "../src/core/reporting/reporting-constants.js";
import {
  reportDerivedFieldName,
  reportDimensionItems,
} from "../src/core/reporting/report-accessors.js";
import { MetaMeasure } from "../src/core/reporting/meta-measure.js";
import type { MetaData } from "../src/shared/meta-data.js";

// ---------------------------------------------------------------------------
// Model builders
// ---------------------------------------------------------------------------

type Body = Record<string, unknown>;
type Wrapper = Record<string, Body>;
type Model = { "metadata.root": { package: string; children: Wrapper[] } };

const PKG = "acme::shop";

function field(subType: string, name: string, extra: Body = {}): Wrapper {
  return { [`field.${subType}`]: { name, ...extra } };
}

function primary(): Wrapper {
  return { "identity.primary": { name: "id", "@fields": ["id"] } };
}

function fullReportingModel(): Model {
  return {
    "metadata.root": {
      package: PKG,
      children: [
        {
          "object.entity": {
            name: "Program",
            children: [
              { "source.rdb": { "@table": "programs" } },
              field("long", "id"),
              field("string", "title"),
              primary(),
              {
                "relationship.association": {
                  name: "purchases",
                  "@objectRef": "Purchase",
                  "@cardinality": "many",
                },
              },
            ],
          },
        },
        {
          "object.entity": {
            name: "Purchase",
            children: [
              { "source.rdb": { "@table": "purchases" } },
              field("long", "id"),
              field("long", "programId"),
              field("string", "customerEmail"),
              field("currency", "amountCents"),
              field("string", "status"),
              field("boolean", "refunded"),
              field("timestamp", "purchasedAt"),
              field("date", "purchasedOn"),
              primary(),
              {
                "identity.reference": {
                  name: "programRef",
                  "@references": "Program",
                  "@fields": ["programId"],
                },
              },
              {
                "relationship.association": {
                  name: "program",
                  "@objectRef": "Program",
                  "@cardinality": "one",
                },
              },
              { "dimension.attribute": { name: "program", "@of": "Purchase.programId" } },
              {
                "dimension.attribute": {
                  name: "programTitle",
                  "@of": "Program.title",
                  "@via": "Purchase.program",
                },
              },
              {
                "dimension.time": {
                  name: "purchasedAt",
                  "@of": "Purchase.purchasedAt",
                  "@grains": ["day", "week", "month", "quarter", "year"],
                },
              },
              {
                "measure.aggregate": {
                  name: "purchases",
                  "@agg": "count",
                  "@of": "Purchase.id",
                  "@segment": "active",
                },
              },
              {
                "measure.aggregate": {
                  name: "buyers",
                  "@agg": "count",
                  "@distinct": true,
                  "@of": "Purchase.customerEmail",
                  "@segment": "active",
                },
              },
              {
                "measure.aggregate": {
                  name: "revenue",
                  "@agg": "sum",
                  "@of": "Purchase.amountCents",
                  "@segment": "active",
                },
              },
              { "segment.filter": { name: "active", "@filter": { status: "active" } } },
            ],
          },
        },
        {
          "object.entity": {
            name: "WorkoutEvent",
            children: [
              { "source.rdb": { "@table": "workout_events" } },
              field("long", "id"),
              field("long", "programId"),
              field("string", "customerEmail"),
              field("int", "weekNumber"),
              field("int", "dayNumber"),
              field("string", "eventType"),
              field("timestamp", "occurredAt"),
              primary(),
              { "dimension.attribute": { name: "program", "@of": "WorkoutEvent.programId" } },
              {
                "measure.aggregate": {
                  name: "starters",
                  "@agg": "count",
                  "@distinct": true,
                  "@of": "WorkoutEvent.customerEmail",
                },
              },
              {
                "measure.aggregate": {
                  name: "daysEngaged",
                  "@agg": "count",
                  "@distinct": true,
                  "@of": [
                    "WorkoutEvent.programId",
                    "WorkoutEvent.weekNumber",
                    "WorkoutEvent.dayNumber",
                  ],
                },
              },
              {
                "measure.aggregate": {
                  name: "lastActivityAt",
                  "@agg": "max",
                  "@of": "WorkoutEvent.occurredAt",
                },
              },
              {
                "measure.ratio": {
                  name: "avgDaysPerStarter",
                  "@numerator": "daysEngaged",
                  "@denominator": "starters",
                },
              },
              {
                "segment.filter": {
                  name: "completions",
                  "@filter": { eventType: "exercise_complete" },
                },
              },
            ],
          },
        },
        {
          "object.report": {
            name: "ProgramEngagement",
            "@from": "WorkoutEvent",
            "@dimensions": ["program"],
            "@measures": ["starters", "daysEngaged", "avgDaysPerStarter", "lastActivityAt"],
            "@segment": "completions",
          },
        },
        {
          "object.report": {
            name: "DailyRevenue",
            "@from": "Purchase",
            "@dimensions": ["purchasedAt:day"],
            "@measures": ["purchases", "revenue"],
            "@filter": { purchasedAt: { gte: { now: "-P90D" } } },
          },
        },
        {
          "object.report": {
            name: "StoreTotals",
            "@from": "Purchase",
            "@measures": ["purchases", "buyers", "revenue"],
          },
        },
      ],
    },
  };
}

/** The body of the root-level object named `name`. */
function objectBody(m: Model, name: string): Body {
  for (const w of m["metadata.root"].children) {
    const body = Object.values(w)[0];
    if (body !== undefined && body.name === name) return body;
  }
  throw new Error(`no object ${name}`);
}

function childrenOf(m: Model, objName: string): Wrapper[] {
  const body = objectBody(m, objName);
  if (!Array.isArray(body.children)) body.children = [];
  return body.children as Wrapper[];
}

/** The base type (`field`, `dimension`, …) of a `{ "<type>.<subType>": body }` wrapper. */
function wrapperType(w: Wrapper): string {
  return Object.keys(w)[0]!.split(".")[0]!;
}

/** Replace the child of `objName` with the same base type as `w` and named `childName`, or append `w`. */
function setChild(m: Model, objName: string, childName: string, w: Wrapper): void {
  const kids = childrenOf(m, objName);
  const type = wrapperType(w);
  const i = kids.findIndex((k) => wrapperType(k) === type && Object.values(k)[0]?.name === childName);
  if (i === -1) kids.push(w);
  else kids[i] = w;
}

/** Shallow-merge attrs into the report (or other root object) named `objName`; `undefined` deletes. */
function patchObject(m: Model, objName: string, attrs: Body): void {
  const body = objectBody(m, objName);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) delete body[k];
    else body[k] = v;
  }
}

function edit(fn: (m: Model) => void): Model {
  const m = fullReportingModel();
  fn(m);
  return m;
}

const MEMBER_TYPES = ["dimension", "measure", "segment"];

/** Patch the attrs of an entity member (dimension/measure/segment) in place. */
function patchMember(m: Model, objName: string, childName: string, attrs: Body): void {
  const kids = childrenOf(m, objName);
  const w = kids.find((k) => MEMBER_TYPES.includes(wrapperType(k)) && Object.values(k)[0]?.name === childName);
  if (w === undefined) throw new Error(`no member ${objName}.${childName}`);
  const body = Object.values(w)[0] as Body;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) delete body[k];
    else body[k] = v;
  }
}

interface LoadedErrors {
  root: MetaData;
  errors: { code: string; message: string; source: unknown }[];
}

async function loadInline(doc: unknown): Promise<LoadedErrors> {
  const result = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(doc), { id: "meta.shop.json" }),
  ]);
  return result as unknown as LoadedErrors;
}

async function codes(doc: unknown): Promise<string[]> {
  const { errors } = await loadInline(doc);
  return errors.map((e) => e.code);
}

async function single(doc: unknown, code: string): Promise<string> {
  const { errors } = await loadInline(doc);
  expect(errors.map((e) => e.code)).toEqual([code]);
  return errors[0]!.message;
}

function jsonPathOf(source: unknown): string | undefined {
  return typeof source === "object" && source !== null && "jsonPath" in source
    ? String((source as { jsonPath: unknown }).jsonPath)
    : undefined;
}

// ---------------------------------------------------------------------------
// Clean model
// ---------------------------------------------------------------------------

describe("validateReporting — clean model", () => {
  test("a clean reporting model loads with no errors", async () => {
    const { errors } = await loadInline(fullReportingModel());
    expect(errors).toEqual([]);
  });

  test("a dimension may reach its column through an identity.reference hop", async () => {
    const m = edit((x) =>
      setChild(x, "Purchase", "programTitleByRef", {
        "dimension.attribute": {
          name: "programTitleByRef",
          "@of": "Program.title",
          "@via": "Purchase.programRef",
        },
      }),
    );
    expect(await codes(m)).toEqual([]);
  });

  test("FQN references resolve (ADR-0042)", async () => {
    const m = edit((x) => {
      patchMember(x, "Purchase", "programTitle", {
        "@of": "acme::shop::Program.title",
        "@via": "acme::shop::Purchase.program",
      });
      patchObject(x, "StoreTotals", { "@from": "acme::shop::Purchase", "@measures": ["acme::shop::Purchase.revenue"] });
    });
    expect(await codes(m)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D1–D4 — dimensions
// ---------------------------------------------------------------------------

describe("validateReporting — dimensions", () => {
  test("D1: @of naming a field the owning entity lacks is refused", async () => {
    const m = edit((x) => patchMember(x, "Purchase", "program", { "@of": "Purchase.programIdd" }));
    const msg = await single(m, "ERR_INVALID_DIMENSION");
    expect(msg).toContain("'acme::shop::Purchase'");
    expect(msg).toContain("'program'");
    expect(msg).toContain("programIdd");
  });

  test("D1: @of naming another entity without @via is refused", async () => {
    const m = edit((x) => patchMember(x, "Purchase", "program", { "@of": "Program.title" }));
    const msg = await single(m, "ERR_INVALID_DIMENSION");
    expect(msg).toContain("@via");
  });

  test("D1: with @via, @of must name the @via terminal", async () => {
    const m = edit((x) => patchMember(x, "Purchase", "programTitle", { "@of": "Purchase.status" }));
    const msg = await single(m, "ERR_INVALID_DIMENSION");
    expect(msg).toContain("'acme::shop::Program'");
  });

  test("D1: @of not of the form Entity.field is refused", async () => {
    const m = edit((x) => patchMember(x, "Purchase", "program", { "@of": "programId" }));
    await single(m, "ERR_INVALID_DIMENSION");
  });

  test("D2: @via over a to-many relationship is refused", async () => {
    const m = edit((x) =>
      setChild(x, "Program", "buyerEmail", {
        "dimension.attribute": {
          name: "buyerEmail",
          "@of": "Purchase.customerEmail",
          "@via": "Program.purchases",
        },
      }),
    );
    const msg = await single(m, "ERR_INVALID_DIMENSION");
    expect(msg).toContain("'purchases'");
    expect(msg).toContain("to-one");
  });

  test("D2: @via naming an unknown hop is refused", async () => {
    const m = edit((x) => patchMember(x, "Purchase", "programTitle", { "@via": "Purchase.nope" }));
    const msg = await single(m, "ERR_INVALID_DIMENSION");
    expect(msg).toContain("'nope'");
  });

  test("D2: @via must start at the owning entity", async () => {
    const m = edit((x) => patchMember(x, "Purchase", "programTitle", { "@via": "WorkoutEvent.program" }));
    await single(m, "ERR_INVALID_DIMENSION");
  });

  test("D2: @via with no hop is refused", async () => {
    const m = edit((x) => patchMember(x, "Purchase", "programTitle", { "@via": "Purchase" }));
    await single(m, "ERR_INVALID_DIMENSION");
  });

  test("D3: dimension.time over a non-temporal field is refused", async () => {
    const m = edit((x) => patchMember(x, "Purchase", "purchasedAt", { "@of": "Purchase.status" }));
    const msg = await single(m, "ERR_INVALID_DIMENSION");
    expect(msg).toContain("field.string");
  });

  test("D4: dimension.time declaring 'hour' over a field.date is refused", async () => {
    const m = edit((x) =>
      setChild(x, "Purchase", "purchasedOn", {
        "dimension.time": { name: "purchasedOn", "@of": "Purchase.purchasedOn", "@grains": ["hour", "day"] },
      }),
    );
    const msg = await single(m, "ERR_INVALID_DIMENSION");
    expect(msg).toContain("hour");
  });

  test("D4: a field.date time dimension without 'hour' is fine", async () => {
    const m = edit((x) =>
      setChild(x, "Purchase", "purchasedOn", {
        "dimension.time": { name: "purchasedOn", "@of": "Purchase.purchasedOn", "@grains": ["day", "month"] },
      }),
    );
    expect(await codes(m)).toEqual([]);
  });

  test("error source points at the dimension node", async () => {
    const m = edit((x) => patchMember(x, "Purchase", "program", { "@of": "Purchase.programIdd" }));
    const { errors } = await loadInline(m);
    expect(jsonPathOf(errors[0]!.source)).toContain("['dimension.attribute']");
  });
});

// ---------------------------------------------------------------------------
// M1–M6 — measures
// ---------------------------------------------------------------------------

describe("validateReporting — measures", () => {
  test("M1: @of naming another entity's field is refused", async () => {
    const m = edit((x) => patchMember(x, "Purchase", "buyers", { "@of": "WorkoutEvent.customerEmail" }));
    const msg = await single(m, "ERR_INVALID_MEASURE");
    expect(msg).toContain("'buyers'");
  });

  test("M1: @of naming an unknown field is refused", async () => {
    const m = edit((x) => patchMember(x, "Purchase", "revenue", { "@of": "Purchase.amount" }));
    await single(m, "ERR_INVALID_MEASURE");
  });

  test("M2: a tuple @of without @distinct is refused", async () => {
    const m = edit((x) => patchMember(x, "WorkoutEvent", "daysEngaged", { "@distinct": undefined }));
    const msg = await single(m, "ERR_INVALID_MEASURE");
    expect(msg).toContain("daysEngaged");
  });

  test("M2: a tuple @of with @distinct but @agg sum is ONE error, not M2+M3", async () => {
    const m = edit((x) => patchMember(x, "WorkoutEvent", "daysEngaged", { "@agg": "sum" }));
    await single(m, "ERR_INVALID_MEASURE");
  });

  test("M3: @distinct with @agg sum is refused", async () => {
    const m = edit((x) => patchMember(x, "Purchase", "revenue", { "@distinct": true }));
    const msg = await single(m, "ERR_INVALID_MEASURE");
    expect(msg).toContain("@distinct");
  });

  test("M4: sum over a non-numeric field is refused", async () => {
    const m = edit((x) => patchMember(x, "Purchase", "revenue", { "@of": "Purchase.status" }));
    const msg = await single(m, "ERR_INVALID_MEASURE");
    expect(msg).toContain("field.string");
  });

  test("M4: max over a boolean field is refused", async () => {
    const m = edit((x) =>
      setChild(x, "Purchase", "anyRefund", {
        "measure.aggregate": { name: "anyRefund", "@agg": "max", "@of": "Purchase.refunded" },
      }),
    );
    await single(m, "ERR_INVALID_MEASURE");
  });

  test("M4: avg over a currency field and min over a timestamp are fine", async () => {
    const m = edit((x) => {
      setChild(x, "Purchase", "avgRevenue", {
        "measure.aggregate": { name: "avgRevenue", "@agg": "avg", "@of": "Purchase.amountCents" },
      });
      setChild(x, "Purchase", "firstPurchaseAt", {
        "measure.aggregate": { name: "firstPurchaseAt", "@agg": "min", "@of": "Purchase.purchasedAt" },
      });
    });
    expect(await codes(m)).toEqual([]);
  });

  test("M5: @segment naming no segment of the owning entity is refused", async () => {
    const m = edit((x) => patchMember(x, "Purchase", "revenue", { "@segment": "completions" }));
    const msg = await single(m, "ERR_INVALID_MEASURE");
    expect(msg).toContain("'completions'");
  });

  test("M6: a ratio operand naming another ratio is refused", async () => {
    const m = edit((x) =>
      setChild(x, "WorkoutEvent", "ratioOfRatio", {
        "measure.ratio": { name: "ratioOfRatio", "@numerator": "avgDaysPerStarter", "@denominator": "starters" },
      }),
    );
    const msg = await single(m, "ERR_INVALID_MEASURE");
    expect(msg).toContain("'avgDaysPerStarter'");
  });

  test("M6: a ratio operand naming nothing is refused", async () => {
    const m = edit((x) => patchMember(x, "WorkoutEvent", "avgDaysPerStarter", { "@denominator": "nobody" }));
    await single(m, "ERR_INVALID_MEASURE");
  });

  test("error source points at the measure node", async () => {
    const m = edit((x) => patchMember(x, "Purchase", "revenue", { "@of": "Purchase.amount" }));
    const { errors } = await loadInline(m);
    expect(jsonPathOf(errors[0]!.source)).toContain("['measure.aggregate']");
  });
});

// ---------------------------------------------------------------------------
// S1 — segment / measure / report @filter field and op checks
// ---------------------------------------------------------------------------

describe("validateReporting — filters (S1)", () => {
  test("S1: a segment @filter over an unknown field is refused", async () => {
    const m = edit((x) => patchMember(x, "Purchase", "active", { "@filter": { state: "active" } }));
    const msg = await single(m, "ERR_BAD_ATTR_FILTER");
    expect(msg).toContain("'state'");
    expect(msg).toContain("segment 'active'");
  });

  test("S1: a segment @filter op illegal for the field is refused", async () => {
    const m = edit((x) => patchMember(x, "Purchase", "active", { "@filter": { refunded: { like: "x%" } } }));
    const msg = await single(m, "ERR_BAD_ATTR_FILTER");
    expect(msg).toContain("'like'");
  });

  test("S1: a measure @filter over an unknown field is refused", async () => {
    const m = edit((x) => patchMember(x, "Purchase", "revenue", { "@filter": { state: "x" } }));
    await single(m, "ERR_BAD_ATTR_FILTER");
  });

  test("S1: a report @filter over a field @from lacks is refused", async () => {
    const m = edit((x) => patchObject(x, "DailyRevenue", { "@filter": { eventType: "x" } }));
    const msg = await single(m, "ERR_BAD_ATTR_FILTER");
    expect(msg).toContain("report 'acme::shop::DailyRevenue'");
  });

  test("S1: and/or compositions are walked", async () => {
    const m = edit((x) =>
      patchMember(x, "Purchase", "active", {
        "@filter": { or: [{ status: "active" }, { and: [{ nope: 1 }] }] },
      }),
    );
    await single(m, "ERR_BAD_ATTR_FILTER");
  });
});

// ---------------------------------------------------------------------------
// R1–R7 — reports
// ---------------------------------------------------------------------------

describe("validateReporting — reports", () => {
  test("R1: @from naming nothing is refused, and R2/R3/R7 are skipped", async () => {
    const m = edit((x) => patchObject(x, "DailyRevenue", { "@from": "Nowhere" }));
    const msg = await single(m, "ERR_INVALID_REPORT");
    expect(msg).toContain("'Nowhere'");
  });

  test("R1: @from naming a non-entity object is refused", async () => {
    const m = edit((x) => patchObject(x, "DailyRevenue", { "@from": "StoreTotals" }));
    const msg = await single(m, "ERR_INVALID_REPORT");
    expect(msg).toContain("object.report");
  });

  test("R2: a dimension item naming no dimension of @from is refused", async () => {
    const m = edit((x) => patchObject(x, "StoreTotals", { "@dimensions": ["region"] }));
    const msg = await single(m, "ERR_INVALID_REPORT");
    expect(msg).toContain("'region'");
  });

  test("R2: a time dimension listed without a grain is refused", async () => {
    const m = edit((x) => patchObject(x, "DailyRevenue", { "@dimensions": ["purchasedAt"] }));
    const msg = await single(m, "ERR_INVALID_REPORT");
    expect(msg).toContain("grain");
  });

  test("R2: a grain the time dimension does not declare is refused", async () => {
    const m = edit((x) => patchObject(x, "DailyRevenue", { "@dimensions": ["purchasedAt:hour"] }));
    const msg = await single(m, "ERR_INVALID_REPORT");
    expect(msg).toContain("'hour'");
  });

  test("R2: an attribute dimension with a grain is refused", async () => {
    const m = edit((x) => patchObject(x, "StoreTotals", { "@dimensions": ["program:day"] }));
    await single(m, "ERR_INVALID_REPORT");
  });

  test("R2: a repeated dimension item is ONE error (not also R6)", async () => {
    const m = edit((x) =>
      patchObject(x, "DailyRevenue", { "@dimensions": ["purchasedAt:day", "purchasedAt:day"] }),
    );
    const msg = await single(m, "ERR_INVALID_REPORT");
    expect(msg).toContain("more than once");
  });

  test("R2: two grains of one time dimension are fine", async () => {
    const m = edit((x) =>
      patchObject(x, "DailyRevenue", { "@dimensions": ["purchasedAt:day", "purchasedAt:week"] }),
    );
    expect(await codes(m)).toEqual([]);
  });

  test("R3: a bare measure of another entity is ERR_REPORT_FOREIGN_MEASURE", async () => {
    const m = edit((x) => patchObject(x, "DailyRevenue", { "@measures": ["purchases", "starters"] }));
    const msg = await single(m, "ERR_REPORT_FOREIGN_MEASURE");
    expect(msg).toBe(
      "report 'acme::shop::DailyRevenue' lists measure 'starters', which belongs to 'acme::shop::WorkoutEvent', " +
        "not @from 'acme::shop::Purchase'. All measures of a report come from @from; make a second report over " +
        "'acme::shop::WorkoutEvent'.",
    );
  });

  test("R3: a dotted measure of another entity is ERR_REPORT_FOREIGN_MEASURE", async () => {
    const m = edit((x) =>
      patchObject(x, "DailyRevenue", { "@measures": ["purchases", "WorkoutEvent.starters"] }),
    );
    await single(m, "ERR_REPORT_FOREIGN_MEASURE");
  });

  test("R3: a measure that resolves nowhere is ERR_INVALID_REPORT", async () => {
    const m = edit((x) => patchObject(x, "DailyRevenue", { "@measures": ["purchases", "refunds"] }));
    const msg = await single(m, "ERR_INVALID_REPORT");
    expect(msg).toContain("'refunds'");
  });

  test("R3: a dotted measure of @from is fine", async () => {
    const m = edit((x) => patchObject(x, "DailyRevenue", { "@measures": ["Purchase.purchases", "revenue"] }));
    expect(await codes(m)).toEqual([]);
  });

  test("R4: a report declaring a field is refused", async () => {
    const m = edit((x) => {
      objectBody(x, "StoreTotals").children = [field("long", "purchases")];
    });
    const { errors } = await loadInline(m);
    expect(errors.map((e) => e.code)).toEqual(["ERR_INVALID_REPORT"]);
    expect(errors[0]!.message).toContain("field.long 'purchases'");
    expect(jsonPathOf(errors[0]!.source)).toContain("['field.long']");
  });

  test("R4: a report declaring an identity is refused", async () => {
    const m = edit((x) => {
      objectBody(x, "StoreTotals").children = [{ "identity.primary": { name: "id", "@fields": ["id"] } }];
    });
    const msg = await single(m, "ERR_INVALID_REPORT");
    expect(msg).toContain("identity.primary 'id'");
  });

  test("R5: a report with a writable source is refused", async () => {
    const m = edit((x) => {
      objectBody(x, "StoreTotals").children = [{ "source.rdb": { "@table": "store_totals" } }];
    });
    const msg = await single(m, "ERR_INVALID_REPORT");
    expect(msg).toBe(
      "report 'acme::shop::StoreTotals': source.rdb is writable; a report is read-only, so its source must " +
        "declare @kind: view.",
    );
  });

  test("R5: a report with a view source is fine", async () => {
    const m = edit((x) => {
      objectBody(x, "StoreTotals").children = [{ "source.rdb": { "@kind": "view", "@view": "store_totals" } }];
    });
    expect(await codes(m)).toEqual([]);
  });

  test("R6: a dimension and a measure deriving the same field name is refused", async () => {
    const m = edit((x) => {
      setChild(x, "Purchase", "purchasedAtDay", {
        "measure.aggregate": { name: "purchasedAtDay", "@agg": "count", "@of": "Purchase.id" },
      });
      patchObject(x, "DailyRevenue", { "@measures": ["purchasedAtDay"] });
    });
    const msg = await single(m, "ERR_INVALID_REPORT");
    expect(msg).toContain("'purchasedAtDay'");
  });

  test("R6: a measure listed twice is refused", async () => {
    const m = edit((x) => patchObject(x, "StoreTotals", { "@measures": ["revenue", "revenue"] }));
    const msg = await single(m, "ERR_INVALID_REPORT");
    expect(msg).toBe("report 'acme::shop::StoreTotals': @measures lists 'revenue' more than once.");
  });

  test("R7: a report @segment naming no segment of @from is refused", async () => {
    const m = edit((x) => patchObject(x, "StoreTotals", { "@segment": "completions" }));
    const msg = await single(m, "ERR_INVALID_REPORT");
    expect(msg).toContain("'completions'");
  });

  test("error source points at the report node", async () => {
    const m = edit((x) => patchObject(x, "StoreTotals", { "@segment": "completions" }));
    const { errors } = await loadInline(m);
    expect(jsonPathOf(errors[0]!.source)).toMatch(/\['object\.report'\]$/);
  });
});

// ---------------------------------------------------------------------------
// F1–F2 — relative-date filter values
// ---------------------------------------------------------------------------

describe("validateReporting — relative dates", () => {
  test("F2: the duration pattern accepts ISO-8601 durations and refuses the degenerate forms", () => {
    for (const ok of ["-P7D", "P1Y", "+P2W", "-PT12H", "P1Y2M3W4DT5H6M7S", "PT30M"]) {
      expect(ISO_DURATION_RE.test(ok)).toBe(true);
    }
    for (const bad of ["P", "-P", "PT", "P1DT", "7D", "P7", "-P7d", "P1.5D", ""]) {
      expect(ISO_DURATION_RE.test(bad)).toBe(false);
    }
  });

  test("F2: a relative value on a segment over a timestamp is fine", async () => {
    const m = edit((x) =>
      setChild(x, "WorkoutEvent", "recent", {
        "segment.filter": { name: "recent", "@filter": { occurredAt: { gte: { now: "-P7D" } } } },
      }),
    );
    expect(await codes(m)).toEqual([]);
  });

  test("F2: a relative value over a non-temporal field is refused", async () => {
    const m = edit((x) =>
      setChild(x, "WorkoutEvent", "recent", {
        "segment.filter": { name: "recent", "@filter": { dayNumber: { gte: { now: "-P7D" } } } },
      }),
    );
    const msg = await single(m, "ERR_BAD_ATTR_FILTER");
    expect(msg).toContain("field.int");
  });

  test("F2: a relative value under a non-range op is refused", async () => {
    const m = edit((x) =>
      setChild(x, "WorkoutEvent", "recent", {
        "segment.filter": { name: "recent", "@filter": { occurredAt: { eq: { now: "-P7D" } } } },
      }),
    );
    const msg = await single(m, "ERR_BAD_ATTR_FILTER");
    expect(msg).toContain("'eq'");
  });

  test("F2: a relative value inside an `in` list is refused", async () => {
    const m = edit((x) =>
      setChild(x, "WorkoutEvent", "recent", {
        "segment.filter": { name: "recent", "@filter": { occurredAt: { in: [{ now: "-P7D" }] } } },
      }),
    );
    await single(m, "ERR_BAD_ATTR_FILTER");
  });

  test("F2: 'P' alone is not a duration", async () => {
    const m = edit((x) => patchObject(x, "DailyRevenue", { "@filter": { purchasedAt: { gte: { now: "P" } } } }));
    const msg = await single(m, "ERR_BAD_ATTR_FILTER");
    expect(msg).toContain("'P'");
  });

  test("F2: a non-string duration is refused", async () => {
    const m = edit((x) => patchObject(x, "DailyRevenue", { "@filter": { purchasedAt: { gte: { now: 7 } } } }));
    await single(m, "ERR_BAD_ATTR_FILTER");
  });

  test("F1: a relative value on a measure.aggregate @filter is fine", async () => {
    const m = edit((x) =>
      patchMember(x, "Purchase", "revenue", { "@filter": { purchasedAt: { lt: { now: "-P1D" } } } }),
    );
    expect(await codes(m)).toEqual([]);
  });

  test("F1: a relative value in a projection @filter is refused", async () => {
    const m = edit((x) =>
      x["metadata.root"].children.push({
        "object.projection": {
          name: "RecentPurchase",
          "@filter": { purchasedAt: { gte: { now: "-P7D" } } },
          children: [
            { "source.rdb": { "@kind": "view", "@view": "recent_purchases" } },
            field("long", "id", { extends: "Purchase.id" }),
            field("timestamp", "purchasedAt", { extends: "Purchase.purchasedAt" }),
            { "identity.primary": { name: "id", extends: "Purchase.id" } },
          ],
        },
      }),
    );
    const msg = await single(m, "ERR_BAD_ATTR_FILTER");
    expect(msg).toContain("object.projection 'acme::shop::RecentPurchase'");
  });

  test("F1: a relative value in a dataGrid preset is refused", async () => {
    const m = edit((x) => {
      setChild(x, "WorkoutEvent", "occurredAt", field("timestamp", "occurredAt", { "@filterable": true }));
      setChild(x, "WorkoutEvent", "default", {
        "layout.dataGrid": {
          name: "default",
          "@columns": ["occurredAt"],
          "@filter": { occurredAt: { gte: { now: "-P7D" } } },
        },
      });
    });
    const { errors } = await loadInline(m);
    expect(errors.map((e) => e.code)).toEqual(["ERR_BAD_ATTR_FILTER"]);
    expect(errors[0]!.message).toContain("layout.dataGrid 'default'");
    expect(jsonPathOf(errors[0]!.source)).toContain("['layout.dataGrid']");
  });

  test("F1: a relative value in an origin.aggregate @filter is refused", async () => {
    const m = edit((x) =>
      x["metadata.root"].children.push({
        "object.projection": {
          name: "ProgramStats",
          children: [
            { "source.rdb": { "@kind": "view", "@view": "program_stats" } },
            field("long", "id", { extends: "Program.id" }),
            field("long", "recentPurchases", {
              children: [
                {
                  "origin.aggregate": {
                    "@agg": "count",
                    "@of": "Purchase.id",
                    "@via": "Program.purchases",
                    "@filter": { purchasedAt: { gte: { now: "-P7D" } } },
                  },
                },
              ],
            }),
            { "identity.primary": { name: "id", extends: "Program.id" } },
          ],
        },
      }),
    );
    const { errors } = await loadInline(m);
    expect(errors.map((e) => e.code)).toContain("ERR_BAD_ATTR_FILTER");
    const f1 = errors.filter((e) => e.message.includes("relative date"));
    expect(f1.length).toBe(1);
    expect(f1[0]!.message).toContain("origin.aggregate");
  });
});

// ---------------------------------------------------------------------------
// Inheritance (ADR-0039) — members declared on an abstract base
// ---------------------------------------------------------------------------

function inheritedModel(): Model {
  return {
    "metadata.root": {
      package: PKG,
      children: [
        {
          "object.entity": {
            name: "BaseEvent",
            abstract: true,
            children: [
              field("long", "id"),
              field("timestamp", "occurredAt"),
              { "dimension.time": { name: "occurredAt", "@of": "BaseEvent.occurredAt", "@grains": ["day", "week"] } },
              { "measure.aggregate": { name: "events", "@agg": "count", "@of": "BaseEvent.id" } },
            ],
          },
        },
        {
          "object.entity": {
            name: "WorkoutEvent",
            extends: "BaseEvent",
            children: [
              { "source.rdb": { "@table": "workout_events" } },
              field("string", "eventType"),
              primary(),
            ],
          },
        },
        {
          "object.report": {
            name: "DailyEvents",
            "@from": "WorkoutEvent",
            "@dimensions": ["occurredAt:day"],
            "@measures": ["events"],
          },
        },
      ],
    },
  };
}

describe("validateReporting — inherited members", () => {
  test("a report over a concrete entity resolves members declared on its abstract base", async () => {
    expect(await codes(inheritedModel())).toEqual([]);
  });

  test("a broken member on an abstract base is reported ONCE, not once per inheritor", async () => {
    const m = inheritedModel();
    const base = objectBody(m, "BaseEvent").children as Wrapper[];
    base[3] = { "measure.aggregate": { name: "events", "@agg": "sum", "@of": "BaseEvent.nope" } };
    // The report's 'events' still resolves; only M1 fires.
    expect(await codes(m)).toEqual(["ERR_INVALID_MEASURE"]);
  });

  test("a broken base dimension and base segment filter are each reported ONCE", async () => {
    const m = inheritedModel();
    const base = objectBody(m, "BaseEvent").children as Wrapper[];
    base[2] = { "dimension.time": { name: "occurredAt", "@of": "BaseEvent.nope", "@grains": ["day", "week"] } };
    base.push({ "segment.filter": { name: "recent", "@filter": { nope: 1 } } });
    // The report's occurredAt:day still resolves (R2 reads the dimension, not its column).
    expect(await codes(m)).toEqual(["ERR_INVALID_DIMENSION", "ERR_BAD_ATTR_FILTER"]);
  });

  test("a broken base @via is reported ONCE", async () => {
    const m = inheritedModel();
    const base = objectBody(m, "BaseEvent").children as Wrapper[];
    base.push({
      "dimension.attribute": { name: "viaNothing", "@of": "BaseEvent.id", "@via": "BaseEvent.nope" },
    });
    expect(await codes(m)).toEqual(["ERR_INVALID_DIMENSION"]);
  });

  test("an inheritor whose override breaks an inherited member is reported, naming the inheritor", async () => {
    const m = inheritedModel();
    // WorkoutEvent overrides occurredAt as a string: the inherited time dimension
    // is fine on BaseEvent and broken on WorkoutEvent (D3).
    (objectBody(m, "WorkoutEvent").children as Wrapper[]).push(field("string", "occurredAt"));
    const msg = await single(m, "ERR_INVALID_DIMENSION");
    expect(msg).toBe(
      "dimension 'occurredAt' on entity 'acme::shop::BaseEvent' (inherited by 'acme::shop::WorkoutEvent'): a time " +
        "dimension's @of must be a field.date or field.timestamp, but 'BaseEvent.occurredAt' is field.string.",
    );
  });
});

// ---------------------------------------------------------------------------
// Accessors (Task 1 follow-up)
// ---------------------------------------------------------------------------

describe("report accessors", () => {
  test("reportDimensionItems parses name and name:grain", async () => {
    const { root } = await loadInline(fullReportingModel());
    const report = root.children().find((c) => c.name === "DailyRevenue")!;
    expect(reportDimensionItems(report)).toEqual([{ name: "purchasedAt", grain: "day" }]);
    const engagement = root.children().find((c) => c.name === "ProgramEngagement")!;
    expect(reportDimensionItems(engagement)).toEqual([{ name: "program" }]);
  });

  test("reportDerivedFieldName suffixes the capitalized grain; a bare name stays bare", () => {
    expect(reportDerivedFieldName({ name: "purchasedAt", grain: "day" })).toBe("purchasedAtDay");
    expect(reportDerivedFieldName({ name: "purchasedAt", grain: "quarter" })).toBe("purchasedAtQuarter");
    expect(reportDerivedFieldName({ name: "program" })).toBe("program");
  });

  test("MetaMeasure.ofColumns: a bare string @of is a one-element list; a list is the tuple", async () => {
    const { root } = await loadInline(fullReportingModel());
    const purchase = root.children().find((c) => c.name === "Purchase")!;
    const revenue = purchase.children().find((c) => c.name === "revenue")!;
    expect(revenue).toBeInstanceOf(MetaMeasure);
    expect((revenue as MetaMeasure).ofColumns()).toEqual(["Purchase.amountCents"]);
    const event = root.children().find((c) => c.name === "WorkoutEvent")!;
    const days = event.children().find((c) => c.name === "daysEngaged") as MetaMeasure;
    expect(days.ofColumns()).toEqual([
      "WorkoutEvent.programId",
      "WorkoutEvent.weekNumber",
      "WorkoutEvent.dayNumber",
    ]);
  });
});
