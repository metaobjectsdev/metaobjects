// A report dimension's `required` comes from the model, not from "every join is
// INNER" (every generated view join is LEFT OUTER now). The shared table lives in
// fixtures/conformance/report-dimension-required-by-model/expected-report-required.json; C#
// (ReportShapeTests) reads the same file.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { reportShape } from "../src/core/reporting/report-shape.js";

const FIXTURE = join(import.meta.dir, "../../../../../fixtures/conformance/report-dimension-required-by-model");

describe("report-dimension-required-by-model", () => {
  test("every field's required is the shared table's", async () => {
    const { root, errors } = await MetaDataLoader.fromDirectory(join(FIXTURE, "input"));
    expect(errors).toEqual([]);
    const expected = JSON.parse(readFileSync(join(FIXTURE, "expected-report-required.json"), "utf8")) as {
      report: string; required: Record<string, boolean>;
    };
    const report = root.objects().find((o) => o.resolutionKey() === expected.report)!;
    const actual = Object.fromEntries(reportShape(report, root).fields.map((f) => [f.name, f.required]));
    expect(actual).toEqual(expected.required);
  });
});
