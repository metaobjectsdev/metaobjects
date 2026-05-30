import { test, expect, describe } from "bun:test";
import { splitSqlStatements } from "../../src/apply/apply.js";

describe("splitSqlStatements — quote/comment/dollar-quote-aware", () => {
  test("semicolon inside a single-quoted literal is NOT a separator", () => {
    const stmts = splitSqlStatements("INSERT INTO t (id, note) VALUES (1, 'a;b');");
    expect(stmts).toEqual(["INSERT INTO t (id, note) VALUES (1, 'a;b')"]);
  });

  test("escaped single-quote ('') inside a literal is handled", () => {
    const stmts = splitSqlStatements("INSERT INTO t (note) VALUES ('it''s; fine');");
    expect(stmts).toEqual(["INSERT INTO t (note) VALUES ('it''s; fine')"]);
  });

  test("double-quoted identifier containing ; is NOT a separator", () => {
    const stmts = splitSqlStatements('SELECT "weird;col" FROM t;');
    expect(stmts).toEqual(['SELECT "weird;col" FROM t']);
  });

  test("escaped double-quote inside an identifier is handled", () => {
    const stmts = splitSqlStatements('SELECT "we""ird;col" FROM t;');
    expect(stmts).toEqual(['SELECT "we""ird;col" FROM t']);
  });

  test("dollar-quoted PG function body ignores internal semicolons", () => {
    const sql =
      "CREATE FUNCTION f() RETURNS void AS $$ BEGIN x; y; END; $$ LANGUAGE plpgsql;";
    const stmts = splitSqlStatements(sql);
    expect(stmts).toEqual([
      "CREATE FUNCTION f() RETURNS void AS $$ BEGIN x; y; END; $$ LANGUAGE plpgsql",
    ]);
  });

  test("tagged dollar-quote ($tag$ ... $tag$) ignores internal semicolons", () => {
    const sql =
      "CREATE FUNCTION f() RETURNS void AS $body$ BEGIN a; b; END; $body$ LANGUAGE plpgsql;";
    const stmts = splitSqlStatements(sql);
    expect(stmts).toEqual([
      "CREATE FUNCTION f() RETURNS void AS $body$ BEGIN a; b; END; $body$ LANGUAGE plpgsql",
    ]);
  });

  test("a non-matching inner dollar-tag does not close the outer dollar-quote", () => {
    const sql = "SELECT $$ a; $tag$ b; $$ ;";
    const stmts = splitSqlStatements(sql);
    expect(stmts).toEqual(["SELECT $$ a; $tag$ b; $$"]);
  });

  test("semicolon in a -- line comment is ignored", () => {
    const stmts = splitSqlStatements("-- a; b\nSELECT 1;");
    expect(stmts).toEqual(["-- a; b\nSELECT 1"]);
  });

  test("semicolon in a block comment is ignored", () => {
    const stmts = splitSqlStatements("/* a; b */ SELECT 1;");
    expect(stmts).toEqual(["/* a; b */ SELECT 1"]);
  });

  test("two real statements split into two", () => {
    const stmts = splitSqlStatements(
      "CREATE TABLE a (id INTEGER); CREATE TABLE b (id INTEGER);",
    );
    expect(stmts).toEqual([
      "CREATE TABLE a (id INTEGER)",
      "CREATE TABLE b (id INTEGER)",
    ]);
  });

  test("trailing / blank / whitespace-only fragments are dropped", () => {
    const stmts = splitSqlStatements(
      "CREATE TABLE a (id INTEGER);;\n  \n; CREATE TABLE b (id INTEGER);  ",
    );
    expect(stmts).toEqual([
      "CREATE TABLE a (id INTEGER)",
      "CREATE TABLE b (id INTEGER)",
    ]);
  });

  test("a final statement with no trailing semicolon is still returned", () => {
    const stmts = splitSqlStatements("SELECT 1");
    expect(stmts).toEqual(["SELECT 1"]);
  });

  test("empty input yields no statements", () => {
    expect(splitSqlStatements("")).toEqual([]);
    expect(splitSqlStatements("   \n  ")).toEqual([]);
  });
});
