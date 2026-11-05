import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaField } from "@metaobjectsdev/metadata";
import { mapColumnType } from "../src/column-mapper.js";

// Int-backed field.enum (@intValueMap, design D5/D7): the Drizzle column becomes
// integer / integer[] and its CHECK lists unquoted integers, matching migrate-ts's
// expected-schema exactly. A mismatch between the two is precisely the drift
// `meta verify --codegen` exists to catch, so these assertions are deliberately
// the mirror of expected-schema-enum-intvaluemap.test.ts in migrate-ts.

const VALUES = ["DRAFT", "PUBLISHED", "ARCHIVED"];
const INT_MAP = { DRAFT: 0, PUBLISHED: 5, ARCHIVED: 9 };

async function statusField(
  statusDecl: Record<string, unknown>,
  extraRoots: unknown[] = [],
): Promise<MetaField> {
  const json = JSON.stringify({
    "metadata.root": {
      children: [
        ...extraRoots,
        {
          "object.entity": {
            name: "Order",
            children: [
              { "field.long": { name: "id" } },
              { "field.enum": statusDecl },
              { "source.rdb": { name: "src", "@table": "orders" } },
              { "identity.primary": { name: "pk", "@fields": ["id"] } },
            ],
          },
        },
      ],
    },
  });
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (errors.length > 0) throw new Error(`fixture failed to load: ${errors.map(String).join("; ")}`);
  const order = root.objects().find((o) => o.name === "Order")!;
  return order.fields().find((f) => f.name === "status")!;
}

describe("mapColumnType — int-backed field.enum (@intValueMap)", () => {
  test("scalar int-backed enum → a generated customType column, no literal-union option", async () => {
    const spec = mapColumnType(await statusField({ name: "status", "@values": VALUES, "@intValueMap": INT_MAP }), "postgres");
    // fnName names a LOCAL generated const, not a Drizzle export — the renderer
    // must emit it rather than imp() it.
    expect(spec.fnName).toBe("statusIntEnum");
    expect(spec.enumIntCustomType).toEqual({
      fnConstName: "statusIntEnum",
      toIntConstName: "STATUS_TO_INT",
      fromIntConstName: "STATUS_FROM_INT",
      dataType: "integer",
      members: VALUES,
      intByMember: INT_MAP,
    });
    // The `{ enum: [...] }` literal-union option is a TEXT-column affordance; on an
    // integer column it would type the column as a string union over a numeric value.
    expect(spec.fnOptions?.enum).toBeUndefined();
  });

  test("string-backed enum carries NO customType (byte-identical to today)", async () => {
    const spec = mapColumnType(await statusField({ name: "status", "@values": VALUES }), "postgres");
    expect(spec.enumIntCustomType).toBeUndefined();
  });

  test("string-backed enum is unchanged — text + literal union", async () => {
    const spec = mapColumnType(await statusField({ name: "status", "@values": VALUES }), "postgres");
    expect(spec.fnName).toBe("text");
    expect(spec.fnOptions?.enum).toEqual(VALUES);
  });

  test("CHECK lists unquoted integers, matching migrate-ts", async () => {
    const spec = mapColumnType(await statusField({ name: "status", "@values": VALUES, "@intValueMap": INT_MAP }), "postgres");
    expect(spec.checkConstraint).toBe("status IN (0, 5, 9)");
  });

  test("string-backed CHECK keeps quoted members", async () => {
    const spec = mapColumnType(await statusField({ name: "status", "@values": VALUES }), "postgres");
    expect(spec.checkConstraint).toBe("status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')");
  });

  test("sqlite int-backed enum gets the same customType (integer storage class)", async () => {
    const spec = mapColumnType(await statusField({ name: "status", "@values": VALUES, "@intValueMap": INT_MAP }), "sqlite");
    expect(spec.fnName).toBe("statusIntEnum");
    expect(spec.enumIntCustomType?.dataType).toBe("integer");
  });

  // Amendment 1 / #246 — the canonical authoring shape. An own-only read of
  // @intValueMap would emit `text` here and silently disagree with migrate-ts,
  // which reads it resolving.
  test("map INHERITED from a shared abstract declaration still yields integer", async () => {
    const spec = mapColumnType(
      await statusField({ name: "status", extends: "Status" }, [
        { "field.enum": { name: "Status", abstract: true, "@values": VALUES, "@intValueMap": INT_MAP } },
      ]),
      "postgres",
    );
    expect(spec.fnName).toBe("statusIntEnum");
    expect(spec.enumIntCustomType?.intByMember).toEqual(INT_MAP);
    expect(spec.checkConstraint).toBe("status IN (0, 5, 9)");
  });

  test("a string-backed array-of-enum is unchanged — text[] with no codec", async () => {
    const spec = mapColumnType(
      await statusField({ name: "status", isArray: true, "@values": VALUES }),
      "postgres",
    );
    expect(spec.fnName).toBe("text");
    expect(spec.enumIntCustomType).toBeUndefined();
    expect(spec.modifiers).toContain(".array()");
    expect(spec.checkConstraint).toBeUndefined();
  });

  // An int-backed enum ARRAY persists each element as its int. On Postgres the scalar
  // codec composes through Drizzle's `.array()` (PgArray maps element-wise), so the
  // column is `integer[]`; the codec is the array-aware variant so a null element
  // reads back as null and an unmapped member throws instead of binding NULL.
  test("postgres int-backed enum ARRAY → the element codec + .array() (integer[])", async () => {
    const spec = mapColumnType(
      await statusField({ name: "status", isArray: true, "@values": VALUES, "@intValueMap": INT_MAP }),
      "postgres",
    );
    expect(spec.fnName).toBe("statusIntEnum");
    expect(spec.enumIntCustomType).toEqual({
      fnConstName: "statusIntEnum",
      toIntConstName: "STATUS_TO_INT",
      fromIntConstName: "STATUS_FROM_INT",
      dataType: "integer",
      members: VALUES,
      intByMember: INT_MAP,
      array: "native",
    });
    expect(spec.modifiers).toContain(".array()");
    expect(spec.fnOptions?.enum).toBeUndefined();
    // Membership on an array column stays app-level, as for string-backed enum[].
    expect(spec.checkConstraint).toBeUndefined();
  });

  // SQLite and MySQL keep an array in ONE JSON column. A text(…, { mode: "json" }) /
  // json() column would serialize the member SYMBOLS (D7's failure mode), so the
  // column is a whole-array codec writing a JSON array of the mapped ints.
  for (const [dialect, dataType] of [["sqlite", "text"], ["mysql", "json"]] as const) {
    test(`${dialect} int-backed enum ARRAY → a JSON-array-of-ints codec (${dataType})`, async () => {
      const spec = mapColumnType(
        await statusField({ name: "status", isArray: true, "@values": VALUES, "@intValueMap": INT_MAP }),
        dialect,
      );
      expect(spec.fnName).toBe("statusIntEnumArray");
      expect(spec.enumIntCustomType).toEqual({
        fnConstName: "statusIntEnumArray",
        toIntConstName: "STATUS_TO_INT",
        fromIntConstName: "STATUS_FROM_INT",
        dataType,
        members: VALUES,
        intByMember: INT_MAP,
        array: "json",
      });
      expect(spec.fnOptions).toBeUndefined();
      expect(spec.modifiers).not.toContain(".array()");
      // The codec's data type is already the member array; a $type<string[]>() would widen it.
      expect(spec.dollarTypeRef).toBeUndefined();
      expect(spec.checkConstraint).toBeUndefined();
    });
  }

  test("map AND array-ness both inherited from the shared declaration", async () => {
    const spec = mapColumnType(
      await statusField({ name: "status", extends: "Status", isArray: true }, [
        { "field.enum": { name: "Status", abstract: true, "@values": VALUES, "@intValueMap": INT_MAP } },
      ]),
      "sqlite",
    );
    expect(spec.enumIntCustomType?.array).toBe("json");
    expect(spec.enumIntCustomType?.intByMember).toEqual(INT_MAP);
  });
});
