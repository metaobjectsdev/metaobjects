import { test, expect, describe } from "bun:test";
import { formatGenResultToon, genResultToData } from "../../src/lib/output.js";

const result = {
  files: [
    { path: "src/User.ts", status: "new" as const, info: "" },
    { path: "src/User.routes.ts", status: "unchanged" as const, info: "" },
  ],
  outDir: "src", dialect: "sqlite" as const, dryRun: false, warnings: [],
};

describe("gen TOON output (axi)", () => {
  test("data has tabular files, aggregate summary, and next-step help", () => {
    const d = genResultToData(result) as any;
    expect(d.gen).toHaveLength(2);
    expect(d.gen[0]).toEqual({ file: "src/User.ts", status: "new" });
    expect(d.summary).toContain("1 written");     // aggregate inline
    expect(d.summary).toContain("1 unchanged");
    expect(Array.isArray(d.help)).toBe(true);      // next-step suggestions
    expect(d.help.join(" ")).toContain("tsc");     // build hint
  });
  test("TOON string collapses the file array to a tabular block", () => {
    const s = formatGenResultToon(result);
    expect(s).toContain("gen[2]{file,status}:");
    expect(s).toContain("src/User.ts,new");
  });
  test("empty gen states the zero explicitly (axi definitive empty state)", () => {
    const d = genResultToData({ ...result, files: [] }) as any;
    expect(d.summary.toLowerCase()).toContain("no entities");
  });
});
