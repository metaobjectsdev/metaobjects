import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";

// Int-backed field.enum (@intValueMap, design D5): the column is `integer`, not
// `text`. The wire/TS type is unchanged — only the physical column differs.

async function loadJson(json: string): Promise<MetaData> {
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (result.errors.length > 0) {
    throw new Error(`fixture failed to load: ${result.errors.map((e) => String(e)).join("; ")}`);
  }
  return result.root;
}

function entityModel(statusField: Record<string, unknown>, extraRoots: unknown[] = []): string {
  return JSON.stringify({
    "metadata.root": {
      children: [
        ...extraRoots,
        {
          "object.entity": {
            name: "Order",
            children: [
              { "field.long": { name: "id" } },
              { "field.enum": statusField },
              { "source.rdb": { name: "src", "@table": "orders" } },
              { "identity.primary": { name: "pk", "@fields": ["id"] } },
            ],
          },
        },
      ],
    },
  });
}

const VALUES = ["DRAFT", "PUBLISHED", "ARCHIVED"];
const INT_MAP = { DRAFT: 0, PUBLISHED: 5, ARCHIVED: 9 };

async function statusColumn(json: string) {
  const snapshot = buildExpectedSchema(await loadJson(json));
  const table = snapshot.tables.find((t) => t.name === "orders")!;
  return table.columns.find((c) => c.name === "status")!;
}

describe("buildExpectedSchema — int-backed field.enum (@intValueMap)", () => {
  test("scalar int-backed enum maps to integer, not text", async () => {
    const col = await statusColumn(
      entityModel({ name: "status", "@values": VALUES, "@intValueMap": INT_MAP }),
    );
    expect(col.sqlType).toEqual({ kind: "integer", bits: 32 });
  });

  test("string-backed enum (no @intValueMap) is unchanged", async () => {
    const col = await statusColumn(entityModel({ name: "status", "@values": VALUES }));
    expect(col.sqlType).toEqual({ kind: "text" });
  });

  test("array-of-enum int-backed maps to integer[] (D7)", async () => {
    const col = await statusColumn(
      entityModel({ name: "status", isArray: true, "@values": VALUES, "@intValueMap": INT_MAP }),
    );
    expect(col.sqlType).toEqual({ kind: "array", element: { kind: "integer", bits: 32 } });
  });

  test("array-of-enum string-backed stays text[]", async () => {
    const col = await statusColumn(entityModel({ name: "status", isArray: true, "@values": VALUES }));
    expect(col.sqlType).toEqual({ kind: "array", element: { kind: "text" } });
  });

  // Amendment 1 / #246: post-#246 the map CANNOT live on the consuming field when
  // the field extends a shared (root-level abstract) enum — it lives on the SHARED
  // DECLARATION and is inherited. An own-only read here would see undefined and
  // silently emit a text column for an integer-encoded value. This is the shape
  // real adopters will author, so it is the one that most needs pinning.
  test("map inherited from a SHARED abstract declaration still yields integer", async () => {
    const col = await statusColumn(
      entityModel({ name: "status", extends: "Status" }, [
        { "field.enum": { name: "Status", abstract: true, "@values": VALUES, "@intValueMap": INT_MAP } },
      ]),
    );
    expect(col.sqlType).toEqual({ kind: "integer", bits: 32 });
  });

  test("the membership CHECK lists the mapped INTEGERS, unquoted", async () => {
    const snapshot = buildExpectedSchema(
      await loadJson(entityModel({ name: "status", "@values": VALUES, "@intValueMap": INT_MAP })),
    );
    const table = snapshot.tables.find((t) => t.name === "orders")!;
    const chk = table.checks!.find((c) => c.name === "orders_status_chk")!;
    expect(chk.expression).toBe(`"status" IN (0, 5, 9)`);
  });

  test("string-backed enum keeps its quoted-string CHECK", async () => {
    const snapshot = buildExpectedSchema(
      await loadJson(entityModel({ name: "status", "@values": VALUES })),
    );
    const table = snapshot.tables.find((t) => t.name === "orders")!;
    const chk = table.checks!.find((c) => c.name === "orders_status_chk")!;
    expect(chk.expression).toBe(`"status" IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')`);
  });

  test("an int-backed enum inheriting its map from a shared decl gets the integer CHECK", async () => {
    const snapshot = buildExpectedSchema(
      await loadJson(
        entityModel({ name: "status", extends: "Status" }, [
          { "field.enum": { name: "Status", abstract: true, "@values": VALUES, "@intValueMap": INT_MAP } },
        ]),
      ),
    );
    const table = snapshot.tables.find((t) => t.name === "orders")!;
    const chk = table.checks!.find((c) => c.name === "orders_status_chk")!;
    expect(chk.expression).toBe(`"status" IN (0, 5, 9)`);
  });

  test("array-of-enum still gets NO field-level CHECK (membership stays app-level)", async () => {
    const snapshot = buildExpectedSchema(
      await loadJson(
        entityModel({ name: "status", isArray: true, "@values": VALUES, "@intValueMap": INT_MAP }),
      ),
    );
    const table = snapshot.tables.find((t) => t.name === "orders")!;
    expect((table.checks ?? []).find((c) => c.name === "orders_status_chk")).toBeUndefined();
  });

  // Task 7 — @default names a MEMBER, the column holds the mapped INT. Emitting
  // DEFAULT 'DRAFT' on an integer column is un-appliable DDL.
  test("@default lowers to the mapped integer literal", async () => {
    const col = await statusColumn(
      entityModel({ name: "status", "@values": VALUES, "@intValueMap": INT_MAP, "@default": "PUBLISHED" }),
    );
    expect(col.default).toEqual({ kind: "literal", value: "5" });
  });

  test("@default on a string-backed enum is unchanged", async () => {
    const col = await statusColumn(
      entityModel({ name: "status", "@values": VALUES, "@default": "PUBLISHED" }),
    );
    expect(col.default).toEqual({ kind: "literal", value: "PUBLISHED" });
  });

  test("a zero-valued member default survives (0 is falsy — must not be dropped)", async () => {
    const col = await statusColumn(
      entityModel({ name: "status", "@values": VALUES, "@intValueMap": INT_MAP, "@default": "DRAFT" }),
    );
    expect(col.default).toEqual({ kind: "literal", value: "0" });
  });

  test("array-ness and the map may BOTH be inherited from the shared declaration", async () => {
    const col = await statusColumn(
      entityModel({ name: "status", extends: "Status" }, [
        {
          "field.enum": {
            name: "Status",
            abstract: true,
            isArray: true,
            "@values": VALUES,
            "@intValueMap": INT_MAP,
          },
        },
      ]),
    );
    expect(col.sqlType).toEqual({ kind: "array", element: { kind: "integer", bits: 32 } });
  });
});
