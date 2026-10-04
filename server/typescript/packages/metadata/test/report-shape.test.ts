import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  InMemoryStringSource,
  MetaDataLoader,
  OBJECT_REPORT_ATTR_DIMENSIONS,
  OBJECT_REPORT_ATTR_MEASURES,
  loadUris,
  reportMeasureItemName,
  reportShape,
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
