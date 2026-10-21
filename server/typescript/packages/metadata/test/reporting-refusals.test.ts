// FR-044 — what a report refuses at load, with the message text every port copies:
//   D5 / M10  a dimension or measure over a field.object (or a field carrying @objectRef)
//   R10       a report source whose @kind is not `view`
//   R11       an abstract report
// The conformance fixtures (error-dimension-over-object, error-measure-over-object,
// error-report-source-kind-*, error-report-abstract) gate the codes and the node; this file
// pins the text.

import { describe, expect, test } from "bun:test";
import { InMemoryStringSource, MetaDataLoader } from "../src/index.js";

const value = { "object.value": { name: "Tags", children: [{ "field.string": { name: "label" } }] } };
const event = (extra: unknown[]) => ({
  "object.entity": {
    name: "Event",
    children: [
      { "source.rdb": { "@table": "events" } },
      { "field.long": { name: "id" } },
      { "field.string": { name: "kind" } },
      { "field.object": { name: "payload", "@objectRef": "acme::Tags", "@storage": "jsonb" } },
      { "identity.primary": { name: "id", "@fields": ["id"] } },
      ...extra,
    ],
  },
});
const ok = [
  { "dimension.attribute": { name: "kind", "@of": "Event.kind" } },
  { "measure.aggregate": { name: "events", "@agg": "count", "@of": "Event.id" } },
];
const report = (source: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => ({
  "object.report": {
    name: "EventCounts", "@from": "Event", "@dimensions": ["kind"], "@measures": ["events"], ...extra,
    ...(source ? { children: [{ "source.rdb": source }] } : {}),
  },
});

async function errorsOf(children: unknown[]): Promise<{ code: string; message: string }[]> {
  const src = new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: "acme", children } }));
  const { errors } = await new MetaDataLoader().load([src]);
  return errors.map((e) => ({ code: (e as Error & { code: string }).code, message: e.message }));
}

describe("a report over a field.object", () => {
  test("D5: a dimension over it is ERR_INVALID_DIMENSION", async () => {
    const errs = await errorsOf([value, event([...ok, { "dimension.attribute": { name: "payload", "@of": "Event.payload" } }])]);
    expect(errs.map((e) => e.code)).toEqual(["ERR_INVALID_DIMENSION"]);
    expect(errs[0]!.message).toContain("@of 'Event.payload' is a field.object with an @objectRef, which a report cannot group by. Group by a scalar field of it.");
  });
  test("M10: a measure over it is ERR_INVALID_MEASURE, whatever the aggregate", async () => {
    for (const agg of ["count", "max"]) {
      const errs = await errorsOf([value, event([...ok, { "measure.aggregate": { name: "p", "@agg": agg, "@of": "Event.payload" } }])]);
      expect(errs.map((e) => e.code)).toEqual(["ERR_INVALID_MEASURE"]);
      expect(errs[0]!.message).toContain("@of 'Event.payload' is a field.object with an @objectRef, which a report cannot aggregate. Aggregate a scalar field of it.");
    }
  });
});

describe("a report source", () => {
  test("R10: only @kind view is read; the others are ERR_INVALID_REPORT on the source", async () => {
    const kinds: [string, Record<string, unknown>][] = [
      ["materializedView", { "@kind": "materializedView", "@materializedView": "mv" }],
      ["storedProc", { "@kind": "storedProc", "@proc": "sp" }],
      ["tableFunction", { "@kind": "tableFunction", "@function": "fn" }],
    ];
    for (const [kind, src] of kinds) {
      const errs = await errorsOf([value, event(ok), report(src)]);
      expect(errs.map((e) => e.code)).toEqual(["ERR_INVALID_REPORT"]);
      expect(errs[0]!.message).toContain(`has @kind '${kind}'; a report is read through a view, so its source must be @kind: view.`);
      expect(errs[0]!.message).toContain("declare @kind: view with @unmanaged: true.");
    }
  });
  test("R10: a view, an @unmanaged view and an @sql view load", async () => {
    for (const src of [
      { "@kind": "view", "@view": "v" },
      { "@kind": "view", "@view": "v", "@unmanaged": true },
      { "@kind": "view", "@view": "v", "@sql": "SELECT 1" },
    ]) {
      expect(await errorsOf([value, event(ok), report(src)])).toEqual([]);
    }
  });
  test("R11: an abstract report is ERR_INVALID_REPORT", async () => {
    const errs = await errorsOf([value, event(ok), report({ "@kind": "view", "@view": "v" }, { abstract: true })]);
    expect(errs.map((e) => e.code)).toEqual(["ERR_INVALID_REPORT"]);
    expect(errs[0]!.message).toContain("a report cannot be abstract");
  });
});
