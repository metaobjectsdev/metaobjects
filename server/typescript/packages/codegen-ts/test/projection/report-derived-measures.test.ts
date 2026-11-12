// FR-044 R13 — a measure.derived lowers to arithmetic over its operands' full expressions: a
// measure reads its aggregate (condition and default included), a dimension reads the column the
// view groups by, and `divide` divides as a ratio does. The model is the shared conformance
// fixture, so the loader rules and the lowering see one model.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryStringSource, MetaDataLoader } from "@metaobjectsdev/metadata";
import { buildReportViews } from "../../src/projection/build-projection-views.js";
import { buildCubeModel } from "../../src/cube/build-cube-model.js";

const FIXTURE = join(
  import.meta.dir,
  "../../../../../../fixtures/conformance/reporting-derived-measures/input/meta.studio.json",
);

type Json = Record<string, unknown>;
const DIMENSION_READERS = new Set(["capacityHours", "utilization", "budgetBurn"]);

/** The fixture, or (for Cube) the fixture without the derived measures that read a dimension. */
async function load(measuresOnly = false) {
  const doc = JSON.parse(readFileSync(FIXTURE, "utf8")) as Json;
  if (measuresOnly) {
    const children = (doc["metadata.root"] as { children: Json[] }).children;
    const entity = children.find((c) => (c["object.entity"] as Json | undefined)?.name === "TimeEntry")!;
    const ec = entity["object.entity"] as { children: Json[] };
    ec.children = ec.children.filter((c) => !DIMENSION_READERS.has(String((c["measure.derived"] as Json | undefined)?.name)));
    (doc["metadata.root"] as { children: Json[] }).children = children
      .filter((c) => (c["object.report"] as Json | undefined)?.name !== "ProjectBurn")
      .map((c) => {
        const r = c["object.report"] as { "@measures": string[] } | undefined;
        if (r !== undefined) r["@measures"] = r["@measures"].filter((m) => !DIMENSION_READERS.has(m));
        return c;
      });
  }
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(doc))]);
  expect(errors).toEqual([]);
  return root;
}

async function views(dialect: "postgres" | "sqlite" | "mysql"): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const v of buildReportViews(await load(), { dialect })) out[v.name] = v.sql;
  return out;
}

const BILLABLE = {
  postgres: `COALESCE(SUM(t."hours") FILTER (WHERE t."billable" = TRUE), 0)`,
  sqlite: `COALESCE(SUM(CASE WHEN t."billable" = 1 THEN t."hours" END), 0.0)`,
};

describe("FR-044 R13: derived measures in a report view", () => {
  for (const [dialect, real] of [["postgres", "NUMERIC"], ["sqlite", "REAL"]] as const) {
    test(`${dialect}: utilization divides billable hours by the grouped capacity`, async () => {
      const sql = (await views(dialect))["v_memberutilization"] ?? "";
      const capacity = `CAST(m."weekly_capacity_hours" * 52 AS ${real}) / 12`;
      expect(sql).toContain(`${capacity} AS "capacity_hours"`);
      expect(sql).toContain(`CAST(${BILLABLE[dialect]} * 100 AS ${real}) / NULLIF(${capacity}, 0) AS "utilization"`);
      expect(sql).toMatch(/GROUP BY[^;]*m\."weekly_capacity_hours"/);
    });

    test(`${dialect}: a subtraction of two measures is cast to the decimal it is typed as`, async () => {
      const sql = (await views(dialect))["v_memberutilization"] ?? "";
      expect(sql).toContain(`AS "non_billable_hours"`);
      expect(sql).toMatch(new RegExp(`CAST\\(COALESCE\\(SUM\\(t\\."hours"\\), 0(\\.0)?\\) - .* AS ${real}\\) AS "non_billable_hours"`));
    });

    test(`${dialect}: a ratio operand is parenthesised under the multiplication`, async () => {
      const sql = (await views(dialect))["v_memberutilization"] ?? "";
      expect(sql).toMatch(new RegExp(`CAST\\(\\(CAST\\(.* / NULLIF\\(.*\\)\\) \\* 100 AS ${real}\\) AS "billable_share_pct"`));
    });

    test(`${dialect}: budget burn divides cost by the project's budget, null when it is 0`, async () => {
      const sql = (await views(dialect))["v_projectburn"] ?? "";
      expect(sql).toContain(`CAST(SUM(t."cost") AS ${real}) / NULLIF(p."budget", 0) AS "budget_burn"`);
    });
  }

  test("mysql divides without a cast and keeps the operator precedence", async () => {
    const sql = (await views("mysql"))["v_memberutilization"] ?? "";
    expect(sql).toContain("(m.`weekly_capacity_hours` * 52) / 12 AS `capacity_hours`");
  });

  test("Cube: a derived measure over measures is a number member reading them", async () => {
    const model = buildCubeModel(await load(true), { dialect: "postgres" });
    const cube = model.cubes.find((c) => c.name.toLowerCase().includes("timeentr"))!;
    const derived = cube.measures.find((m) => m.name === "nonBillableHours")!;
    expect(derived.type).toBe("number");
    expect(derived.sql).toBe("{totalHours} - {billableHours}");
    const pct = cube.measures.find((m) => m.name === "billableSharePct")!;
    expect(pct.sql).toBe("{billableShare} * 100");
  });

  test("Cube: a derived measure that reads a dimension is refused", async () => {
    const root = await load();
    expect(() => buildCubeModel(root, { dialect: "postgres" })).toThrow(/ERR_CUBE_DERIVED_DIMENSION/);
  });
});
