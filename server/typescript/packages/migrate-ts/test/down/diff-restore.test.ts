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

describe("diff attaches restore on shape-change drops (drop+add)", () => {
  test("index unique flips true→false → drop-index restore is the ORIGINAL (unique=true) + add-index", async () => {
    // actual: unique=true; expected: unique=false (same name, different shape)
    const expected = usersTable(true);
    expected.indexes = [{ name: "users_email_idx", columns: ["email"], unique: false }];
    const actual = usersTable(true); // unique=true
    const r = await diff({ expected: snap(expected), actual: snap(actual) });
    const di = r.changes.find((c) => c.kind === "drop-index");
    const ai = r.changes.find((c) => c.kind === "add-index");
    expect(di && di.kind === "drop-index" && di.restore?.unique).toBe(true);
    expect(ai && ai.kind === "add-index").toBe(true);
  });
  test("fk onDelete changes → drop-fk restore is the ORIGINAL fk + add-fk", async () => {
    const baseFk = { name: "users_org_fk", columns: ["org_id"], refTable: "orgs", refColumns: ["id"] };
    const expected = usersTable(true);
    expected.foreignKeys = [{ ...baseFk, onDelete: "cascade" }];
    const actual = usersTable(true);
    actual.foreignKeys = [{ ...baseFk, onDelete: "set-null" }];
    const r = await diff({ expected: snap(expected), actual: snap(actual) });
    const df = r.changes.find((c) => c.kind === "drop-fk");
    const af = r.changes.find((c) => c.kind === "add-fk");
    expect(df && df.kind === "drop-fk" && df.restore?.onDelete).toBe("set-null");
    expect(af && af.kind === "add-fk").toBe(true);
  });
});
