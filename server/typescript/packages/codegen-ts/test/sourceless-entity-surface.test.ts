// A SOURCELESS entity — `object.entity` with an `identity.primary` and no `source.*` — is a
// record whose store MetaObjects does not manage: a MongoDB collection, a Cassandra table, a
// Neo4j node, a remote API. MetaObjects generates no table, queries or routes for it (#248),
// and migrates nothing. The adopter writes (or generates, with their own generator) the data
// access.
//
// What that adopter still needs from the entity module is the WIRE CONTRACT, which does not
// depend on where the record is stored: the create and PATCH schemas and their input types,
// and the filter/sort allowlists their own list endpoint validates a query against. Before
// this, the entity module treated such an entity like a value object and emitted only the
// interface and `<E>InsertSchema`, so a PATCH endpoint or a filtered list had nothing to
// validate with.
//
// Value objects are unchanged: ADR-0028 forbids them an identity, and a value has no PATCH
// semantics. That is also why the rule keys on the identity and not on the object subtype
// (#248): the identity is what makes a record addressable, and so patchable.
//
// The test compiles the output, plus a small hand-written repository that uses it the way a
// document-store adopter would, with the real TypeScript compiler.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { entityFile } from "../src/generators/entity-file.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import { isSourcelessEntity } from "../src/index.js";
import type { GenContext } from "../src/generator.js";

const MODEL = {
  "metadata.root": {
    package: "shop",
    children: [
      {
        "object.value": {
          name: "LineItem",
          children: [
            { "field.string": { name: "sku", "@required": true } },
            { "field.int": { name: "qty", "@required": true } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Order",
          children: [
            { "field.string": { name: "id" } },
            { "field.string": { name: "customerEmail", "@required": true, "@filterable": true } },
            { "field.enum": { name: "status", "@required": true, "@values": ["NEW", "SHIPPED"], "@filterable": true } },
            { "field.timestamp": { name: "placedAt", "@required": true, "@sortable": true } },
            { "field.object": { name: "items", "@objectRef": "LineItem", isArray: true } },
            { "identity.primary": { name: "id", "@fields": "id" } },
          ],
        },
      },
    ],
  },
};

async function loadRoot() {
  const result = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(MODEL))]);
  if (result.errors.length > 0) {
    throw new Error(`Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`);
  }
  return result.root;
}

async function generate(dir: string): Promise<Map<string, string>> {
  const root = await loadRoot();
  const renderContext = makeRenderContext({
    dialect: "postgres",
    loadedRoot: root,
    outDir: dir,
    dbImport: "~/db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
  const ctx: GenContext = {
    entities: root.objects(),
    loadedRoot: root,
    matches: () => true,
    projectRoot: dir,
    config: { outDir: dir, extStyle: "none", dbImport: "~/db", dialect: "postgres" } as never,
    renderContext,
    warn: () => {},
  };
  const files = await entityFile().generate(ctx);
  return new Map(files.map((f) => [f.path, f.content]));
}

// The shape an adopter's document-store repository takes: validate the body with the
// generated schemas, check a list query against the generated allowlists. No database types.
const REPOSITORY = `
import {
  OrderInsertSchema, OrderUpdateSchema, OrderFilterAllowlist, OrderSortAllowlist,
  type Order, type OrderCreate, type OrderPatch, type OrderFilter,
} from "./Order";

const store = new Map<string, Order>();

export function createOrder(input: OrderCreate): Order {
  const row: Order = OrderInsertSchema.parse(input);
  store.set(row.id as string, row);
  return row;
}

export function patchOrder(id: string, patch: OrderPatch): Order | undefined {
  const current = store.get(id);
  if (current === undefined) return undefined;
  const changes = OrderUpdateSchema.parse(patch);
  const next: Order = { ...current };
  if (changes.customerEmail !== undefined) next.customerEmail = changes.customerEmail;
  if (changes.status !== undefined) next.status = changes.status;
  store.set(id, next);
  return next;
}

export function allowedFilter(field: string): boolean {
  return field in OrderFilterAllowlist;
}

export function allowedSort(field: string): boolean {
  return field in OrderSortAllowlist;
}

export const byStatus: OrderFilter = { status: { eq: "NEW" } };
`;

function compile(dir: string, files: string[]): string[] {
  const program = ts.createProgram(
    files.map((f) => join(dir, f)),
    {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
    },
  );
  return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("sourceless entity (identity, no source): the wire contract without a table", () => {
  test("isSourcelessEntity: an identified, sourceless entity yes; a value object no", async () => {
    const root = await loadRoot();
    const byName = new Map(root.objects().map((o) => [o.name, o]));
    expect(isSourcelessEntity(byName.get("Order")!)).toBe(true);
    expect(isSourcelessEntity(byName.get("LineItem")!)).toBe(false);
  });

  test("Order.ts carries create + PATCH schemas and the allowlists, and no table", async () => {
    const dir = mkdtempSync(join(import.meta.dir, "tmp-sourceless-"));
    try {
      const order = (await generate(dir)).get("Order.ts")!;
      expect(order).toContain("export interface Order");
      expect(order).toContain("export const OrderInsertSchema");
      expect(order).toContain("export const OrderUpdateSchema");
      expect(order).toContain("export type OrderCreate");
      expect(order).toContain("export type OrderPatch");
      expect(order).toContain("export const OrderFilterAllowlist");
      expect(order).toContain("export const OrderSortAllowlist");
      expect(order).toContain("export type OrderFilter");
      // Nothing that names a store MetaObjects does not manage.
      expect(order).not.toContain("drizzle-orm");
      expect(order).not.toContain("pgTable(");
      expect(order).not.toContain("$table");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a value object stays value-only", async () => {
    const dir = mkdtempSync(join(import.meta.dir, "tmp-sourceless-"));
    try {
      const item = (await generate(dir)).get("LineItem.ts")!;
      expect(item).toContain("export const LineItemInsertSchema");
      expect(item).not.toContain("UpdateSchema");
      expect(item).not.toContain("FilterAllowlist");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the generated module and a hand-written repository over it compile", async () => {
    const dir = mkdtempSync(join(import.meta.dir, "tmp-sourceless-"));
    try {
      const files = await generate(dir);
      for (const [path, content] of files) writeFileSync(join(dir, path), content);
      writeFileSync(join(dir, "order-repository.ts"), REPOSITORY);
      expect(compile(dir, [...files.keys(), "order-repository.ts"])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
