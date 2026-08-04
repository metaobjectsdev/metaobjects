// #192 — Flyway output adapter. Verifies the V<N>__/U<N>__ envelope, the two
// scanner traps (our own U__ files must not bump the counter; a dotted version
// increments on its leading integer), and the underscore slug sanitization that
// deliberately differs from the D1 adapter's hyphens.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMigrationFlyway } from "../src/write-migration-flyway.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "flyway-adapter-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const SQL = { up: "CREATE TABLE t (id int);", down: "DROP TABLE t;" };

describe("writeMigrationFlyway — versioning", () => {
  test("an empty dir starts at V1 and writes both files", async () => {
    const res = await writeMigrationFlyway(SQL, { dir, slug: "init" });
    expect(res.version).toBe(1);
    expect(res.upPath).toBe(join(dir, "V1__init.sql"));
    expect(res.downPath).toBe(join(dir, "U1__init.sql"));
    expect(readFileSync(res.upPath, "utf8")).toBe("CREATE TABLE t (id int);\n");
    expect(readFileSync(res.downPath, "utf8")).toBe("DROP TABLE t;\n");
  });

  test("a missing dir is created", async () => {
    const nested = join(dir, "db", "migration");
    const res = await writeMigrationFlyway(SQL, { dir: nested, slug: "init" });
    expect(res.version).toBe(1);
    expect(readdirSync(nested).sort()).toEqual(["U1__init.sql", "V1__init.sql"]);
  });

  test("increments past the highest existing V", async () => {
    writeFileSync(join(dir, "V1__a.sql"), "");
    writeFileSync(join(dir, "V2__b.sql"), "");
    const res = await writeMigrationFlyway(SQL, { dir, slug: "third" });
    expect(res.version).toBe(3);
    expect(res.upPath).toBe(join(dir, "V3__third.sql"));
  });

  // The trap: a naive /^[VU](\d+)/ would let our OWN undo files bump the counter,
  // so every run would skip a version.
  test("U__ files do NOT bump the counter", async () => {
    writeFileSync(join(dir, "V1__a.sql"), "");
    writeFileSync(join(dir, "U1__a.sql"), "");
    const res = await writeMigrationFlyway(SQL, { dir, slug: "second" });
    expect(res.version).toBe(2);
  });

  // Flyway permits dotted versions; the LEADING integer is what we increment.
  test("a dotted version increments on its leading integer", async () => {
    writeFileSync(join(dir, "V10.5__a.sql"), "");
    const res = await writeMigrationFlyway(SQL, { dir, slug: "next" });
    expect(res.version).toBe(11);
  });

  test("non-migration files and repeatables are ignored", async () => {
    writeFileSync(join(dir, "README.md"), "");
    writeFileSync(join(dir, "R__view.sql"), "");
    writeFileSync(join(dir, "notes.txt"), "");
    const res = await writeMigrationFlyway(SQL, { dir, slug: "init" });
    expect(res.version).toBe(1);
  });
});

describe("writeMigrationFlyway — slug", () => {
  // Flyway renders underscores as spaces, so underscores are idiomatic here.
  // This deliberately DIFFERS from the D1 adapter, which uses hyphens.
  test("sanitizes to lowercase underscores, not hyphens", async () => {
    const res = await writeMigrationFlyway(SQL, { dir, slug: "Add Program View!" });
    expect(res.upPath).toBe(join(dir, "V1__add_program_view.sql"));
    expect(res.downPath).toBe(join(dir, "U1__add_program_view.sql"));
  });

  test("empty/punctuation-only slug falls back to 'migration'", async () => {
    const res = await writeMigrationFlyway(SQL, { dir, slug: "!!!" });
    expect(res.upPath).toBe(join(dir, "V1__migration.sql"));
  });

  test("already-newline-terminated SQL is not double-terminated", async () => {
    const res = await writeMigrationFlyway({ up: "A;\n", down: "B;\n" }, { dir, slug: "x" });
    expect(readFileSync(res.upPath, "utf8")).toBe("A;\n");
  });
});
