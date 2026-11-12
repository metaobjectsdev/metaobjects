// FR-044 R12 — a report over a member of a flattened value object reads the member's own
// column, the one `meta migrate` creates (`amount_amount`, `amount_currency`), in every dialect.
// The model is the shared conformance fixture, so the loader rules and the lowering see one model.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryStringSource, MetaDataLoader } from "@metaobjectsdev/metadata";
import { buildReportViews } from "../../src/projection/build-projection-views.js";
import { buildCubeModel } from "../../src/cube/build-cube-model.js";

const FIXTURE = join(
  import.meta.dir,
  "../../../../../../fixtures/conformance/reporting-value-object-members/input/meta.billing.json",
);

async function load() {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(readFileSync(FIXTURE, "utf8"))]);
  expect(errors).toEqual([]);
  return root;
}

async function views(dialect: "postgres" | "sqlite"): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const v of buildReportViews(await load(), { dialect })) out[v.name] = v.sql;
  return out;
}

describe("FR-044 R12: value-object members in a report view", () => {
  for (const dialect of ["postgres", "sqlite"] as const) {
    test(`${dialect}: sums the amount column and groups by the currency column`, async () => {
      const sql = (await views(dialect))["v_revenuebymonth"] ?? "";
      expect(sql).toContain(`"amount_currency" AS "currency"`);
      expect(sql).toContain(`SUM(p."amount_amount")`);
      expect(sql).toContain(`MAX(p."amount_amount")`);
      expect(sql).toMatch(/GROUP BY[^;]*"amount_currency"/);
    });
  }

  test("a distinct count over a member reads its column", async () => {
    const sql = (await views("postgres"))["v_currencymix"] ?? "";
    expect(sql).toContain(`COUNT(DISTINCT p."amount_currency")`);
  });

  test("the Cube exporter refuses a member rather than let a query add amounts across currencies", async () => {
    const root = await load();
    expect(() => buildCubeModel(root, { dialect: "postgres" })).toThrow(/ERR_CUBE_VALUE_OBJECT_MEMBER/);
  });
});
