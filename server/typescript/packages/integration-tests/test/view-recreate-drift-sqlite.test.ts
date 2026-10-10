/**
 * D3 — managed views over a drifted table, against a REAL SQLite (and the D1 diff over it).
 *
 * An adopter replayed `meta migrate`'s own CREATE VIEW DDL, so every report and projection
 * view's stored SQL was byte-identical to the metadata's. The tables under those views had
 * unrelated drift (an FK), and SQLite rebuilds a table to change one, which strands the views
 * reading it (#243). So the diff drops and recreates those views, and `verify --db` printed
 * each as `- view` / `+ view` with no word on what differed. It could not tell the adopter
 * whether any view matched the metadata.
 *
 * The recreate pair is real migration SQL and stays. What changes: the pair says the view is
 * unchanged, a drift report leaves it out, and the pair still applies and converges.
 */
import { describe, test, expect, beforeEach, afterEach, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, sql } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import {
  buildExpectedSchema, computeDriftFromActual, diff, emit, introspectSqlite, isViewRecreateOnly,
  type Change, type SchemaSnapshot,
} from "@metaobjectsdev/migrate-ts";
import { buildProjectionViews } from "@metaobjectsdev/codegen-ts";
import type { MetaRoot } from "@metaobjectsdev/metadata";
import { loadMetadataDir } from "../src/load-metadata.ts";
import { CANONICAL_DIR } from "../src/paths.ts";

let tmpDir: string;
let k: Kysely<Record<string, unknown>>;
let canonical: MetaRoot;

beforeAll(async () => { canonical = await loadMetadataDir(CANONICAL_DIR); });
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "view-recreate-drift-"));
  k = new Kysely({ dialect: new LibsqlDialect({ url: `file:${join(tmpDir, "test.db")}` }) });
});
afterEach(async () => {
  await k.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

const STRATEGY = "literal" as const;

function viewsFor(dialect: "sqlite" | "d1") {
  return buildProjectionViews(canonical, { dialect, columnNamingStrategy: STRATEGY });
}

function expectedFor(dialect: "sqlite" | "d1"): SchemaSnapshot {
  return buildExpectedSchema(canonical, { dialect, columnNamingStrategy: STRATEGY, views: viewsFor(dialect) });
}

async function applyRaw(text: string): Promise<void> {
  for (const stmt of text.trim().split(";").map((s) => s.trim()).filter(Boolean)) await sql.raw(stmt).execute(k);
}

function isViewChange(c: Change): boolean {
  return c.kind === "create-view" || c.kind === "drop-view" || c.kind === "replace-view";
}

/**
 * `field.inet` has no SQLite storage class, so the canonical `all_types` table reports a
 * blocked `text -> inet` change on every run (see report-views-sqlite.test.ts). No view
 * reads `all_types`. It is named here, not swallowed: any other residue still fails.
 */
const INET_COLUMNS: ReadonlySet<string> = new Set(["inetVal", "inet6Val"]);
const isInetResidue = (c: Change): boolean =>
  c.kind === "change-column-type" && c.table === "all_types" && INET_COLUMNS.has(c.column) && c.to.kind === "inet";

/**
 * The canonical model migrated from empty, except that `weeks` is created without its
 * foreign keys: table drift on a table most report views read, with every view as declared.
 */
async function migrateWithWeeksFkMissing(): Promise<void> {
  const expected = expectedFor("sqlite");
  const initial = await diff({ expected, actual: await introspectSqlite(k), dialect: "sqlite" });
  const { up } = emit(initial.changes, { dialect: "sqlite", expectedSchema: expected });
  const withoutFk = up.replace(/CREATE TABLE "weeks" \([\s\S]*?\n\);/, (table) =>
    table.replace(/,\s*(CONSTRAINT "[^"]+" )?FOREIGN KEY[^\n]*/g, ""));
  expect(withoutFk).not.toBe(up);
  await applyRaw(withoutFk);
}

describe("D3 — a view recreated only around a table rebuild is not drift", () => {
  for (const dialect of ["sqlite", "d1"] as const) {
    test(`${dialect}: drift reports the FK and no view`, async () => {
      await migrateWithWeeksFkMissing();
      const drift = await computeDriftFromActual(await introspectSqlite(k), dialect, canonical, {
        columnNamingStrategy: STRATEGY,
        views: viewsFor(dialect),
      });
      expect(drift.changes.some((c) => c.kind === "add-fk" && c.table === "weeks")).toBe(true);
      expect(drift.changes.filter(isViewChange)).toEqual([]);
      expect(drift.blocked.filter(isViewChange)).toEqual([]);
    });

    test(`${dialect}: the diff still plans each pair, marked unchanged`, async () => {
      await migrateWithWeeksFkMissing();
      const r = await diff({ expected: expectedFor(dialect), actual: await introspectSqlite(k), dialect });
      const views = r.changes.filter(isViewChange);
      expect(views.length).toBeGreaterThan(0);
      for (const c of views) {
        expect(isViewRecreateOnly(c)).toBe(true);
        expect("reason" in c ? c.reason : undefined).toEqual({ kind: "unchanged", tables: ["weeks"] });
      }
      const recreated = views.flatMap((c) => c.kind === "create-view" ? [c.view.name] : []);
      expect(recreated).toContain("v_program_minutes");
      expect(recreated).toContain("v_program_roster");
    });
  }

  test("sqlite: the pair applies, and the database then matches the metadata", async () => {
    await migrateWithWeeksFkMissing();
    const expected = expectedFor("sqlite");
    const actual = await introspectSqlite(k);
    const r = await diff({ expected, actual, dialect: "sqlite" });
    expect(r.blocked.filter((c) => !isInetResidue(c))).toEqual([]);
    const { up } = emit(r.changes.filter((c) => !isInetResidue(c)), {
      dialect: "sqlite",
      expectedSchema: expected,
      ...(actual.meta !== undefined && { actualMeta: actual.meta }),
    });
    expect(up).toContain(`DROP VIEW IF EXISTS "v_program_minutes"`);
    await applyRaw(up);
    const followup = await diff({ expected, actual: await introspectSqlite(k), dialect: "sqlite" });
    expect(followup.changes.filter((c) => !isInetResidue(c))).toEqual([]);
  });
});
