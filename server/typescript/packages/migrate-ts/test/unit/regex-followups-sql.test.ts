import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { splitSqlStatements } from "../../src/sql/split-statements.js";
import { prepareForRunnerTransaction } from "../../src/apply/runner-transaction-pass.js";
import { viewSqlEquals } from "../../src/view-sql-compare.js";
import { viewFingerprint } from "../../src/view-fingerprint.js";
import { hasAutoincrementKeyword } from "../../src/introspect/sqlite-shared.js";

const TRIGGER =
  "CREATE TRIGGER t_touch AFTER UPDATE ON t BEGIN UPDATE t SET updated_at = datetime('now') WHERE id = NEW.id; END";

describe("splitSqlStatements: engine rules", () => {
  test("a SQLite trigger is one statement the engine accepts", () => {
    const parts = splitSqlStatements(`CREATE TABLE t (id INTEGER, updated_at TEXT);\n${TRIGGER};\nSELECT 1;`);
    expect(parts).toEqual(["CREATE TABLE t (id INTEGER, updated_at TEXT)", TRIGGER, "SELECT 1"]);
    const db = new Database(":memory:");
    for (const p of parts) db.exec(p);
  });

  test("CASE ... END and several body statements stay inside the trigger", () => {
    const trig =
      "CREATE TEMP TRIGGER x AFTER INSERT ON t BEGIN SELECT CASE WHEN 1 THEN 2 END; UPDATE t SET a = 1; END";
    expect(splitSqlStatements(`${trig}; SELECT 2;`)).toEqual([trig, "SELECT 2"]);
  });

  test("an identifier containing begin does not open a body", () => {
    expect(splitSqlStatements("CREATE TABLE begin_x (a); SELECT 1;")).toEqual(["CREATE TABLE begin_x (a)", "SELECT 1"]);
  });

  test("Postgres E'' literal honours backslash escapes", () => {
    const sql = "INSERT INTO t VALUES (E'it\\'s; fine');\nSELECT 1;";
    expect(splitSqlStatements(sql)).toEqual(["INSERT INTO t VALUES (E'it\\'s; fine')", "SELECT 1"]);
  });

  test("a plain literal ending in e is not an E string", () => {
    expect(splitSqlStatements("SELECT 'e'; SELECT 'a\\'; SELECT 2;")).toEqual(["SELECT 'e'", "SELECT 'a\\'", "SELECT 2"]);
  });

  test("a bare END is transaction control", () => {
    const r = prepareForRunnerTransaction(`END;\n${TRIGGER};`);
    expect(r.statements).toEqual([TRIGGER]);
  });
});

describe("view comparators are literal-exact", () => {
  test("SQLite comparator: literal case and literal whitespace differ", () => {
    expect(viewSqlEquals("SELECT 1 WHERE s = 'Active'", "SELECT 1 WHERE s = 'active'")).toBe(false);
    expect(viewSqlEquals("SELECT 1 WHERE s = 'a  b'", "SELECT 1 WHERE s = 'a b'")).toBe(false);
    expect(viewSqlEquals("CREATE VIEW v AS SELECT  1\n WHERE s = 'a  b';", "SELECT 1 WHERE s = 'a  b'")).toBe(true);
  });
  test("fingerprint: literal whitespace differs, outside whitespace does not", () => {
    expect(viewFingerprint("SELECT 'a  b'")).not.toBe(viewFingerprint("SELECT 'a b'"));
    expect(viewFingerprint("SELECT   1")).toBe(viewFingerprint("SELECT 1"));
  });
});

describe("AUTOINCREMENT detection", () => {
  test("keyword only", () => {
    expect(hasAutoincrementKeyword("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT)")).toBe(true);
    expect(hasAutoincrementKeyword("CREATE TABLE t (id INTEGER PRIMARY KEY) -- AUTOINCREMENT")).toBe(false);
    expect(hasAutoincrementKeyword("CREATE TABLE t (id INTEGER PRIMARY KEY, n TEXT DEFAULT 'AUTOINCREMENT')")).toBe(false);
    expect(hasAutoincrementKeyword('CREATE TABLE t (id INTEGER PRIMARY KEY, "AUTOINCREMENT" TEXT)')).toBe(false);
  });
});
