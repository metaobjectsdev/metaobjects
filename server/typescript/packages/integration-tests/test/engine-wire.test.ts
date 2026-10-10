// engine-wire.test.ts — the pure helpers behind the SQLite and MySQL persistence lanes.
// No DB: a spelling map that silently changed a value would let those lanes pass for the wrong
// reason, so each rule is pinned here, including the ones that must NOT fire.

import { describe, expect, test } from "bun:test";

import { toWireRow } from "../src/engine-wire.ts";
import { toMysqlSeed } from "../src/query-scenario-mysql.ts";
import { splitStatements } from "../src/sql-script.ts";

describe("toWireRow", () => {
  test("SQLite: a count and a currency are strings, a ratio is a canonical decimal string, min/max stay numbers", () => {
    expect(toWireRow("sqlite", "ProgramMinutes", {
      program: 1, weeks: 4, avgMinutes: 60, longShare: 0.75, minMinutes: 30, programTitle: "7",
    })).toEqual({
      program: "1", weeks: "4", avgMinutes: "60", longShare: "0.75", minMinutes: 30, programTitle: "7",
    });
  });

  test("MySQL: a DECIMAL keeps its value and loses its scale; a BIGINT string is untouched", () => {
    expect(toWireRow("mysql", "ProgramMinutes", { weeks: "4", avgMinutes: "60.0000", longShare: "0.6667" }))
      .toEqual({ weeks: "4", avgMinutes: "60", longShare: "0.6667" });
    expect(toWireRow("mysql", "ProgramMinutes", { longShare: "0.0000" })).toEqual({ longShare: "0" });
  });

  test("an instant becomes a UTC ...Z string: SQLite's stored text and MySQL's naive wall clock", () => {
    expect(toWireRow("sqlite", "AssetActivity", { recordedAtHour: "2026-05-04T03:00:00.000Z" }))
      .toEqual({ recordedAtHour: "2026-05-04T03:00:00Z" });
    expect(toWireRow("mysql", "AssetActivity", { recordedAtHour: "2026-05-04 03:00:00.000" }))
      .toEqual({ recordedAtHour: "2026-05-04T03:00:00Z" });
  });

  test("null, a date bucket and an unknown entity pass through", () => {
    expect(toWireRow("sqlite", "ProgramMinutes", { totalMinutes: null })).toEqual({ totalMinutes: null });
    expect(toWireRow("sqlite", "AssetActivity", { asOfDateWeek: "2026-04-27" })).toEqual({ asOfDateWeek: "2026-04-27" });
    expect(toWireRow("mysql", "Program", { id: 1 })).toEqual({ id: 1 });
  });

  test("a wrong value is still wrong: only the spelling is mapped", () => {
    expect(toWireRow("sqlite", "ProgramMinutes", { weeks: 5 })).not.toEqual({ weeks: "4" });
  });
});

describe("toMysqlSeed", () => {
  test("a double-quoted identifier becomes a backtick one", () => {
    expect(toMysqlSeed(`INSERT INTO "programs" ("id","title") VALUES (1, 'a');`))
      .toBe("INSERT INTO `programs` (`id`,`title`) VALUES (1, 'a');");
  });

  test("a double quote inside a string literal is data, and '' does not end the string", () => {
    expect(toMysqlSeed(`INSERT INTO "assets" ("payload") VALUES ('{"k": 1}'), ('it''s "x"');`))
      .toBe("INSERT INTO `assets` (`payload`) VALUES ('{\"k\": 1}'), ('it''s \"x\"');");
  });

  test("an ISO instant loses its Z (DATETIME is the UTC wall clock); other strings keep theirs", () => {
    expect(toMysqlSeed(`VALUES ('2026-05-04T03:30:00Z', '2026-05-04T03:30:00.5Z', 'Z')`))
      .toBe(`VALUES ('2026-05-04T03:30:00', '2026-05-04T03:30:00.5', 'Z')`);
  });
});

describe("splitStatements", () => {
  test("drops -- comment lines and splits on a trailing semicolon only", () => {
    expect(splitStatements("-- header\nCREATE TABLE a (x INT);\n\nINSERT INTO a VALUES (1), (2);\n"))
      .toEqual(["CREATE TABLE a (x INT)", "INSERT INTO a VALUES (1), (2)"]);
  });
});
