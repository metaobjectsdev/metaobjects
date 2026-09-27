// #335 — SQL lowering for a WHOLE-OBJECT `origin.aggregate @agg:collect` column.
//
// jsonb, not json, on Postgres: verified against PG 15 — `json` has neither an
// equality nor an ordering operator, so `json_agg(json_build_object(…) ORDER BY …)`
// does not run at all. `field.object` is already jsonb elsewhere in codegen.
//
// Element order defaults to the RELATED entity's PK ascending, not "value
// ascending": ordering rows by a serialized object is meaningless, and on PG json
// it does not even parse. An explicit @orderBy leads with the PK appended as a
// tie-break so equal-order rows stay byte-deterministic.

import { describe, test, expect } from "bun:test";
import type { ViewSpec, ViewOrderKey } from "../../src/projection/view-spec.js";
import { emitViewDdl } from "../../src/projection/view-ddl-emit.js";

const OPTS = { baseTableName: "products", joinTables: { Supplier: "suppliers" } } as const;

function wholeObject(orderBy: ViewOrderKey[] = []): ViewSpec {
  return {
    viewName: "v_product_summary",
    joinTree: {
      baseEntity: "Product",
      baseAlias: "p",
      joins: [
        { relationship: "suppliers", targetEntity: "Supplier", alias: "s", cardinality: "many",
          fkColumn: "product_id", pkColumn: "id", referenceHolder: "target", joinType: "left", children: [] },
      ],
    },
    selectSpec: {
      columns: [
        { kind: "passthrough", fieldName: "id", dbColAlias: "id", sourceAlias: "p", sourceColumn: "id" },
        {
          kind: "collectObjectAgg",
          fieldName: "supplierBriefs",
          dbColAlias: "supplier_briefs",
          sourceAlias: "s",
          joinedPkColumn: "id",
          members: [
            { memberName: "id", sourceColumn: "id" },
            { memberName: "name", sourceColumn: "supplier_name" },
          ],
          orderBy,
        },
      ],
    },
    groupBy: ["p.id"],
  };
}

describe("emitViewDdl — #335 whole-object collect", () => {
  test("postgres: jsonb_agg of jsonb_build_object, related-PK ascending, empty-set guarded", () => {
    const sql = emitViewDdl(wholeObject(), { dialect: "postgres", ...OPTS });
    expect(sql).toContain(
      "COALESCE(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.supplier_name) ORDER BY s.id ASC) " +
      "FILTER (WHERE s.id IS NOT NULL), '[]'::jsonb) AS supplier_briefs",
    );
  });

  // SQLite collects each row as [sort keys…, object] UNSORTED in the grouped query, then
  // sorts in an outer query and re-wraps each object with json(). No in-aggregate ORDER BY:
  // it needs SQLite 3.44, and on 3.44 it also turned the objects into quoted strings.
  test("sqlite: objects are collected unsorted with their PK key, then sorted and re-wrapped", () => {
    const sql = emitViewDdl(wholeObject(), { dialect: "sqlite", ...OPTS });
    expect(sql).toContain(
      "COALESCE(json_group_array(json_array(s.id, json_object('id', s.id, 'name', s.supplier_name))) " +
      "FILTER (WHERE s.id IS NOT NULL), json_array()) AS supplier_briefs",
    );
    expect(sql).toContain(
      "(SELECT json_group_array(json(mo_s.v)) FROM (SELECT json_extract(mo_je.value, '$[1]') AS v " +
      "FROM json_each(mo_g.supplier_briefs) mo_je ORDER BY json_extract(mo_je.value, '$[0]') ASC) mo_s) AS supplier_briefs",
    );
  });

  test("an explicit @orderBy leads and the related PK is appended as tie-break", () => {
    const sql = emitViewDdl(wholeObject([{ column: "supplier_name", dir: "desc" }]),
      { dialect: "postgres", ...OPTS });
    expect(sql).toContain("ORDER BY s.supplier_name DESC NULLS LAST, s.id ASC)");
  });

  test("the JSON key is the VO MEMBER name; the column read is the terminal entity's", () => {
    // `name` -> s.supplier_name. If these two ever collapse into one identifier the
    // rollup starts emitting the physical column name into the JSON payload, which the
    // generated type would not match.
    const sql = emitViewDdl(wholeObject(), { dialect: "postgres", ...OPTS });
    expect(sql).toContain("'name', s.supplier_name");
    expect(sql).not.toContain("'supplier_name', s.supplier_name");
  });
});

// The scalar @of arm shares this branch neighbourhood. Its emitted SQL is in every
// existing project's committed migrations, so it must not move by so much as a byte.
describe("emitViewDdl — #335 no-churn pin on the SCALAR collect arm", () => {
  const scalar = (distinct: boolean, orderBy: ViewOrderKey[]): ViewSpec => ({
    viewName: "v_order_summary",
    joinTree: {
      baseEntity: "Order",
      baseAlias: "o",
      joins: [
        { relationship: "items", targetEntity: "Item", alias: "i", cardinality: "many",
          fkColumn: "order_id", pkColumn: "id", referenceHolder: "target", joinType: "left", children: [] },
      ],
    },
    selectSpec: {
      columns: [
        { kind: "passthrough", fieldName: "id", dbColAlias: "id", sourceAlias: "o", sourceColumn: "id" },
        { kind: "collectAgg", fieldName: "categories", dbColAlias: "categories",
          sourceAlias: "i", sourceColumn: "category", joinedPkColumn: "id", distinct, orderBy },
      ],
    },
    groupBy: ["o.id"],
  });
  const opts = { baseTableName: "orders", joinTables: { Item: "items" } } as const;

  test("postgres: array_agg, value-ascending default, '{}' empty — unchanged", () => {
    expect(emitViewDdl(scalar(false, []), { dialect: "postgres", ...opts })).toContain(
      "COALESCE(array_agg(i.category ORDER BY i.category ASC) FILTER (WHERE i.id IS NOT NULL), '{}') AS categories",
    );
  });

  test("postgres: an explicit @orderBy still gets NO PK tie-break — unchanged", () => {
    // Deliberately asymmetric with the whole-object arm above: adding a tie-break here
    // would change the emitted SQL of every existing project that uses @orderBy.
    expect(emitViewDdl(scalar(false, [{ column: "category", dir: "desc" }]), { dialect: "postgres", ...opts })).toContain(
      "COALESCE(array_agg(i.category ORDER BY i.category DESC NULLS LAST) FILTER (WHERE i.id IS NOT NULL), '{}') AS categories",
    );
  });

  test("sqlite: the scalar arm orders by the value, with no PK tie-break", () => {
    const sql = emitViewDdl(scalar(false, []), { dialect: "sqlite", ...opts });
    expect(sql).toContain(
      "COALESCE(json_group_array(json_array(i.category, i.category)) FILTER (WHERE i.id IS NOT NULL), json_array()) AS categories",
    );
    expect(sql).toContain("ORDER BY json_extract(mo_je.value, '$[0]') ASC) mo_s) AS categories");
  });
});
