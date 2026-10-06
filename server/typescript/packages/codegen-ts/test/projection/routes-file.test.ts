// Tests for source-aware dispatch in renderRoutesFile.
// Verifies that:
//   - projection entities emit mountReadOnlyCrudRoutes + camelView import
//   - vanilla entities still emit mountCrudRoutes + table var import

import { describe, test, expect } from "bun:test";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MetaDataLoader, InMemoryStringSource, loadUris, reportReadModel } from "@metaobjectsdev/metadata";
import type { MetaObject, MetaRoot } from "@metaobjectsdev/metadata";
import { renderRoutesFile } from "../../src/templates/routes-file.js";
import { renderRoutesFileHono } from "../../src/templates/routes-file-hono.js";
import { hasGeneratedForm, hasItemRoute, itemRouteField, servesClientTier, servesReadApi } from "../../src/api-surface.js";
import { renderQueriesFile } from "../../src/templates/queries-file.js";
import { servedReport } from "../../src/source-detect.js";
import { hasUiSurface } from "../../src/generators/agent-ui-page.js";
import { runGen } from "../../src/runner.js";
import { routesFile } from "../../src/generators/routes-file.js";
import { ERR_COLLECTION_NAME_COLLISION } from "../../src/naming/collection-name-collision.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import { GENERATED_HEADER } from "../../src/constants.js";

// ---------------------------------------------------------------------------
// Shared fixture loader
// ---------------------------------------------------------------------------

async function loadMetadata(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "test", children } });
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (result.errors.length > 0) {
    throw new Error(
      `Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`,
    );
  }
  return result.root;
}

// ---------------------------------------------------------------------------
// Fixture: ProgramSummary projection (source.rdb @kind:view only)
// ---------------------------------------------------------------------------

async function loadProjectionFixture() {
  const root = await loadMetadata([
    {
      "object.entity": {
        name: "Program",
        children: [
          { "source.rdb": { "@table": "programs" } },
          { "field.int": { name: "id", } },
          { "field.string": { name: "title", } },
          { "identity.primary": { "name": "id", "@fields": "id" } },
          {
            "relationship.association": {
              name: "weeks",
              "@objectRef": "Week",
              "@cardinality": "many",
            },
          },
        ],
      },
    },
    {
      "object.entity": {
        name: "Week",
        children: [
          { "source.rdb": { "@table": "weeks" } },
          { "field.int": { name: "id", } },
          { "field.int": { name: "programId", } },
          { "identity.primary":   { "name": "id", "@fields": "id" } },
          { "identity.reference": { name: "ref_program", "@fields": "programId", "@references": "Program" } },
        ],
      },
    },
    {
      "object.projection": {
        name: "ProgramSummary",
        children: [
          { "source.rdb": { "@kind": "view", "@table": "v_program_summary" } },
          {
            "field.int": {
              name: "weekCount",
              children: [
                {
                  "origin.aggregate": {
                    "@agg": "count",
                    "@of": "Week.id",
                    "@via": "Program.weeks",
                  },
                },
              ],
            },
          },
        ],
      },
    },
  ]);

  const projection = root.objects().find((o) => o.name === "ProgramSummary");
  if (!projection) throw new Error("ProgramSummary not found");

  const ctx = makeRenderContext({
    dialect: "sqlite",
    loadedRoot: root,
    outDir: "/x",
    dbImport: "~/db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });

  return { root, projection, ctx };
}

// ---------------------------------------------------------------------------
// Fixture: vanilla Post entity (source.rdb @kind:table)
// ---------------------------------------------------------------------------

async function loadVanillaFixture() {
  const root = await loadMetadata([
    {
      "object.entity": {
        name: "Post",
        children: [
          { "source.rdb": { "@table": "posts" } },
          { "field.long": { name: "id", } },
          { "field.string": { name: "title", } },
          { "identity.primary": { "name": "id", "@fields": "id" } },
        ],
      },
    },
  ]);

  const entity = root.objects().find((o) => o.name === "Post");
  if (!entity) throw new Error("Post not found");

  const ctx = makeRenderContext({
    dialect: "sqlite",
    loadedRoot: root,
    outDir: "/x",
    dbImport: "~/db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });

  return { root, entity, ctx };
}

// ---------------------------------------------------------------------------
// Fixture: write-through Order entity (writable table + replica view + derived field)
// ---------------------------------------------------------------------------

async function loadWriteThroughFixture() {
  const root = await loadMetadata([
    {
      "object.entity": {
        name: "Customer",
        children: [
          { "source.rdb": { "@table": "customers" } },
          { "field.long": { name: "id" } },
          { "field.string": { name: "name" } },
          { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
        ],
      },
    },
    {
      "object.entity": {
        name: "Order",
        children: [
          { "source.rdb": { "@role": "primary", "@table": "orders" } },
          { "source.rdb": { "@role": "replica", "@kind": "view", "@table": "v_order_with_customer" } },
          { "field.long": { name: "id" } },
          { "field.long": { name: "customerId", "@required": true } },
          {
            "field.string": {
              name: "customerName",
              children: [{ "origin.passthrough": { "@from": "Customer.name", "@via": "Order.customer" } }],
            },
          },
          { "relationship.association": { name: "customer", "@objectRef": "Customer", "@cardinality": "one" } },
          { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
          { "identity.reference": { name: "ref_customer", "@fields": "customerId", "@references": "Customer" } },
        ],
      },
    },
  ]);

  const entity = root.objects().find((o) => o.name === "Order");
  if (!entity) throw new Error("Order not found");

  const ctx = makeRenderContext({
    dialect: "sqlite",
    loadedRoot: root,
    outDir: "/x",
    dbImport: "~/db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });

  return { root, entity, ctx };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("renderRoutesFile — source-aware dispatch", () => {
  describe("projection path (isProjection = true)", () => {
    test("emits @generated header", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderRoutesFile(projection, ctx);
      expect(out).toContain(GENERATED_HEADER);
    });

    test("emits mountReadOnlyCrudRoutes (not mountCrudRoutes)", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderRoutesFile(projection, ctx);
      expect(out).toContain("mountReadOnlyCrudRoutes");
      expect(out).not.toContain("mountCrudRoutes(");
    });

    test("imports camelView from entity file", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderRoutesFile(projection, ctx);
      // camelName = "programSummary", so "programSummaryView"
      expect(out).toContain("programSummaryView");
    });

    test("imports FilterAllowlist and SortAllowlist", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderRoutesFile(projection, ctx);
      expect(out).toContain("ProgramSummaryFilterAllowlist");
      expect(out).toContain("ProgramSummaryFilterAllowlist");
    });

    test("passes view (not table) to mountReadOnlyCrudRoutes", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderRoutesFile(projection, ctx);
      expect(out).toContain("view:");
      expect(out).toContain("programSummaryView");
      expect(out).not.toContain("table:");
    });

    test("does NOT import InsertSchema or UpdateSchema", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderRoutesFile(projection, ctx);
      expect(out).not.toContain("InsertSchema");
      expect(out).not.toContain("UpdateSchema");
    });

    test("exports a handler function named programSummaryRoutes", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderRoutesFile(projection, ctx);
      expect(out).toContain("programSummaryRoutes");
    });

    test("imports from @metaobjectsdev/runtime-ts/drizzle-fastify", async () => {
      const { projection, ctx } = await loadProjectionFixture();
      const out = renderRoutesFile(projection, ctx);
      expect(out).toContain("@metaobjectsdev/runtime-ts/drizzle-fastify");
    });
  });

  describe("vanilla entity path (isProjection = false)", () => {
    test("emits @generated header", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderRoutesFile(entity, ctx);
      expect(out).toContain(GENERATED_HEADER);
    });

    test("emits mountCrudRoutes (not mountReadOnlyCrudRoutes)", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderRoutesFile(entity, ctx);
      expect(out).toContain("mountCrudRoutes");
      expect(out).not.toContain("mountReadOnlyCrudRoutes");
    });

    test("imports table var from entity file", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderRoutesFile(entity, ctx);
      // variableNameFromEntity("Post") → "post" table
      expect(out).toContain("post");
    });

    test("imports InsertSchema and UpdateSchema", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderRoutesFile(entity, ctx);
      expect(out).toContain("PostInsertSchema");
      expect(out).toContain("PostUpdateSchema");
    });

    test("passes table (not view) to mountCrudRoutes", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderRoutesFile(entity, ctx);
      expect(out).toContain("table:");
      expect(out).not.toContain("view:");
    });

    test("exports a handler function named postRoutes", async () => {
      const { entity, ctx } = await loadVanillaFixture();
      const out = renderRoutesFile(entity, ctx);
      expect(out).toContain("postRoutes");
    });
  });

  // #214 — a write-through entity has FULL CRUD (writes → table) but its READS
  // must route through the replica view so the HTTP responses carry the derived
  // origin.passthrough field. The routes file must pass `readView` to mountCrudRoutes.
  describe("write-through entity path (isWriteThrough = true)", () => {
    test("emits mountCrudRoutes (full CRUD, not read-only)", async () => {
      const { entity, ctx } = await loadWriteThroughFixture();
      const out = renderRoutesFile(entity, ctx);
      expect(out).toContain("mountCrudRoutes");
      expect(out).not.toContain("mountReadOnlyCrudRoutes");
    });

    test("passes readView (the replica view) to mountCrudRoutes", async () => {
      const { entity, ctx } = await loadWriteThroughFixture();
      const out = renderRoutesFile(entity, ctx);
      // camelName = "order" → the entity file exports "orderView"
      expect(out).toContain("readView:");
      expect(out).toContain("orderView");
    });

    test("still writes to the table + imports the write schemas", async () => {
      const { entity, ctx } = await loadWriteThroughFixture();
      const out = renderRoutesFile(entity, ctx);
      expect(out).toContain("table:");
      expect(out).toContain("OrderInsertSchema");
      expect(out).toContain("OrderUpdateSchema");
    });
  });
});

// ---------------------------------------------------------------------------
// FR-044 Plan 3 — a served report, and the keyless projection it shares a path with
// ---------------------------------------------------------------------------

// test/projection → test → codegen-ts → packages → typescript → server → repo root
const REPO_FIXTURES = resolve(import.meta.dir, "..", "..", "..", "..", "..", "..", "fixtures");
const REPORTING_WITH = join(REPO_FIXTURES, "codegen-noop", "reporting", "with", "meta.shop.json");

async function loadReportingModel(): Promise<MetaRoot> {
  const result = await loadUris([pathToFileURL(REPORTING_WITH).href]);
  if (result.errors.length > 0) {
    throw new Error(`Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`);
  }
  return result.root;
}

function declared(root: MetaRoot, name: string): MetaObject {
  const found = root.objects().find((o) => o.name === name);
  if (!found) throw new Error(`${name} not found`);
  return found;
}

function ctxFor(root: MetaRoot, apiPrefix = "") {
  return makeRenderContext({
    dialect: "postgres", loadedRoot: root, outDir: "/x", dbImport: "~/db", apiPrefix,
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
  });
}

/** A projection with a single-column identity inherited from its base. */
async function loadKeyedProjectionFixture() {
  const root = await loadMetadata([
    {
      "object.entity": {
        name: "Program",
        children: [
          { "source.rdb": { "@table": "programs" } },
          { "field.int": { name: "id" } },
          { "field.string": { name: "title" } },
          { "identity.primary": { name: "id", "@fields": "id" } },
        ],
      },
    },
    {
      "object.projection": {
        name: "ProgramCard",
        children: [
          { "source.rdb": { "@kind": "view", "@table": "v_program_card" } },
          { "field.int": { name: "id", extends: "Program.id" } },
          { "identity.primary": { name: "id", extends: "Program.id" } },
          { "field.string": { name: "title", extends: "Program.title" } },
        ],
      },
    },
  ]);
  return { projection: declared(root, "ProgramCard"), ctx: makeRenderContext({
    dialect: "sqlite", loadedRoot: root, outDir: "/x", dbImport: "~/db",
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
  }) };
}

describe("renderRoutesFile — a served report (FR-044 Plan 3)", () => {
  test("a served report mounts a keyless read-only surface", async () => {
    // Pins the generated call shape (mount function, options, comment text) that the
    // booted-server api-contract report corpus exercises at runtime but does not itself pin.
    const root = await loadReportingModel();
    const model = reportReadModel(declared(root, "StoreTotals"), root);
    for (const out of [
      renderRoutesFile(model, ctxFor(root)),
      renderRoutesFile(model, ctxFor(root, "/api")),
      renderRoutesFileHono(model, ctxFor(root)),
    ]) {
      expect(out).toContain("mountReadOnlyCrudRoutes");
      expect(out).toContain("itemRoutes: false,");
      expect(out).toContain('resource: "report",');
      expect(out).toContain("(report — view-backed, no writes)");
      expect(out).toContain("Exposes GET list only. POST returns 405.");
      expect(out).not.toContain("projection");
      expect(out).not.toContain("GET :id");
    }
  });

  test("a projection with a single-column identity is unchanged", async () => {
    const { projection, ctx } = await loadKeyedProjectionFixture();
    expect(hasItemRoute(projection)).toBe(true);
    for (const out of [renderRoutesFile(projection, ctx), renderRoutesFileHono(projection, ctx)]) {
      expect(out).toContain("(projection — view-backed, no writes)");
      expect(out).toContain("Exposes GET list + GET :id only. POST/PATCH/DELETE return 405.");
      // No key at all, not `itemRoutes: true`: the keyed output keeps its bytes.
      expect(out).not.toContain("itemRoutes");
      expect(out).not.toContain("resource:");
    }
  });

  test("a projection with an `id` column and no declared identity mounts no item routes", async () => {
    // A field named `id` is a convention, not a declared key: nothing addresses a row, so
    // no `/:id` route of any verb is mounted (the JVM and C# rule).
    const root = await loadMetadata([
      {
        "object.entity": {
          name: "Program",
          children: [
            { "source.rdb": { "@table": "programs" } },
            { "field.int": { name: "id" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
          ],
        },
      },
      {
        "object.projection": {
          name: "ProgramRow",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_program_row" } },
            { "field.int": { name: "id" } },
          ],
        },
      },
    ]);
    const projection = declared(root, "ProgramRow");
    expect(projection.primaryIdentity()).toBeUndefined();
    expect(hasItemRoute(projection)).toBe(false);
    const ctx = makeRenderContext({
      dialect: "sqlite", loadedRoot: root, outDir: "/x", dbImport: "~/db",
      pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
    });
    for (const out of [renderRoutesFile(projection, ctx), renderRoutesFileHono(projection, ctx)]) {
      expect(out).toContain("itemRoutes: false,");
      expect(out).not.toContain("GET :id");
    }
  });

  test("a projection with a composite identity keeps its item routes, as before", async () => {
    const root = await loadMetadata([
      {
        "object.entity": {
          name: "Seat",
          children: [
            { "source.rdb": { "@table": "seats" } },
            { "field.int": { name: "row" } },
            { "field.int": { name: "num" } },
            { "identity.primary": { name: "pk", "@fields": ["row", "num"] } },
          ],
        },
      },
      {
        "object.projection": {
          name: "SeatView",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_seat" } },
            { "field.int": { name: "row", extends: "Seat.row" } },
            { "field.int": { name: "num", extends: "Seat.num" } },
            { "identity.primary": { name: "pk", extends: "Seat.pk" } },
          ],
        },
      },
    ]);
    const projection = declared(root, "SeatView");
    expect(hasItemRoute(projection)).toBe(true);
    const ctx = makeRenderContext({
      dialect: "sqlite", loadedRoot: root, outDir: "/x", dbImport: "~/db",
      pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
    });
    expect(renderRoutesFile(projection, ctx)).not.toContain("itemRoutes");
  });

  // I1 (whole-branch review): the read-only mount addresses `id` unless told otherwise, so
  // a projection keyed on another field must name it, or `GET /:id` reads with no WHERE.
  test("a projection keyed on a field not named `id` names that field as the mount's idColumn", async () => {
    const root = await loadMetadata([
      {
        "object.entity": {
          name: "Product",
          children: [
            { "source.rdb": { "@table": "products" } },
            { "field.string": { name: "code" } },
            { "field.string": { name: "title" } },
            { "identity.primary": { name: "pk", "@fields": "code" } },
          ],
        },
      },
      {
        "object.projection": {
          name: "ProductCard",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_product_card" } },
            { "field.string": { name: "code", extends: "Product.code" } },
            { "identity.primary": { name: "pk", extends: "Product.pk" } },
            { "field.string": { name: "title", extends: "Product.title" } },
          ],
        },
      },
    ]);
    const projection = declared(root, "ProductCard");
    expect(hasItemRoute(projection)).toBe(true);
    expect(itemRouteField(projection)).toBe("code");
    const mk = (apiPrefix: string) => makeRenderContext({
      dialect: "sqlite", loadedRoot: root, outDir: "/x", dbImport: "~/db", apiPrefix,
      pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
    });
    expect(renderRoutesFile(projection, mk(""))).toContain('    dialect: "sqlite",\n    idColumn: "code",\n  });');
    expect(renderRoutesFile(projection, mk("/api"))).toContain('      dialect: "sqlite",\n      idColumn: "code",\n    });');
    expect(renderRoutesFileHono(projection, mk(""))).toContain('    dialect: "sqlite",\n    idColumn: "code",\n  });');
    // The by-id query reads the same field of the same view the mount addresses.
    const queries = renderQueriesFile(projection, mk(""));
    expect(queries).toContain("eq(productCardView.code, code)");
  });

  test("a keyed-on-`id` projection passes no idColumn and ends its options at `dialect`", async () => {
    const { projection, ctx } = await loadKeyedProjectionFixture();
    expect(itemRouteField(projection)).toBe("id");
    for (const out of [renderRoutesFile(projection, ctx), renderRoutesFileHono(projection, ctx)]) {
      expect(out).not.toContain("idColumn");
      expect(out).toContain('    dialect: "sqlite",\n  });');
    }
  });

  test("a composite identity whose first field is not `id` addresses that first field, as its by-id query does", async () => {
    const root = await loadMetadata([
      {
        "object.entity": {
          name: "Seat",
          children: [
            { "source.rdb": { "@table": "seats" } },
            { "field.int": { name: "row" } },
            { "field.int": { name: "num" } },
            { "identity.primary": { name: "pk", "@fields": ["row", "num"] } },
          ],
        },
      },
      {
        "object.projection": {
          name: "SeatView",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_seat" } },
            { "field.int": { name: "row", extends: "Seat.row" } },
            { "field.int": { name: "num", extends: "Seat.num" } },
            { "identity.primary": { name: "pk", extends: "Seat.pk" } },
          ],
        },
      },
    ]);
    const projection = declared(root, "SeatView");
    const ctx = makeRenderContext({
      dialect: "sqlite", loadedRoot: root, outDir: "/x", dbImport: "~/db",
      pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
    });
    expect(renderRoutesFile(projection, ctx)).toContain('idColumn: "row",');
    expect(renderQueriesFile(projection, ctx)).toContain("eq(seatViewView.row, row)");
  });

  test("a keyless object has no item-route field and passes no idColumn", async () => {
    const root = await loadReportingModel();
    const model = reportReadModel(declared(root, "StoreTotals"), root);
    expect(itemRouteField(model)).toBeUndefined();
    expect(renderRoutesFile(model, ctxFor(root))).not.toContain("idColumn");
  });

  test("a report with a derived field named `id` still mounts no item routes", async () => {
    const root = await loadMetadata([
      {
        "object.entity": {
          name: "Invoice",
          children: [
            { "source.rdb": { "@table": "invoices" } },
            { "field.long": { name: "id" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
            { "dimension.attribute": { name: "id", "@of": "Invoice.id" } },
            { "measure.aggregate": { name: "invoices", "@agg": "count", "@of": "Invoice.id" } },
          ],
        },
      },
      {
        "object.report": {
          name: "InvoiceRows",
          "@from": "Invoice",
          "@dimensions": ["id"],
          "@measures": ["invoices"],
          children: [{ "source.rdb": { "@kind": "view", "@table": "v_invoice_rows" } }],
        },
      },
    ]);
    const report = declared(root, "InvoiceRows");
    const model = reportReadModel(report, root);
    // Not vacuous: the read model really has a field called `id`.
    expect(model.findField("id")).toBeDefined();
    expect(hasItemRoute(report)).toBe(false);
    expect(hasItemRoute(model)).toBe(false);
    const ctx = ctxFor(root);
    for (const out of [renderRoutesFile(model, ctx), renderRoutesFileHono(model, ctx)]) {
      expect(out).toContain("itemRoutes: false,");
      expect(out).toContain('resource: "report",');
    }
  });

  test("a keyless projection (no identity, no `id` column) mounts no item routes and is still called a projection", async () => {
    const { projection, ctx } = await loadProjectionFixture();
    expect(projection.primaryIdentity()).toBeUndefined();
    expect(projection.findField("id")).toBeUndefined();
    expect(hasItemRoute(projection)).toBe(false);
    for (const out of [renderRoutesFile(projection, ctx), renderRoutesFileHono(projection, ctx)]) {
      expect(out).toContain("itemRoutes: false,");
      expect(out).not.toContain("resource:");
      expect(out).toContain("(projection — view-backed, no writes)");
      expect(out).toContain("Exposes GET list only. POST returns 405.");
    }
  });

  test("a served report has a read API and no client tier; an unserved one has neither", async () => {
    const root = await loadReportingModel();
    const storeTotals = declared(root, "StoreTotals");
    // The declared node and its read model answer the same.
    for (const o of [storeTotals, reportReadModel(storeTotals, root)]) {
      expect(servedReport(o)).toBe(true);
      expect(servesReadApi(o)).toBe(true);
      expect(servesClientTier(o)).toBe(false);
      expect(hasUiSurface(o)).toBe(false);
      expect(hasGeneratedForm(o)).toBe(false);
      expect(hasItemRoute(o)).toBe(false);
    }
    for (const name of ["ProgramEngagement", "DailyRevenue"]) {
      const sourceless = declared(root, name);
      expect(servedReport(sourceless)).toBe(false);
      expect(servesReadApi(sourceless)).toBe(false);
      expect(servesClientTier(sourceless)).toBe(false);
    }
    // An entity is untouched by the split: both answers are the old one.
    const program = declared(root, "Program");
    expect(servesReadApi(program)).toBe(true);
    expect(servesClientTier(program)).toBe(true);
  });

  test("a report and an entity that share a route segment are a generation error", async () => {
    const root = await loadMetadata([
      {
        "object.entity": {
          name: "Invoice",
          children: [
            { "source.rdb": { "@table": "invoices" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "status" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
            { "dimension.attribute": { name: "status", "@of": "Invoice.status" } },
            { "measure.aggregate": { name: "invoices", "@agg": "count", "@of": "Invoice.id" } },
          ],
        },
      },
      {
        "object.report": {
          name: "Invoices",
          "@from": "Invoice",
          "@dimensions": ["status"],
          "@measures": ["invoices"],
          children: [{ "source.rdb": { "@kind": "view", "@table": "v_invoices" } }],
        },
      },
    ]);
    const run = runGen({
      config: { outDir: "src/generated", extStyle: "js", dialect: "postgres", dbImport: "../db", generators: [routesFile()] },
      metadata: root,
      dryRun: true,
    });
    await expect(run).rejects.toThrow(ERR_COLLECTION_NAME_COLLISION);
    await expect(run).rejects.toThrow(/"Invoice" and "Invoices"/);
  });
});
