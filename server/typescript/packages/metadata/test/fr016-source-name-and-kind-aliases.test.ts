// FR-016 — source.rdb logical `name` attribute + per-kind physical-name aliases.
// Constants + map exposure tests. Drives the loader/serializer behavior tests
// that follow in this file once GREEN here.

import { describe, expect, test } from "bun:test";
import {
  SOURCE_ATTR_TABLE,
  SOURCE_ATTR_VIEW,
  SOURCE_ATTR_MATERIALIZED_VIEW,
  SOURCE_ATTR_PROC,
  SOURCE_ATTR_FUNCTION,
  PHYSICAL_NAME_ATTR_BY_KIND,
  SOURCE_KIND_TABLE,
  SOURCE_KIND_VIEW,
  SOURCE_KIND_MATERIALIZED_VIEW,
  SOURCE_KIND_STORED_PROC,
  SOURCE_KIND_TABLE_FUNCTION,
} from "../src/persistence/source/source-constants.js";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { MetaSource } from "../src/persistence/source/meta-source.js";
import { TYPE_OBJECT, TYPE_SOURCE } from "../src/shared/base-types.js";

async function load(doc: unknown) {
  const loader = new MetaDataLoader();
  return loader.load([
    new InMemoryStringSource(JSON.stringify(doc), { id: "test.json" }),
  ]);
}

async function firstSource(doc: unknown): Promise<MetaSource> {
  const { root } = await load(doc);
  const entity = root.ownChildren().find((c) => c.type === TYPE_OBJECT);
  if (!entity) throw new Error("no entity in doc");
  const source = entity.ownChildren().find((c) => c.type === TYPE_SOURCE);
  if (!(source instanceof MetaSource)) throw new Error("no source on entity");
  return source;
}

function oneSourceEntity(entityName: string, sourceBody: Record<string, unknown>) {
  return {
    "metadata.root": {
      package: "demo",
      children: [
        {
          "object.entity": {
            name: entityName,
            children: [
              { "source.rdb": sourceBody },
              { "field.long": { name: "id" } },
              { "identity.primary": { "name": "id", "@fields": "id" } },
            ],
          },
        },
      ],
    },
  };
}

/** Build a one-object model whose source.rdb has @kind plus the named physical-name attr.
 *  FR-024 (B4b hard cutover): a read-only @kind can no longer be an entity's PRIMARY
 *  source — the read-only-kind cases host on object.projection (the modern spelling);
 *  the writable "table" case stays an entity. */
function entityWithKindAndPhysicalName(
  kindValue: string,
  physicalNameAttr: string,
  physicalNameValue: string,
) {
  const objectKey = kindValue === "table" ? "object.entity" : "object.projection";
  const children: unknown[] = [
    {
      "source.rdb": {
        "@kind": kindValue,
        [`@${physicalNameAttr}`]: physicalNameValue,
      },
    },
    { "field.long": { name: "id" } },
  ];
  if (objectKey === "object.entity") {
    children.push({ "identity.primary": { "name": "id", "@fields": "id" } });
  }
  return {
    "metadata.root": {
      package: "demo",
      children: [
        {
          [objectKey]: {
            name: "Demo",
            children,
          },
        },
      ],
    },
  };
}

describe("FR-016 constants", () => {
  test("per-kind physical-name attr keys exported with kind-word values", () => {
    expect(SOURCE_ATTR_TABLE).toBe("table");
    expect(SOURCE_ATTR_VIEW).toBe("view");
    expect(SOURCE_ATTR_MATERIALIZED_VIEW).toBe("materializedView");
    expect(SOURCE_ATTR_PROC).toBe("proc");
    expect(SOURCE_ATTR_FUNCTION).toBe("function");
  });

  test("PHYSICAL_NAME_ATTR_BY_KIND maps every kind to its kind-word attr key", () => {
    expect(PHYSICAL_NAME_ATTR_BY_KIND.get(SOURCE_KIND_TABLE)).toBe(SOURCE_ATTR_TABLE);
    expect(PHYSICAL_NAME_ATTR_BY_KIND.get(SOURCE_KIND_VIEW)).toBe(SOURCE_ATTR_VIEW);
    expect(PHYSICAL_NAME_ATTR_BY_KIND.get(SOURCE_KIND_MATERIALIZED_VIEW))
      .toBe(SOURCE_ATTR_MATERIALIZED_VIEW);
    expect(PHYSICAL_NAME_ATTR_BY_KIND.get(SOURCE_KIND_STORED_PROC)).toBe(SOURCE_ATTR_PROC);
    expect(PHYSICAL_NAME_ATTR_BY_KIND.get(SOURCE_KIND_TABLE_FUNCTION)).toBe(SOURCE_ATTR_FUNCTION);
  });
});

describe("FR-016 attr-schema registration", () => {
  test("source.rdb accepts bare structural name with kind: table", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Demo",
              children: [
                { "source.rdb": { name: "Customers", "@kind": "table" } },
                { "field.long": { name: "id" } },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    expect(errors.map((e) => e.message)).toEqual([]);
  });

  test("source.rdb accepts @view with kind: view", async () => {
    const { errors } = await load(
      entityWithKindAndPhysicalName("view", "view", "v_customer_summary"),
    );
    expect(errors.map((e) => e.message)).toEqual([]);
  });

  test("source.rdb accepts @materializedView with kind: materializedView", async () => {
    const { errors } = await load(
      entityWithKindAndPhysicalName(
        "materializedView",
        "materializedView",
        "mv_customer_aggregate",
      ),
    );
    expect(errors.map((e) => e.message)).toEqual([]);
  });

  test("source.rdb accepts @proc with kind: storedProc", async () => {
    const { errors } = await load(
      entityWithKindAndPhysicalName("storedProc", "proc", "fn_get_customer"),
    );
    expect(errors.map((e) => e.message)).toEqual([]);
  });

  test("source.rdb accepts @function with kind: tableFunction", async () => {
    const { errors } = await load(
      entityWithKindAndPhysicalName("tableFunction", "function", "fn_customer_list"),
    );
    expect(errors.map((e) => e.message)).toEqual([]);
  });
});

describe("FR-016 MetaSource.physicalName — four-step resolution", () => {
  test("step 1: kind-matching @table for default (table) kind", async () => {
    const s = await firstSource(
      oneSourceEntity("Customer", { "@table": "customers" }),
    );
    expect(s.physicalName).toBe("customers");
  });

  test("step 1: kind-matching @view for view kind", async () => {
    const s = await firstSource(
      oneSourceEntity("CustomerSummary", {
        "@kind": "view",
        "@view": "v_customer_summary",
      }),
    );
    expect(s.physicalName).toBe("v_customer_summary");
  });

  test("step 1: kind-matching @proc for storedProc kind", async () => {
    const s = await firstSource(
      oneSourceEntity("PhaseSummary", {
        "@kind": "storedProc",
        "@proc": "fn_get_phase_summary",
      }),
    );
    expect(s.physicalName).toBe("fn_get_phase_summary");
  });

  test("step 1: kind-matching @materializedView for materializedView kind", async () => {
    const s = await firstSource(
      oneSourceEntity("Agg", {
        "@kind": "materializedView",
        "@materializedView": "mv_agg",
      }),
    );
    expect(s.physicalName).toBe("mv_agg");
  });

  test("step 1: kind-matching @function for tableFunction kind", async () => {
    const s = await firstSource(
      oneSourceEntity("List", {
        "@kind": "tableFunction",
        "@function": "fn_list",
      }),
    );
    expect(s.physicalName).toBe("fn_list");
  });

  test("step 2: legacy @table for non-table kind still resolves", async () => {
    const s = await firstSource(
      oneSourceEntity("PhaseSummary", {
        "@kind": "storedProc",
        "@table": "fn_legacy_phase_summary",
      }),
    );
    expect(s.physicalName).toBe("fn_legacy_phase_summary");
  });

  test("step 3: derives from source's structural name when no alias is set (table kind)", async () => {
    const s = await firstSource(
      oneSourceEntity("Order", { name: "Customers" }),
    );
    expect(s.physicalName).toBe("customers");
  });

  test("step 3: source.name derivation also works for non-table kind", async () => {
    const s = await firstSource(
      oneSourceEntity("OrderView", { name: "OrdersDaily", "@kind": "view" }),
    );
    expect(s.physicalName).toBe("orders_daily");
  });

  test("step 4: entity-name fallback when neither alias nor source.name is set", async () => {
    const s = await firstSource(oneSourceEntity("Customer", {}));
    expect(s.physicalName).toBe("customers"); // pluralize(snake_case("Customer"))
  });
});

describe("FR-016 loader validation", () => {
  test("ERR_PHYSICAL_NAME_KIND_MISMATCH — @view set with @kind: storedProc", async () => {
    const { errors } = await load(
      oneSourceEntity("Demo", { "@kind": "storedProc", "@view": "v_x" }),
    );
    const codes = errors.map((e) => (e as unknown as { code: string }).code);
    expect(codes).toContain("ERR_PHYSICAL_NAME_KIND_MISMATCH");
  });

  test("ERR_PHYSICAL_NAME_KIND_MISMATCH — @proc set with @kind: view", async () => {
    const { errors } = await load(
      oneSourceEntity("Demo", { "@kind": "view", "@proc": "fn_x" }),
    );
    const codes = errors.map((e) => (e as unknown as { code: string }).code);
    expect(codes).toContain("ERR_PHYSICAL_NAME_KIND_MISMATCH");
  });

  test("ERR_PHYSICAL_NAME_MULTIPLE — both @table and @view set", async () => {
    const { errors } = await load(
      oneSourceEntity("Demo", { "@table": "t_x", "@view": "v_x" }),
    );
    const codes = errors.map((e) => (e as unknown as { code: string }).code);
    expect(codes).toContain("ERR_PHYSICAL_NAME_MULTIPLE");
  });

  test("ERR_PHYSICAL_NAME_MULTIPLE — both @view and @proc set", async () => {
    const { errors } = await load(
      oneSourceEntity("Demo", { "@view": "v_x", "@proc": "fn_x" }),
    );
    const codes = errors.map((e) => (e as unknown as { code: string }).code);
    expect(codes).toContain("ERR_PHYSICAL_NAME_MULTIPLE");
  });

  test("WARN_LEGACY_PHYSICAL_NAME_ALIAS — @table set with @kind: view (legacy)", async () => {
    const { errors, warnings } = await load(
      oneSourceEntity("Demo", { "@kind": "view", "@table": "v_x" }),
    );
    // Legacy path: warn, not error.
    expect(errors.map((e) => (e as unknown as { code: string }).code))
      .not.toContain("ERR_PHYSICAL_NAME_KIND_MISMATCH");
    expect(warnings.map((w) => w.code)).toContain("WARN_LEGACY_PHYSICAL_NAME_ALIAS");
  });

  test("No error when @table used with default @kind (table)", async () => {
    const { errors, warnings } = await load(
      oneSourceEntity("Demo", { "@table": "demo" }),
    );
    expect(errors.map((e) => (e as unknown as { code: string }).code))
      .not.toContain("ERR_PHYSICAL_NAME_KIND_MISMATCH");
    expect(warnings.map((w) => w.code))
      .not.toContain("WARN_LEGACY_PHYSICAL_NAME_ALIAS");
  });
});

describe("FR-016 canonical-serializer rewrite (legacy @table → kind-matching alias)", () => {
  test("input @kind: view + @table → output @kind: view + @view", async () => {
    const { canonicalSerialize } = await import("../src/serializer-json.js");
    const { root } = await load(
      oneSourceEntity("OldStyleView", { "@kind": "view", "@table": "v_old" }),
    );
    const out = canonicalSerialize(root);
    expect(out).toContain("\"@view\": \"v_old\"");
    expect(out).not.toContain("\"@table\": \"v_old\"");
  });

  test("input @kind: storedProc + @table → output @kind: storedProc + @proc", async () => {
    const { canonicalSerialize } = await import("../src/serializer-json.js");
    const { root } = await load(
      oneSourceEntity("OldStyleProc", { "@kind": "storedProc", "@table": "fn_x" }),
    );
    const out = canonicalSerialize(root);
    expect(out).toContain("\"@proc\": \"fn_x\"");
    expect(out).not.toContain("\"@table\": \"fn_x\"");
  });

  test("input @kind: materializedView + @table → output @kind: materializedView + @materializedView", async () => {
    const { canonicalSerialize } = await import("../src/serializer-json.js");
    const { root } = await load(
      oneSourceEntity("OldStyleMV", { "@kind": "materializedView", "@table": "mv_x" }),
    );
    const out = canonicalSerialize(root);
    expect(out).toContain("\"@materializedView\": \"mv_x\"");
    expect(out).not.toContain("\"@table\": \"mv_x\"");
  });

  test("input @kind: tableFunction + @table → output @kind: tableFunction + @function", async () => {
    const { canonicalSerialize } = await import("../src/serializer-json.js");
    const { root } = await load(
      oneSourceEntity("OldStyleFn", { "@kind": "tableFunction", "@table": "fn_list" }),
    );
    const out = canonicalSerialize(root);
    expect(out).toContain("\"@function\": \"fn_list\"");
    expect(out).not.toContain("\"@table\": \"fn_list\"");
  });

  test("input @kind: table + @table stays @table on output (no rewrite for the canonical case)", async () => {
    const { canonicalSerialize } = await import("../src/serializer-json.js");
    const { root } = await load(
      oneSourceEntity("Customer", { "@table": "customers" }),
    );
    const out = canonicalSerialize(root);
    expect(out).toContain("\"@table\": \"customers\"");
  });

  test("input @kind: view + @view (already canonical) round-trips unchanged", async () => {
    const { canonicalSerialize } = await import("../src/serializer-json.js");
    const { root } = await load(
      oneSourceEntity("CustomerSummary", { "@kind": "view", "@view": "v_summary" }),
    );
    const out = canonicalSerialize(root);
    expect(out).toContain("\"@view\": \"v_summary\"");
  });
});
