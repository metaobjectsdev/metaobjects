import { describe, test, expect } from "bun:test";
import type { SchemaSnapshot, TableDescriptor } from "../../src/types.js";
import { diff } from "../../src/diff/index.js";

const usersTable = (extraCols = true): TableDescriptor => ({
  name: "users",
  columns: [
    { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false },
    ...(extraCols ? [{ name: "email", sqlType: { kind: "text" as const }, nullable: false }] : []),
  ],
  indexes: extraCols ? [{ name: "users_email_idx", columns: ["email"], unique: true }] : [],
  foreignKeys: [], primaryKey: ["id"], checks: [],
});
const snap = (t: TableDescriptor): SchemaSnapshot => ({ tables: [t], views: [] });

describe("diff attaches the prior descriptor as restore on drops", () => {
  test("drop-column carries the prior ColumnDescriptor", async () => {
    // expected lacks email; actual has it → drop-column with restore=email's descriptor
    const r = await diff({ expected: snap(usersTable(false)), actual: snap(usersTable(true)) });
    const dc = r.changes.find((c) => c.kind === "drop-column");
    expect(dc && dc.kind === "drop-column" && dc.restore?.name).toBe("email");
    expect(dc && dc.kind === "drop-column" && dc.restore?.sqlType.kind).toBe("text");
  });
  test("drop-index carries the prior IndexDescriptor", async () => {
    const r = await diff({ expected: snap(usersTable(false)), actual: snap(usersTable(true)) });
    const di = r.changes.find((c) => c.kind === "drop-index");
    expect(di && di.kind === "drop-index" && di.restore?.unique).toBe(true);
  });
  test("drop-table carries the prior TableDescriptor", async () => {
    const r = await diff({ expected: { tables: [], views: [] }, actual: snap(usersTable(true)) });
    const dt = r.changes.find((c) => c.kind === "drop-table");
    expect(dt && dt.kind === "drop-table" && dt.restore?.name).toBe("users");
    expect(dt && dt.kind === "drop-table" && dt.restore?.columns.length).toBe(2);
  });
});
