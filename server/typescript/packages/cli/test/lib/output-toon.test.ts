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
  applied: [],
  applyFailed: false,
};

describe("migrate TOON output (axi)", () => {
  test("migrate TOON: tabular changes + status + applied count", () => {
    const d = migrateResultToData(migrateResult) as any;
    expect(d.changes[0]).toHaveProperty("kind");
    expect(typeof d.summary).toBe("string");
    expect(formatMigrateResultToon(migrateResult)).toContain("changes[");
  });
  test("files-only run (no --apply) reports 'wrote', not 'applied'", () => {
    const d = migrateResultToData(migrateResult) as any;
    expect(d.changes).toHaveLength(1);
    expect(d.changes[0]).toEqual({ kind: "create-table", count: 1 });
    expect(d.written).toEqual(["migrations/V1__create_user.sql"]);
    expect(d.summary).toContain("1 create-table");
    expect(d.summary).toContain("wrote");
    expect(d.summary).not.toContain("applied");
    expect(Array.isArray(d.help)).toBe(true);
    expect(d.help.join(" ")).toContain("--apply");
    // The rollback hint must NOT appear when nothing was applied.
    expect(d.help.join(" ")).not.toContain("--rollback");
  });
  test("a successful --apply run reports 'applied N' and the rollback hint", () => {
    const d = migrateResultToData({ ...migrateResult, applied: ["V1__create_user.sql"] }) as any;
    expect(d.summary).toContain("applied 1 migration(s)");
    expect(d.help.join(" ")).toContain("--rollback");
  });
  test("a failed --apply run reports 'apply failed', never 'applied'", () => {
    const d = migrateResultToData({ ...migrateResult, applyFailed: true }) as any;
    expect(d.summary).toContain("apply failed");
    expect(d.summary).not.toContain("; applied");
    expect(d.help.join(" ")).not.toContain("--rollback");
  });
  test("a --dry-run run reports preview-only and never 'applied'", () => {
    const d = migrateResultToData({ ...migrateResult, writtenPaths: [], dryRun: true }) as any;
    expect(d.summary).toContain("preview only");
    expect(d.summary).not.toContain("applied");
    expect(d.help.join(" ")).toContain("--dry-run");
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
  test("in-sync metadata but applied a pending ledger file reports 'applied'", () => {
    const d = migrateResultToData({
      ...migrateResult,
      changeCounts: {},
      writtenPaths: [],
      applied: ["V1__create_user.sql"],
    }) as any;
    expect(d.summary).toContain("applied 1 migration(s)");
    expect(d.summary.toLowerCase()).not.toContain("no schema changes");
    expect(d.help.join(" ")).toContain("--rollback");
  });
  test("dry-run with no changes reports 'no schema changes', never preview", () => {
    const d = migrateResultToData({
      ...migrateResult,
      changeCounts: {},
      writtenPaths: [],
      dryRun: true,
    }) as any;
    expect(d.summary.toLowerCase()).toContain("no schema changes");
    expect(d.summary).not.toContain("preview");
    expect(d.summary).not.toContain("applied");
  });
});
