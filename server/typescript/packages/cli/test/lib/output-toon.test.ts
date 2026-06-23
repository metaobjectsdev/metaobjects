import { test, expect, describe } from "bun:test";
import { formatGenResultToon, genResultToData, formatMigrateResultToon, migrateResultToData } from "../../src/lib/output.js";

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

// ---------------------------------------------------------------------------
// migrate TOON output (axi)
// ---------------------------------------------------------------------------

const migrateResult = {
  dialect: "sqlite" as const,
  displayUrl: "file:local.db",
  changeCounts: { "create-table": 1 },
  blocked: [],
  ambiguous: [],
  writtenPaths: ["migrations/V1__create_user.sql"],
  dryRun: false,
};

describe("migrate TOON output (axi)", () => {
  test("migrate TOON: tabular changes + status + applied count", () => {
    const d = migrateResultToData(migrateResult) as any;
    expect(d.changes[0]).toHaveProperty("kind");
    expect(typeof d.summary).toBe("string");
    expect(formatMigrateResultToon(migrateResult)).toContain("changes[");
  });
  test("data has tabular changes, written list, aggregate summary, and next-step help", () => {
    const d = migrateResultToData(migrateResult) as any;
    expect(d.changes).toHaveLength(1);
    expect(d.changes[0]).toEqual({ kind: "create-table", count: 1 });
    expect(d.written).toEqual(["migrations/V1__create_user.sql"]);
    expect(d.summary).toContain("1 create-table");
    expect(d.summary).toContain("applied");
    expect(Array.isArray(d.help)).toBe(true);
    expect(d.help.join(" ")).toContain("--rollback");
  });
  test("TOON string collapses the changes array to a tabular block", () => {
    const s = formatMigrateResultToon(migrateResult);
    expect(s).toContain("changes[1]{kind,count}:");
    expect(s).toContain("create-table,1");
  });
  test("blocked entries produce allow hint in help", () => {
    const blocked = {
      ...migrateResult,
      writtenPaths: [],
      blocked: [{ kind: "drop-table", description: "users table dropped", allowFlag: "drop-table" }],
    };
    const d = migrateResultToData(blocked) as any;
    expect(d.summary).toContain("not applied");
    expect(d.help.join(" ")).toContain("--allow");
  });
  test("no-change state states zero explicitly", () => {
    const d = migrateResultToData({ ...migrateResult, changeCounts: {}, writtenPaths: [] }) as any;
    expect(d.summary.toLowerCase()).toContain("no schema changes");
  });
});
