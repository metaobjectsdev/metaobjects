// Rows a DELETE/UPDATE affected, per driver result shape. Cloudflare D1 (drizzle-orm/d1)
// resolves a run() to `{ success, meta: { changes, … }, results }` — no `rowsAffected`,
// `rowCount` or top-level `changes` — so the count fell through to 0 and every generated
// DELETE answered 404 after deleting the row (found on an adopter's Workers admin panel).
import { describe, test, expect } from "bun:test";
import { extractRowCount } from "../src/drizzle-fastify/util.js";

describe("extractRowCount", () => {
  test("Cloudflare D1: meta.changes", () => {
    expect(extractRowCount({ success: true, meta: { changes: 1, last_row_id: 3, duration: 0.2 }, results: [] })).toBe(1);
    expect(extractRowCount({ success: true, meta: { changes: 0 }, results: [] })).toBe(0);
  });
  test("the existing shapes still read", () => {
    expect(extractRowCount({ rowsAffected: 2 })).toBe(2);
    expect(extractRowCount({ rowsAffected: 2n })).toBe(2);
    expect(extractRowCount({ rowCount: 3 })).toBe(3);
    expect(extractRowCount({ changes: 4 })).toBe(4);
    expect(extractRowCount([{ affectedRows: 5 }, []])).toBe(5);
    expect(extractRowCount(6)).toBe(6);
  });
});
