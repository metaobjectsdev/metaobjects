// report-shapes-artifact.test.ts — drift-check for the committed report-shapes artifact.
//
// No DB required. Regenerates the derived fields of every canonical object.report from
// canonical/meta.fitness.json and asserts they are byte-identical to the committed
// fixtures/persistence-conformance/report-shapes.json, which every other port
// byte-matches against its own derivation (contract Table B).
//
// Regenerate the artifact with: `bun run gen:report-shapes` (in this package).

import { describe, expect, test } from "bun:test";

import { InMemoryStringSource, MetaDataLoader } from "@metaobjectsdev/metadata";

import {
  generateReportShapesJson,
  readReportShapesJson,
  REPORT_SHAPES_PATH,
} from "../src/gen-report-shapes.ts";
import { loadMetadataDir } from "../src/load-metadata.ts";
import { CANONICAL_DIR } from "../src/paths.ts";

describe("canonical report-shapes artifact (report-shapes.json)", () => {
  test("committed shapes match what TS derives from metadata (no drift)", async () => {
    const root = await loadMetadataDir(CANONICAL_DIR);
    const generated = generateReportShapesJson(root);
    const committed = readReportShapesJson();

    if (generated !== committed) {
      throw new Error(
        `Report-shapes artifact is stale.\n` +
          `  ${REPORT_SHAPES_PATH}\n` +
          `differs from what TS derives from canonical/meta.fitness.json.\n` +
          `Run \`bun run gen:report-shapes\` to regenerate, then commit the result.`,
      );
    }
    expect(generated).toBe(committed);
  });

  test("the six canonical reports appear in declaration order, with the contract's byte format", () => {
    const committed = readReportShapesJson();
    expect(committed.endsWith("}\n")).toBe(true);
    expect(committed.startsWith('{\n  "reports": [\n    {\n      "report": "fitness::ProgramMinutes"')).toBe(true);
    const parsed = JSON.parse(committed) as { reports: { report: string; view: string | null }[] };
    expect(parsed.reports.map((r) => [r.report, r.view])).toEqual([
      ["fitness::ProgramMinutes", "v_program_minutes"],
      ["fitness::FitnessTotals", "v_fitness_totals"],
      ["fitness::ProgramsByMonth", "v_programs_by_month"],
      ["fitness::ProgramsByWeek", "v_programs_by_week"],
      ["fitness::RecentPrograms", "v_recent_programs"],
      ["fitness::AssetActivity", "v_asset_activity"],
    ]);
  });

  test("`view` is the source the lowering names and the runtime reads: primary, else first", async () => {
    // A replica declared BEFORE the primary must not name the report's view.
    const model = {
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "Sale",
              children: [
                { "source.rdb": { "@table": "sales" } },
                { "field.long": { name: "id" } },
                { "identity.primary": { name: "pk", "@fields": ["id"] } },
                { "measure.aggregate": { name: "sales", "@agg": "count", "@of": "Sale.id" } },
              ],
            },
          },
          {
            "object.report": {
              name: "Totals",
              "@from": "Sale",
              "@measures": ["sales"],
              children: [
                { "source.rdb": { "@kind": "view", "@view": "v_totals_replica", "@role": "replica" } },
                { "source.rdb": { "@kind": "view", "@view": "v_totals", "@role": "primary" } },
              ],
            },
          },
        ],
      },
    };
    const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(model))]);
    expect(errors).toEqual([]);
    const parsed = JSON.parse(generateReportShapesJson(root)) as { reports: { view: string | null }[] };
    expect(parsed.reports.map((r) => r.view)).toEqual(["v_totals"]);
  });
});
