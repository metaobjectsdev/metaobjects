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
    expect(efcoreConventions.foreignKeyIndex(fk, { primaryKey: ["Id"], indexes: [] })).toEqual({ name: "IX_OrderLines_OrderId" });
  });

  test("a name over 63 characters is cut to 62 and marked with ~, as EF Core does", () => {
    const long = { table: "CaseSupportRequestedTypes", columns: ["SupportRequestedTypeId"], refTable: "SupportRequestedTypes", refColumns: ["Id"] };
    const name = efcoreConventions.foreignKeyName(long);

    expect(name).toBe("FK_CaseSupportRequestedTypes_SupportRequestedTypes_SupportRequ~");
    expect(name.length).toBe(63);
    expect(efcoreConventions.primaryKeyName({ table: "A".repeat(61), columns: ["Id"] })).toBe(`PK_${"A".repeat(59)}~`);
  });

  test("no FK index when the primary key or an existing index already starts with the FK's columns", () => {
    expect(efcoreConventions.foreignKeyIndex(fk, { primaryKey: ["OrderId", "LineNo"], indexes: [] })).toBeUndefined();
    expect(efcoreConventions.foreignKeyIndex(fk, { primaryKey: ["Id"], indexes: [{ columns: ["OrderId", "Sku"] }] })).toBeUndefined();
    // an index that merely CONTAINS the columns later does not cover them
    expect(efcoreConventions.foreignKeyIndex(fk, { primaryKey: ["Id"], indexes: [{ columns: ["Sku", "OrderId"] }] }))
      .toEqual({ name: "IX_OrderLines_OrderId" });
    // a partial or expression index does not cover them either
    expect(efcoreConventions.foreignKeyIndex(fk, { primaryKey: ["Id"], indexes: [{ columns: ["OrderId"], where: "x" }] }))
      .toEqual({ name: "IX_OrderLines_OrderId" });
  });

  test("a unique key an FK references is a constraint; any other is an index", () => {
    expect(efcoreConventions.uniqueKeyKind({ table: "Orders", columns: ["Code"], referencedByForeignKey: true })).toBe("constraint");
    expect(efcoreConventions.uniqueKeyKind({ table: "Orders", columns: ["Code"], referencedByForeignKey: false })).toBe("index");
  });
});

describe("default conventions (what migrate has always emitted)", () => {
  test("{table}_pkey, {table}_{firstColumn}_fk, no FK index, unique keys are indexes", () => {
    expect(defaultConventions.primaryKeyName({ table: "orders", columns: ["id"] })).toBe("orders_pkey");
    expect(defaultConventions.foreignKeyName({ ...fk, table: "order_lines", columns: ["order_id", "region"] })).toBe("order_lines_order_id_fk");
    expect(defaultConventions.foreignKeyIndex(fk, { primaryKey: ["Id"], indexes: [] })).toBeUndefined();
    expect(defaultConventions.uniqueKeyKind({ table: "orders", columns: ["code"], referencedByForeignKey: true })).toBe("index");
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
    expect(() => resolveSchemaConventions("hibernate")).toThrow(/unknown schema conventions "hibernate".*default, efcore/);
    expect(SCHEMA_CONVENTION_PRESETS).toEqual(["default", "efcore"]);
  });
});
