/**
 * Schema conventions: the names and physical choices for database objects that no code
 * addresses — primary-key and foreign-key constraint names, whether a foreign key gets an
 * index (and its name), and whether a unique key is an index or a constraint.
 *
 * `default` is what migrate has always emitted, so a project that sets nothing sees no
 * change. `efcore` reproduces EF Core's own conventions, so a database first built by EF
 * migrations and one built by `meta migrate` have the same catalog.
 */
import { describe, test, expect } from "bun:test";
import {
  defaultConventions, efcoreConventions, resolveSchemaConventions, SCHEMA_CONVENTION_PRESETS,
} from "../../src/schema-conventions.js";

const fk = { table: "OrderLines", columns: ["OrderId"], refTable: "Orders", refColumns: ["Id"] };

describe("efcore conventions", () => {
  test("PK_{table}, FK_{table}_{principal}_{columns}, IX_{table}_{columns}", () => {
    expect(efcoreConventions.primaryKeyName({ table: "Orders", columns: ["Id"] })).toBe("PK_Orders");
    expect(efcoreConventions.foreignKeyName(fk)).toBe("FK_OrderLines_Orders_OrderId");
    expect(efcoreConventions.foreignKeyName({ ...fk, columns: ["OrderId", "Region"], refColumns: ["Id", "Region"] }))
      .toBe("FK_OrderLines_Orders_OrderId_Region");
    expect(efcoreConventions.foreignKeyIndexes({ table: "OrderLines", primaryKey: ["Id"], indexes: [], foreignKeys: [fk] }))
      .toEqual([{ name: "IX_OrderLines_OrderId", columns: ["OrderId"] }]);
  });

  test("on Postgres a name over 63 characters is cut to 62 and marked with ~, as EF Core does", () => {
    const long = { table: "WarehouseShippingPreferences", columns: ["ShippingPreferenceId"], refTable: "ShippingPreferences", refColumns: ["Id"] };
    const name = efcoreConventions.foreignKeyName(long);

    expect(name).toBe("FK_WarehouseShippingPreferences_ShippingPreferences_ShippingPr~");
    expect(name.length).toBe(63);
    expect(efcoreConventions.foreignKeyName({ ...long, dialect: "postgres" })).toBe(name);
    expect(efcoreConventions.primaryKeyName({ table: "A".repeat(61), columns: ["Id"] })).toBe(`PK_${"A".repeat(59)}~`);
  });

  test("on SQLite and D1 nothing is truncated: EF Core's SQLite provider has no identifier limit", () => {
    const long = { table: "WarehouseShippingPreferences", columns: ["ShippingPreferenceId"], refTable: "ShippingPreferences", refColumns: ["Id"] };
    for (const dialect of ["sqlite", "d1"] as const) {
      expect(efcoreConventions.foreignKeyName({ ...long, dialect }))
        .toBe("FK_WarehouseShippingPreferences_ShippingPreferences_ShippingPreferenceId");
      expect(efcoreConventions.primaryKeyName({ table: "A".repeat(61), columns: ["Id"], dialect })).toBe(`PK_${"A".repeat(61)}`);
      expect(efcoreConventions.foreignKeyIndexes({ table: "A".repeat(61), dialect, primaryKey: ["Id"], indexes: [],
        foreignKeys: [{ table: "A".repeat(61), columns: ["BId"], refTable: "B", refColumns: ["Id"], dialect }] })[0]!.name)
        .toBe(`IX_${"A".repeat(61)}_BId`);
    }
  });

  test("no FK index when the primary key or an existing index already starts with the FK's columns", () => {
    const ix = (primaryKey: string[], indexes: { columns: string[]; where?: string; expr?: string }[]) =>
      efcoreConventions.foreignKeyIndexes({ table: "OrderLines", primaryKey, indexes, foreignKeys: [fk] }).map((i) => i.name);

    expect(ix(["OrderId", "LineNo"], [])).toEqual([]);
    expect(ix(["Id"], [{ columns: ["OrderId", "Sku"] }])).toEqual([]);
    // an index that merely CONTAINS the columns later does not cover them
    expect(ix(["Id"], [{ columns: ["Sku", "OrderId"] }])).toEqual(["IX_OrderLines_OrderId"]);
    // a PARTIAL index covers them: EF Core's AreIndexedBy compares properties, and a filter is
    // a relational annotation that convention never sees
    expect(ix(["Id"], [{ columns: ["OrderId"], where: "x" }])).toEqual([]);
    // an expression index has no columns to lead with
    expect(ix(["Id"], [{ columns: [], expr: "lower(x)" }])).toEqual(["IX_OrderLines_OrderId"]);
  });

  test("FK indexes do not depend on FK order: one an FK index covers is dropped, as EF Core does", () => {
    const a = { table: "hs", columns: ["a"], refTable: "x", refColumns: ["id"] };
    const ab = { table: "hs", columns: ["a", "b"], refTable: "y", refColumns: ["id", "k"] };
    const names = (foreignKeys: typeof a[]) =>
      efcoreConventions.foreignKeyIndexes({ table: "hs", primaryKey: ["id"], indexes: [], foreignKeys }).map((i) => i.name);

    expect(names([a, ab])).toEqual(["IX_hs_a_b"]);
    expect(names([ab, a])).toEqual(["IX_hs_a_b"]);
    // two FKs on the same columns get one index
    expect(names([a, { ...a, refTable: "z" }])).toEqual(["IX_hs_a"]);
  });

  test("a unique key an FK references is a constraint; any other is an index", () => {
    expect(efcoreConventions.uniqueKeyKind({ table: "Orders", columns: ["Code"], referencedByForeignKey: true })).toBe("constraint");
    expect(efcoreConventions.uniqueKeyKind({ table: "Orders", columns: ["Code"], referencedByForeignKey: false })).toBe("index");
  });
});

describe("default conventions (what migrate has always emitted)", () => {
  test("{table}_pkey, {table}_{firstColumn}_fk, no FK index, a unique key of either kind", () => {
    expect(defaultConventions.primaryKeyName({ table: "orders", columns: ["id"] })).toBe("orders_pkey");
    expect(defaultConventions.foreignKeyName({ ...fk, table: "order_lines", columns: ["order_id", "region"] })).toBe("order_lines_order_id_fk");
    expect(defaultConventions.foreignKeyIndexes({ table: "OrderLines", primaryKey: ["Id"], indexes: [], foreignKeys: [fk] })).toEqual([]);
    expect(defaultConventions.uniqueKeyKind({ table: "orders", columns: ["code"], referencedByForeignKey: true })).toBe("either");
  });
});

describe("resolveSchemaConventions", () => {
  test("a preset by name, a supplied object as itself, nothing as default", () => {
    expect(resolveSchemaConventions("efcore")).toBe(efcoreConventions);
    expect(resolveSchemaConventions(undefined)).toBe(defaultConventions);
    const custom = { ...defaultConventions, id: "acme" };
    expect(resolveSchemaConventions(custom)).toBe(custom);
  });

  test("an unknown preset is refused, naming the ones that exist", () => {
    expect(() => resolveSchemaConventions("hibernate")).toThrow(/migrate\.conventions "hibernate".*default, efcore/);
    expect(SCHEMA_CONVENTION_PRESETS).toEqual(["default", "efcore"]);
  });

  test("a supplied object missing a member is refused by name (e.g. written for another version)", () => {
    const partial = { id: "acme", primaryKeyName: () => "pk" } as unknown as Parameters<typeof resolveSchemaConventions>[0];
    expect(() => resolveSchemaConventions(partial))
      .toThrow(/schema conventions "acme" are missing foreignKeyName, foreignKeyIndexes, uniqueKeyKind/);
  });
});
