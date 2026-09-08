// The grid's initial sort direction, asked of the metadata by the two emitters that
// render it.
//
// `@sortableDefaultOrder` says which way a sort runs when it names this field but omits
// the order. A `layout.dataGrid` that names a field with `@defaultSortField` and gives no
// `@defaultSortOrder` is exactly that case — it names a field and omits an order. Until
// now neither grid emitter asked: the columns file emitted `defaultSort` only when BOTH
// layout attrs were present, and the hook folded an absent order to ascending. So a grid
// rendered its first page in one direction while the endpoint it queried returned the
// other, and the generated agent UI page described a third thing.
//
// WHY THE OLD TESTS COULD NOT SEE IT: the one fixture with a dataGrid
// (`fixtures/single-entity.json`) declares `@defaultSortField` AND `@defaultSortOrder`
// together, so the `sortField && sortOrder` branch was always true and the field-only
// path — the one the registered contract describes — was never exercised at all. A green
// suite over a fixture that cannot express the failing case is not coverage.
//
// These tests range over the three authoring forms and assert BOTH files, because the
// defect was the two emitters disagreeing, not either one being wrong in isolation.

import { describe, test, expect } from "bun:test";
import { tanstackGrid, tanstackGridHook } from "../src/index.js";
import {
  makeRenderContext,
  buildPkMap,
  buildRelationMap,
  type GenContext,
} from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot, type LoaderError } from "@metaobjectsdev/metadata";

/**
 * A grid whose `@defaultSortField` is `purchasedAt`.
 *
 * `@sortableDefaultOrder` sits on the FIELD (that is where it is registered — it is a
 * `field.*` attr), and `@defaultSortOrder` is present only when a case supplies it. That
 * asymmetry IS the case under test: the layout names a column, and only the column knows
 * which way it runs.
 */
function model(opts: {
  fieldDefaultOrder?: "asc" | "desc" | undefined;
  layoutOrder?: "asc" | "desc" | undefined;
  fieldSortable?: boolean | undefined;
}): string {
  return JSON.stringify({
    "metadata.root": {
      children: [{
        "object.entity": {
          name: "Order",
          children: [
            { "source.rdb": { "@table": "orders" } },
            { "field.long": { name: "id", children: [
              { "identity.primary": { name: "id", "@fields": ["id"], "@generation": "increment" } },
            ] } },
            { "field.string": { name: "customer" } },
            { "field.timestamp": {
                name: "purchasedAt",
                "@filterable": true,
                ...(opts.fieldSortable === undefined ? {} : { "@sortable": opts.fieldSortable }),
                ...(opts.fieldDefaultOrder ? { "@sortableDefaultOrder": opts.fieldDefaultOrder } : {}),
              } },
            { "layout.dataGrid": {
                name: "default",
                "@columns": ["customer", "purchasedAt"],
                "@defaultSortField": "purchasedAt",
                ...(opts.layoutOrder ? { "@defaultSortOrder": opts.layoutOrder } : {}),
              } },
          ],
        },
      }],
    },
  });
}

/**
 * The ADR-0009 envelope code of a loader error.
 *
 * `load()` types its errors as bare `Error[]` — deliberately widened so a downstream
 * provider's own validator can emit a code outside the core union — so the code has to be
 * narrowed off `unknown` rather than assumed on `Error`.
 */
function loaderErrorCode(e: Error): string {
  const code = (e as unknown as Partial<LoaderError>).code;
  return typeof code === "string" ? `${e.name}: ${code}` : `${e.name}`;
}

async function ctxFor(json: string): Promise<GenContext> {
  // NB: InMemoryStringSource takes (content, opts) — content FIRST. Passing the id first
  // loads the string "m" as the document and fails ERR_MALFORMED_JSON, which presents as
  // an empty generator output rather than a load error.
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(json, { id: "model" })]);
  // A model that fails to load makes every generator emit NOTHING, which reads as "the
  // grid tier generates no sort" — the exact false this test must not be able to produce.
  expect(errors.map(loaderErrorCode)).toEqual([]);
  const entities = root.objects();
  const renderContext = makeRenderContext({
    dialect: "sqlite", loadedRoot: root as MetaRoot, outDir: "/tmp",
    dbImport: "../db", extStyle: "none",
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
  });
  return {
    entities, loadedRoot: root,
    matches: () => true,
    config: { outDir: "/tmp", extStyle: "none", dbImport: "../db", dialect: "sqlite" },
    renderContext,
    warn: () => {},
  };
}

/**
 * Search every file a generator emitted, not just the first.
 *
 * Both generators emit a companion `<Entity>.meta.ts` alongside the grid file, and it is
 * not ordered second — indexing `files[0]` reads the descriptor and reports "no sort
 * anywhere", which is indistinguishable from the defect under test.
 */
async function emitted(
  gen: ReturnType<typeof tanstackGrid>,
  ctx: GenContext,
): Promise<string> {
  const files = await gen.generate(ctx);
  expect(files.length).toBeGreaterThan(0);
  return files.map((f) => f.content).join("\n");
}

/** The grid const's initial sort direction: `defaultSort: { field, order }`. */
async function columnsSort(ctx: GenContext): Promise<string | undefined> {
  return (await emitted(tanstackGrid(), ctx)).match(/defaultSort:\s*\{[^}]*order:\s*"(\w+)"/)?.[1];
}

/** The hook's initial sorting direction — `useState<SortingState>([{ id, desc }])`. */
async function hookSort(ctx: GenContext): Promise<string | undefined> {
  const desc = (await emitted(tanstackGridHook(), ctx))
    .match(/id:\s*"purchasedAt",\s*desc:\s*(true|false)/)?.[1];
  return desc === undefined ? undefined : desc === "true" ? "desc" : "asc";
}

/** The field name the grid const sorted on, if it emitted a sort at all. */
async function columnsSortField(ctx: GenContext): Promise<string | undefined> {
  return (await emitted(tanstackGrid(), ctx)).match(/defaultSort:\s*\{\s*field:\s*"(\w+)"/)?.[1];
}

describe("grid default sort — the field's @sortableDefaultOrder applies", () => {
  test("layout names a field with NO @defaultSortOrder: the field's declared desc wins", async () => {
    const ctx = await ctxFor(model({ fieldDefaultOrder: "desc" }));
    // This is the case the registry prose has always described and no emitter implemented.
    expect(await columnsSortField(ctx)).toBe("purchasedAt");
    expect(await columnsSort(ctx)).toBe("desc");
    expect(await hookSort(ctx)).toBe("desc");
  });

  test("an explicit @defaultSortOrder on the layout still wins over the field", async () => {
    // Field says desc, layout says asc. The layout is the more specific declaration for
    // THIS grid, so it governs — the field default is a fallback, not an override.
    const ctx = await ctxFor(model({ fieldDefaultOrder: "desc", layoutOrder: "asc" }));
    expect(await columnsSort(ctx)).toBe("asc");
    expect(await hookSort(ctx)).toBe("asc");
  });

  test("neither declared: ascending, and the sort is still emitted", async () => {
    const ctx = await ctxFor(model({}));
    expect(await columnsSortField(ctx)).toBe("purchasedAt");
    expect(await columnsSort(ctx)).toBe("asc");
    expect(await hookSort(ctx)).toBe("asc");
  });

  test("the two emitters agree in every case", async () => {
    // The bug was disagreement, so agreement is the invariant — asserted across the whole
    // matrix rather than per case, so a future emitter that reads only one of the attrs
    // cannot stay green by matching whichever direction this test happened to pick.
    for (const fieldDefaultOrder of [undefined, "asc", "desc"] as const) {
      for (const layoutOrder of [undefined, "asc", "desc"] as const) {
        const ctx = await ctxFor(model({ fieldDefaultOrder, layoutOrder }));
        const [cols, hook] = [await columnsSort(ctx), await hookSort(ctx)];
        expect(`${fieldDefaultOrder}/${layoutOrder} → ${cols}/${hook}`).toBe(
          `${fieldDefaultOrder}/${layoutOrder} → ${cols}/${cols}`,
        );
        expect(cols).toBe(layoutOrder ?? fieldDefaultOrder ?? "asc");
      }
    }
  });

  test("the resolver answers WHICH WAY, not WHETHER — a non-sortable named field is still the named field", async () => {
    // purchasedAt gets @sortable: false while the grid still names it. The resolver must
    // not quietly re-point the grid at some other column: "the model named a field the
    // endpoint will reject" is a different question (the loader validation and the 400 own
    // it), and silently papering over it here would make the generated UI disagree with
    // the METADATA rather than with the runtime. So the sort stays on the named field, and
    // the field's declared direction still applies to it.
    const ctx = await ctxFor(model({ fieldDefaultOrder: "desc", fieldSortable: false }));
    expect(await columnsSortField(ctx)).toBe("purchasedAt");
    expect(await columnsSort(ctx)).toBe("desc");
    expect(await hookSort(ctx)).toBe("desc");
  });
});
