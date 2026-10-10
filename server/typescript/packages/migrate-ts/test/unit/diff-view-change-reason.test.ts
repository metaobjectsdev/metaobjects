/**
 * D3 — a view change says WHY it was planned.
 *
 * Pass 2c (the dependency recreate) drops and recreates every view that reads a table the
 * migration alters: Postgres refuses to ALTER a column a view reads, and SQLite/D1 rebuild
 * the table, which strands the view (#243). That pair is needed in the migration SQL, but
 * it carried nothing that set it apart from a view whose definition really differs. So an
 * adopter whose view SQL was byte-identical to the metadata's saw `- view v` / `+ view v`
 * for every report and projection view, and `verify --db` could not say whether any view
 * matched. Every view change now carries a `reason`, and a recreate whose definition
 * matches is `{ kind: "unchanged" }`, which `isViewRecreateOnly` reports as not drift.
 */
import { test, expect, describe } from "bun:test";
import { diff } from "../../src/diff/index.js";
import { isViewRecreateOnly } from "../../src/view-change-reason.js";
import { viewFingerprint } from "../../src/view-fingerprint.js";
import type {
  Change, ColumnDescriptor, Dialect, FkDescriptor, SchemaSnapshot, ViewDescriptor,
} from "../../src/types.js";

const BODY = "SELECT id, label FROM t";

function col(name: string, nullable: boolean): ColumnDescriptor {
  return { name, sqlType: name === "id" ? { kind: "integer", bits: 64 } : { kind: "text" }, nullable };
}

const PARENT_FK: FkDescriptor = {
  name: "t_parentId_fk", columns: ["parentId"], refTable: "p", refColumns: ["id"],
};

/** Table `t` (read by the view) plus table `p` (which `t`'s FK points at). */
function snap(
  opts: { labelNullable?: boolean; fk?: boolean; views: ViewDescriptor[] },
): SchemaSnapshot {
  return {
    tables: [
      {
        name: "p", columns: [col("id", false)], indexes: [], foreignKeys: [], primaryKey: ["id"], checks: [],
      },
      {
        name: "t",
        columns: [col("id", false), col("label", opts.labelNullable ?? true), col("parentId", true)],
        indexes: [],
        foreignKeys: opts.fk === true ? [PARENT_FK] : [],
        primaryKey: ["id"],
        checks: [],
      },
    ],
    views: opts.views,
  };
}

/** The view as the metadata declares it: a body, its fingerprint, and the table it reads. */
function expectedView(sql = BODY): ViewDescriptor {
  return { name: "v", sql, fingerprint: viewFingerprint(sql), dependsOn: ["t"] };
}

/**
 * The view as introspection reads it back. SQLite/D1 store the statement verbatim; Postgres
 * deparses the body (so the text never matches) and the fingerprint comes from the comment.
 */
function actualView(dialect: Dialect, sql = BODY): ViewDescriptor {
  if (dialect === "postgres") {
    return { name: "v", sql: ` SELECT t.id,\n    t.label\n   FROM t;`, fingerprint: viewFingerprint(sql) };
  }
  return { name: "v", sql: `CREATE VIEW "v" AS ${sql}` };
}

function viewChanges(changes: readonly Change[]): Change[] {
  return changes.filter((c) => c.kind === "create-view" || c.kind === "drop-view" || c.kind === "replace-view");
}

describe("D3 — a view recreated only around a table change is marked unchanged", () => {
  for (const dialect of ["sqlite", "d1", "postgres"] as const) {
    test(`${dialect}: NOT NULL change on a table the view reads`, async () => {
      const r = await diff({
        expected: snap({ labelNullable: false, views: [expectedView()] }),
        actual: snap({ labelNullable: true, views: [actualView(dialect)] }),
        dialect,
      });
      expect(r.changes.some((c) => c.kind === "change-column-nullable")).toBe(true);

      // The pair is still planned: the migration SQL needs it.
      const views = viewChanges(r.changes);
      expect(views.map((c) => c.kind).sort()).toEqual(["create-view", "drop-view"]);
      for (const c of views) {
        expect("reason" in c ? c.reason : undefined).toEqual({ kind: "unchanged", tables: ["t"] });
        expect(isViewRecreateOnly(c)).toBe(true);
      }
    });
  }

  // The adopter's case: an FK change rebuilds the table on SQLite/D1 (#243). Postgres adds
  // and drops constraints in place, so it plans no view change at all.
  for (const dialect of ["sqlite", "d1"] as const) {
    test(`${dialect}: FK change on a table the view reads`, async () => {
      const r = await diff({
        expected: snap({ fk: true, views: [expectedView()] }),
        actual: snap({ fk: false, views: [actualView(dialect)] }),
        dialect,
      });
      expect(r.changes.some((c) => c.kind === "add-fk")).toBe(true);
      const views = viewChanges(r.changes);
      expect(views).toHaveLength(2);
      expect(views.every(isViewRecreateOnly)).toBe(true);
    });
  }

  test("postgres: FK change plans no view change", async () => {
    const r = await diff({
      expected: snap({ fk: true, views: [expectedView()] }),
      actual: snap({ fk: false, views: [actualView("postgres")] }),
      dialect: "postgres",
    });
    expect(viewChanges(r.changes)).toEqual([]);
  });

  test("no table change and a matching view → no view change on any dialect", async () => {
    for (const dialect of ["sqlite", "d1", "postgres"] as const) {
      const r = await diff({
        expected: snap({ views: [expectedView()] }),
        actual: snap({ views: [actualView(dialect)] }),
        dialect,
      });
      expect(r.changes).toEqual([]);
    }
  });
});

describe("D3 — a view whose definition differs says so", () => {
  const CHANGED = "SELECT id, label AS title FROM t";

  for (const dialect of ["sqlite", "d1"] as const) {
    test(`${dialect}: replace-view names a text difference and where it starts`, async () => {
      const r = await diff({
        expected: snap({ views: [expectedView(CHANGED)] }),
        actual: snap({ views: [actualView(dialect)] }),
        dialect,
      });
      const [c] = viewChanges(r.changes);
      expect(c?.kind).toBe("replace-view");
      expect(c !== undefined && isViewRecreateOnly(c)).toBe(false);
      expect(c !== undefined && "reason" in c ? c.reason : undefined).toEqual({
        kind: "definition",
        compared: "text",
        firstDifference: { expected: "select id, label as title from t", actual: "select id, label from t" },
      });
    });

    test(`${dialect}: a changed view over a rebuilt table keeps its difference`, async () => {
      const r = await diff({
        expected: snap({ labelNullable: false, views: [expectedView(CHANGED)] }),
        actual: snap({ labelNullable: true, views: [actualView(dialect)] }),
        dialect,
      });
      const views = viewChanges(r.changes);
      expect(views.map((c) => c.kind).sort()).toEqual(["create-view", "drop-view"]);
      for (const c of views) {
        expect(isViewRecreateOnly(c)).toBe(false);
        expect("reason" in c ? c.reason : undefined).toMatchObject({
          kind: "definition", compared: "text", tables: ["t"],
        });
      }
    });
  }

  test("postgres: a changed fingerprint is a definition difference", async () => {
    const r = await diff({
      expected: snap({ views: [expectedView(CHANGED)] }),
      actual: snap({ views: [actualView("postgres")] }),
      dialect: "postgres",
    });
    const views = viewChanges(r.changes);
    expect(views.length).toBeGreaterThan(0);
    for (const c of views) {
      expect(isViewRecreateOnly(c)).toBe(false);
      expect("reason" in c ? c.reason : undefined).toEqual({ kind: "definition", compared: "fingerprint" });
    }
  });

  test("postgres: an unstamped database view cannot be compared", async () => {
    const unstamped: ViewDescriptor = { name: "v", sql: " SELECT t.id, t.label FROM t;" };
    const r = await diff({
      expected: snap({ views: [expectedView()] }),
      actual: snap({ views: [unstamped] }),
      dialect: "postgres",
    });
    const views = viewChanges(r.changes);
    expect(views.length).toBeGreaterThan(0);
    for (const c of views) expect("reason" in c ? c.reason : undefined).toEqual({ kind: "unfingerprinted" });
  });
});

describe("D3 — a view only one side has", () => {
  for (const dialect of ["sqlite", "d1", "postgres"] as const) {
    test(`${dialect}: missing from the database → create-view, reason missing`, async () => {
      const r = await diff({ expected: snap({ views: [expectedView()] }), actual: snap({ views: [] }), dialect });
      expect(viewChanges(r.changes)).toMatchObject([{ kind: "create-view", reason: { kind: "missing" } }]);
    });

    test(`${dialect}: declared by nothing → drop-view, reason undeclared`, async () => {
      const r = await diff({
        expected: snap({ views: [] }),
        actual: snap({ views: [actualView(dialect)] }),
        dialect,
        allow: { dropView: true },
      });
      expect(viewChanges(r.changes)).toMatchObject([{ kind: "drop-view", reason: { kind: "undeclared" } }]);
    });
  }
});

describe("D3 — an adoption Pass 2c supersedes keeps its gate", () => {
  test("postgres: an unstamped view over an altered table still needs allow.adoptView", async () => {
    const unstamped: ViewDescriptor = { name: "v", sql: " SELECT t.id, t.label FROM t;" };
    const args = {
      expected: snap({ labelNullable: false, views: [expectedView()] }),
      actual: snap({ labelNullable: true, views: [unstamped] }),
      dialect: "postgres" as const,
    };
    const r = await diff(args);
    const drop = r.changes.find((c) => c.kind === "drop-view");
    expect(drop).toMatchObject({
      unmanagedActual: true,
      reason: { kind: "unfingerprinted", tables: ["t"] },
      status: { state: "blocked" },
    });

    const allowed = await diff({ ...args, allow: { adoptView: true, nullableToNotNull: true } });
    expect(allowed.blocked).toEqual([]);
  });
});
