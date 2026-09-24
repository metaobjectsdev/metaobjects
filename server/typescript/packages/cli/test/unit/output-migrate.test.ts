import { describe, test, expect } from "bun:test";
import { formatMigrateResult, migrateResultToData } from "../../src/lib/output.js";

describe("formatMigrateResult", () => {
  test("clean migration written", () => {
    const out = formatMigrateResult({
      dialect: "sqlite",
      displayUrl: "file:./local.db",
      changeCounts: { "add-column": 4, "rename-column": 1 },
      blocked: [],
      ambiguous: [],
      writtenPaths: [
        ".metaobjects/migrations/20260512143200-add-user-shipping.up.sql",
        ".metaobjects/migrations/20260512143200-add-user-shipping.down.sql",
      ],
      dryRun: false,
    }, { isTTY: false });
    expect(out).toContain("sqlite");
    expect(out).toContain("file:./local.db");
    expect(out).toContain("4 add-column");
    expect(out).toContain("1 rename-column");
    expect(out).toContain("Written:");
    expect(out).toContain(".up.sql");
    expect(out).toContain(".down.sql");
  });

  test("no changes", () => {
    const out = formatMigrateResult({
      dialect: "sqlite",
      displayUrl: "file:./local.db",
      changeCounts: {},
      blocked: [],
      ambiguous: [],
      writtenPaths: [],
      dryRun: false,
    }, { isTTY: false });
    expect(out).toContain("No schema changes");
  });

  test("blocked changes listed with allow flag hint", () => {
    const out = formatMigrateResult({
      dialect: "sqlite",
      displayUrl: "file:./local.db",
      changeCounts: { "drop-column": 1 },
      blocked: [
        { kind: "drop-column", description: "User.legacy_email", allowFlag: "drop-column" },
      ],
      ambiguous: [],
      writtenPaths: [],
      dryRun: false,
    }, { isTTY: false });
    expect(out).toContain("Blocked");
    expect(out).toContain("drop-column");
    expect(out).toContain("User.legacy_email");
    expect(out).toContain("--allow drop-column");
    expect(out).toContain("No migration written");
  });

  test("ambiguous changes listed with on-ambiguous hint", () => {
    const out = formatMigrateResult({
      dialect: "sqlite",
      displayUrl: "file:./local.db",
      changeCounts: {},
      blocked: [],
      ambiguous: [
        {
          kind: "possible-column-rename",
          description: "User.email_addr → User.email",
          hint: "column-set overlap 1.0",
        },
      ],
      writtenPaths: [],
      dryRun: false,
    }, { isTTY: false });
    expect(out).toContain("Ambiguous");
    expect(out).toContain("email_addr");
    expect(out).toContain("--on-ambiguous");
  });

  test("dry-run header reads --dry-run", () => {
    const out = formatMigrateResult({
      dialect: "sqlite",
      displayUrl: "file:./local.db",
      changeCounts: { "add-column": 1 },
      blocked: [],
      ambiguous: [],
      writtenPaths: [],
      dryRun: true,
    }, { isTTY: false });
    expect(out).toContain("--dry-run");
  });
});

describe("migrateResultToData — data-hazard warnings", () => {
  const base = {
    dialect: "postgres" as const, displayUrl: "postgres://x", changeCounts: { "add-column": 1 },
    blocked: [], ambiguous: [], writtenPaths: [], dryRun: true,
  };

  test("structured output carries the warnings a text run prints on stderr", () => {
    const w = "shipment.mode is added NOT NULL with no default — fails if shipment has rows.";
    expect(migrateResultToData({ ...base, warnings: [w] }).warnings).toEqual([w]);
  });

  test("no hazard keeps the existing shape (no warnings key)", () => {
    expect("warnings" in migrateResultToData({ ...base, warnings: [] })).toBe(false);
    expect("warnings" in migrateResultToData(base)).toBe(false);
  });
});
