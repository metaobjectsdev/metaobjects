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

  // Design D7, narrowed: int-backing is scalar-only, so there is no array codegen
  // shape to assert — the combination never reaches a generator. This test replaced
  // one that asserted `statusIntEnum(...).array()`, which composed on Postgres while
  // four ports silently got it wrong (Python bound the symbol list into an integer[],
  // Java and Kotlin emitted a scalar codec, and the sqlite branch stored symbols as
  // JSON text). The rejection itself is gated by the loader tests + the cross-port
  // error-enum-intvaluemap-array fixtures; this pins the CODEGEN-side consequence:
  // an array enum reaching a generator is always string-backed.
  test("an array-of-enum reaching codegen is string-backed — @intValueMap cannot load with isArray", async () => {
    const spec = mapColumnType(
      await statusField({ name: "status", isArray: true, "@values": VALUES }),
      "postgres",
    );
    expect(spec.fnName).toBe("text");
    expect(spec.enumIntCustomType).toBeUndefined();
    expect(spec.modifiers).toContain(".array()");
    // Membership on arrays stays app-level, exactly as for string-backed enum[].
    expect(spec.checkConstraint).toBeUndefined();
  });
});
