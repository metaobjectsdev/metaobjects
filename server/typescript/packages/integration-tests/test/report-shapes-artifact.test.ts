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

import { generateReportShapesJson, readReportShapesJson } from "../src/gen-report-shapes.ts";
import { loadMetadataDir } from "../src/load-metadata.ts";
import { CANONICAL_DIR, REPORT_SHAPES_PATH } from "../src/paths.ts";

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

  test("the canonical reports appear in declaration order, with the contract's byte format", () => {
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
      ["fitness::ProgramRoster", "v_program_roster"],
      ["fitness::ProgramLongWeeks", "v_program_long_weeks"],
      ["fitness::ProgramFlags", "v_program_flags"],
      ["fitness::ProgramFlagRoster", "v_program_flag_roster"],
      ["fitness::FitnessTotalsFilled", "v_fitness_totals_filled"],
      ["fitness::MeasurementStats", "v_measurement_stats"],
      ["fitness::MeasurementStatsFilled", "v_measurement_stats_filled"],
      ["fitness::AssetDays", "v_asset_days"],
      ["fitness::AllTypesBreakdown", "v_all_types_breakdown"],
      ["fitness::ProgramsOverTime", "v_programs_over_time"],
      ["fitness::LiveIntroPrograms", "v_live_intro_programs"],
      ["fitness::ProgramsEmptyScope", "v_programs_empty_scope"],
      ["fitness::WeekShapes", "v_week_shapes"],
      ["fitness::SessionsByProgram", "v_sessions_by_program"],
      ["fitness::ProgramSessions", "v_program_sessions"],
      ["fitness::NodesByParent", "v_nodes_by_parent"],
      ["fitness::AuthsByKind", "v_auths_by_kind"],
      ["fitness::GadgetEventsByLabel", "v_gadget_events_by_label"],
      ["fitness::EntryTotals", "v_entry_totals"],
    ]);
  });

  test("@spine and @default (Table C): a spine key and a defaulted measure are required, their undefaulted twins are not", () => {
    type Field = { name: string; role: string; subType: string; required: boolean };
    const parsed = JSON.parse(readReportShapesJson()) as { reports: { report: string; fields: Field[] }[] };
    const fields = (report: string): [string, string, string, boolean][] =>
      (parsed.reports.find((r) => r.report === report)?.fields ?? []).map((f) => [f.name, f.role, f.subType, f.required]);

    expect(fields("fitness::ProgramRoster")).toEqual([
      ["programKey", "dimension", "long", true],
      ["programTitle", "dimension", "string", true],
      ["weeks", "measure", "long", true],
      ["totalMinutes", "measure", "long", false],
      ["totalMinutesOrZero", "measure", "long", true],
      ["longShare", "measure", "decimal", false],
      ["longShareOrZero", "measure", "decimal", true],
    ]);
    // Table B / C for `@agg: any` / `all`: boolean whatever the source, and required only with a @default.
    expect(fields("fitness::ProgramFlagRoster")).toEqual([
      ["programKey", "dimension", "long", true],
      ["weeks", "measure", "long", true],
      ["anyDeload", "measure", "boolean", false],
      ["anyDeloadOrFalse", "measure", "boolean", true],
      ["allDeloadOrTrue", "measure", "boolean", true],
    ]);
    expect(fields("fitness::ProgramLongWeeks")).toEqual([
      ["programKey", "dimension", "long", true],
      ["weeks", "measure", "long", true],
      ["totalMinutesOrZero", "measure", "long", true],
    ]);
    expect(fields("fitness::FitnessTotalsFilled")).toEqual([
      ["weeks", "measure", "long", true],
      ["totalMinutesOrZero", "measure", "long", true],
      ["longShareOrZero", "measure", "decimal", true],
    ]);
    // The decimal wire reports (ADR-0019 Amendment 1): every decimal measure is typed, so a runner
    // knows to hold it to the canonical string.
    expect(fields("fitness::EntryTotals")).toEqual([
      ["bucket", "dimension", "string", true],
      ["entries", "measure", "long", true],
      ["total", "measure", "decimal", false],
      ["totalOrZero", "measure", "decimal", true],
      ["mean", "measure", "decimal", false],
      ["top", "measure", "decimal", false],
      ["flaggedShare", "measure", "decimal", false],
      ["perFlagged", "measure", "decimal", false],
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
