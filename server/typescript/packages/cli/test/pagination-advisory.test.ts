// A generated list route with no page size returns the whole table. `meta verify` names that
// when a route generator is wired and the project declares no `api.pagination`, and stays
// silent otherwise. Advisory only.

import { describe, test, expect } from "bun:test";
import { scanForUnsetPagination } from "../src/lib/pagination-advisory.js";
import { unboundedListRows, advisoryHelpLines, RULE_UNBOUNDED_LIST } from "../src/lib/advisory.js";

const PAGE = { defaultLimit: 50, maxLimit: 1000 };

describe("scanForUnsetPagination", () => {
  test("routes wired, no page size: one finding naming the block to add", () => {
    const [f, ...rest] = scanForUnsetPagination(["entity-file", "routes-file"], undefined);
    expect(rest).toEqual([]);
    expect(f!.generator).toBe("routes-file");
    expect(f!.file).toBe(".metaobjects/config.json");
    expect(f!.message).toContain('"api": { "pagination": { "defaultLimit": 50, "maxLimit": 1000 } }');
    expect(f!.message).toContain("limit_too_large");
  });

  test("the Hono routes and the stable string ids count too", () => {
    for (const name of ["routes-file-hono", "routes", "routes-hono"]) {
      expect(scanForUnsetPagination([name], undefined).length).toBe(1);
    }
  });

  test("silent when the project sets a page size", () => {
    expect(scanForUnsetPagination(["routes-file"], PAGE)).toEqual([]);
  });

  test("silent when no route generator is wired", () => {
    expect(scanForUnsetPagination(["entity-file", "queries-file"], undefined)).toEqual([]);
    expect(scanForUnsetPagination([], undefined)).toEqual([]);
  });

  test("rides the advisory row shape under its own rule and help line", () => {
    const rows = unboundedListRows(scanForUnsetPagination(["routes-file"], undefined));
    expect(rows.map((r) => r.rule)).toEqual([RULE_UNBOUNDED_LIST]);
    expect(rows[0]!.construct).toBe("routes-file");
    expect(advisoryHelpLines(rows).join("\n")).toContain(RULE_UNBOUNDED_LIST);
  });
});
