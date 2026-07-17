// #214 — the FR-024 §7 entity read-view READ half (codegen).
//
// A write-through entity (writable `table` source + a read-only `view` source +
// derived origin.* fields) must: expose the replica view declaration, type its READ
// row (<Entity>) from the VIEW (carrying the derived field), route reads to the view
// and writes to the table, and re-read a create/update through the view. This unit
// asserts the structure AND compiles the real generated output with tsc — the read
// type + query code must type-check (`typeof view.$inferSelect`, the re-read, etc.).

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { MetaDataLoader, InMemoryStringSource, type MetaObject } from "@metaobjectsdev/metadata";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import { renderEntityFile } from "../../src/templates/entity-file.js";
import { renderQueriesFile } from "../../src/templates/queries-file.js";
import { entityFile as refEntityFile } from "../../src/reference/entity.js";
import { queriesFile as refQueriesFile } from "../../src/reference/queries.js";
import type { GenContext } from "../../src/generator.js";
import type { Dialect } from "../../src/metaobjects-config.js";

// Customer + a write-through Order (replica view v_order_with_customer, derived
// customerName from Customer.name via the customer join).
const META = JSON.stringify({
  "metadata.root": {
    package: "acme",
    children: [
      { "object.entity": { name: "Customer", children: [
        { "source.rdb": { "@table": "customers" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "name" } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ] } },
      { "object.entity": { name: "Order", children: [
        { "source.rdb": { "@role": "primary", "@table": "orders" } },
        { "source.rdb": { "@role": "replica", "@kind": "view", "@table": "v_order_with_customer" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "customerId", "@required": true } },
        { "field.string": { name: "customerName", children: [
          { "origin.passthrough": { "@from": "Customer.name", "@via": "Order.customer" } } ] } },
        { "relationship.association": { name: "customer", "@objectRef": "Customer", "@cardinality": "one" } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
        { "identity.reference": { name: "ref_customer", "@fields": "customerId", "@references": "Customer" } },
      ] } },
    ],
  },
});

async function load() {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(META)]);
  expect(errors).toEqual([]);
  return root;
}

function gen(root: Awaited<ReturnType<typeof load>>, dialect: Dialect, outDir: string) {
  const ctx = makeRenderContext({
    dialect, loadedRoot: root, outDir, dbImport: "~/db",
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
  });
  const order = root.findObject("Order")!;
  const customer = root.findObject("Customer")!;
  return {
    order,
    entityFiles: {
      "Order.ts": renderEntityFile(order, ctx),
      "Customer.ts": renderEntityFile(customer, ctx),
    },
    queries: renderQueriesFile(order, ctx),
  };
}

describe("#214 — write-through entity read-view codegen structure", () => {
  test("entity file: table excludes the derived field, the .existing() view includes it, read type is the view", async () => {
    const { entityFiles } = gen(await load(), "postgres", "/tmp/x");
    const ef = entityFiles["Order.ts"];
    // write table — stored fields only, NO derived customerName column (check the
    // pgTable block specifically; customerName legitimately appears later in the view).
    expect(ef).toMatch(/export const orders = pgTable\("orders"/);
    const tableBlock = ef.match(/pgTable\("orders", \{[\s\S]*?\}\);/)![0];
    expect(tableBlock).not.toContain("customerName");
    // replica view declaration — carries the derived customerName
    expect(ef).toMatch(/export const orderView = pgView\("v_order_with_customer"/);
    expect(ef).toMatch(/orderView = pgView[\s\S]*customerName: text\("customer_name"\)/);
    // read SCHEMA (dialect-agnostic z.infer) carries the derived field
    expect(ef).toMatch(/export const OrderSchema = z\.object\([\s\S]*customerName/);
    // read type from the VIEW schema (carries derived); write types from the table
    expect(ef).toContain("export type Order = z.infer<typeof OrderSchema>;");
    expect(ef).toContain("export type OrderInsert = InferInsertModel<typeof orders>;");
  });

  test("queries file: reads route to the view, writes to the table, create/update re-read through the view", async () => {
    const { queries } = gen(await load(), "postgres", "/tmp/x");
    // reads from the view
    expect(queries).toMatch(/findOrderById[\s\S]*from\(orderView\)/);
    expect(queries).toMatch(/listOrders[\s\S]*from\(orderView\)/);
    // create writes the table, then re-reads the row through the view
    expect(queries).toMatch(/createOrder[\s\S]*insert\(orders\)[\s\S]*from\(orderView\)/);
    // update writes the table, then re-reads through the view
    expect(queries).toMatch(/updateOrder[\s\S]*update\(orders\)[\s\S]*from\(orderView\)/);
    // delete targets the table
    expect(queries).toMatch(/deleteOrderById[\s\S]*delete\(orders\)/);
  });
});

// Real tsc gate: the generated read-half output must type-check with
// verbatimModuleSyntax on — proving `typeof orderView.$inferSelect` (a Drizzle view,
// NOT a Table) is a valid row type and the re-read query code composes.
function compile(dir: string, files: string[]): readonly ts.Diagnostic[] {
  const program = ts.createProgram(
    files.map((f) => join(dir, f)),
    {
      strict: true, noEmit: true, verbatimModuleSyntax: true,
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true,
    },
  );
  return ts.getPreEmitDiagnostics(program);
}

// Finding #3 — the scaffold-and-own REFERENCE generators (the ADR-0034 `meta init`
// default path) must delegate a write-through entity to the engine composer, else the
// feature silently no-ops (vanilla table reads, no derived field) for most consumers.
describe("#214 — the reference (meta init) generators handle write-through", () => {
  async function refCtx() {
    const root = await load();
    const renderContext = makeRenderContext({
      dialect: "postgres", loadedRoot: root, outDir: "/tmp/x", dbImport: "~/db",
      pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
    });
    const ctx: GenContext = {
      entities: root.objects(), loadedRoot: root, matches: (e) => e.name === "Order",
      projectRoot: "/tmp/x",
      config: { outDir: "/tmp/x", extStyle: "none", dbImport: "~/db", dialect: "postgres" } as never,
      renderContext, warn: () => {},
    };
    return ctx;
  }

  test("reference entityFile() emits the replica view decl + view-schema read type for a write-through entity", async () => {
    const files = await refEntityFile({ allowlists: false }).generate(await refCtx());
    const order = files.find((f) => f.path.endsWith("Order.ts"))!;
    expect(order.content).toContain("orderView = pgView(");
    expect(order.content).toContain("export type Order = z.infer<typeof OrderSchema>");
  });

  test("reference queriesFile() routes reads to the view for a write-through entity", async () => {
    const files = await refQueriesFile().generate(await refCtx());
    const q = files.find((f) => f.path.endsWith("Order.queries.ts"))!;
    expect(q.content).toMatch(/findOrderById[\s\S]*from\(orderView\)/);
    expect(q.content).toMatch(/createOrder[\s\S]*insert\(orders\)[\s\S]*from\(orderView\)/);
  });
});

describe("#214 — the generated read-half output type-checks (verbatimModuleSyntax)", () => {
  for (const dialect of ["postgres", "sqlite"] as const) {
    test(`${dialect}: entity files + write-through queries file compile with zero diagnostics`, async () => {
      const root = await load();
      const dir = mkdtempSync(join(import.meta.dir, `tmp-214-${dialect}-`));
      try {
        const { entityFiles, queries } = gen(root, dialect, dir);
        for (const [name, content] of Object.entries(entityFiles)) writeFileSync(join(dir, name), content);
        writeFileSync(join(dir, "Order.queries.ts"), queries);
        const diagnostics = compile(dir, ["Order.ts", "Customer.ts", "Order.queries.ts"]);
        const messages = diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
        expect(messages).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
