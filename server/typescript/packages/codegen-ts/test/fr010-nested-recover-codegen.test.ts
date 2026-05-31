// FR-010 Plan 2.1 — nested-recover codegen import-and-RUN proof (the TS analogue of the
// Java GeneratedNestedRecoverCompileRunTest). Generates the output parser for a payload with a
// NESTED object + an ARRAY-OF-objects, writes the emitted .ts, dynamically import()s it under bun,
// then calls the runtime-DELEGATING recover<Name>WithLoader(root, dirtyJson) and asserts the
// nested object + array-of-objects populate into the typed nullable mirror (NOT null) — the gap
// the self-contained recover<Name>(text) leaves open.

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { renderOutputParser } from "../src/templates/output-parser.js";

const TEMP_DIRS: string[] = [];
afterAll(() => {
  for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true });
});

const PKG = "acme::ai";

// An order payload with a single nested object (Customer) AND an array-of-objects (LineItem[]),
// plus a scalar + enum at the root — exercises both nested shapes the self-contained path stubs.
const NESTED_MODEL = {
  "metadata.root": {
    package: PKG,
    children: [
      {
        "object.value": {
          name: "Customer",
          children: [
            { "field.string": { name: "name", "@required": true } },
            { "field.string": { name: "email" } },
          ],
        },
      },
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
        "object.value": {
          name: "Order",
          children: [
            { "field.string": { name: "orderId", "@required": true } },
            {
              "field.enum": {
                name: "status",
                "@required": true,
                "@values": ["OPEN", "CLOSED"],
              },
            },
            { "field.object": { name: "customer", "@objectRef": `${PKG}::Customer` } },
            { "field.object": { name: "items", isArray: true, "@objectRef": `${PKG}::LineItem` } },
          ],
        },
      },
      {
        "template.output": {
          name: "OrderOut",
          "@payloadRef": "Order",
          "@textRef": "out/order",
          "@format": "json",
        },
      },
    ],
  },
};

async function loadRoot(): Promise<MetaRoot> {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(NESTED_MODEL)),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}

describe("FR-010 nested recover codegen — source shape", () => {
  test("emits a typed nested mirror, nested mappers, and the runtime-delegating overload", async () => {
    const root = await loadRoot();
    const src = renderOutputParser(root, "OrderOut");

    // delegating wiring
    expect(src).toContain('import { recoverObject } from "@metaobjectsdev/runtime-ts";');
    expect(src).toContain('import type { MetaRoot } from "@metaobjectsdev/metadata";');
    expect(src).toContain('export const ORDEROUT_PAYLOAD_NAME = "Order";');
    expect(src).toContain("export function recoverOrderOutWithLoader(");
    expect(src).toContain("recoverObject(mo, text, Format.JSON, opts)");

    // self-contained path still present (back-compat)
    expect(src).toContain("export function recoverOrderOut(");
    expect(src).toContain("export function tryRecoverOrderOut(");

    // nested-aware mirror types (NOT `unknown`)
    expect(src).toContain("export interface OrderOutRecovered {");
    expect(src).toContain("customer: CustomerRecovered | null;");
    expect(src).toContain("items: (LineItemRecovered | null)[] | null;");
    expect(src).toContain("export interface CustomerRecovered {");
    expect(src).toContain("export interface LineItemRecovered {");

    // nested mappers — root mapper is template-named (`from<Template>Recovered`); nested use VO names
    expect(src).toContain("function fromOrderOutRecovered(");
    expect(src).toContain("function fromCustomerRecovered(");
    expect(src).toContain("function fromLineItemRecovered(");
    expect(src).toContain("mapObjectList(readProp(o,");
  });
});

describe("FR-010 nested recover codegen — import-and-RUN proof (delegating path populates nested)", () => {
  test("recoverOrderOutWithLoader(root, dirtyJson) populates the nested object + array-of-objects", async () => {
    const root = await loadRoot();
    const parserSrc = renderOutputParser(root, "OrderOut");

    const dir = mkdtempSync(join(import.meta.dir, "fr010-nested-"));
    TEMP_DIRS.push(dir);
    writeFileSync(join(dir, "OrderOut.output.ts"), parserSrc);

    const parser = await import(join(dir, "OrderOut.output.ts"));

    // Dirty input: chat preamble + ```json fence; nested customer + array-of items present.
    const dirty = [
      "Here is the order:",
      "```json",
      JSON.stringify({
        orderId: "A-100",
        status: "open", // off-canonical case → still recovers the scalar surface
        customer: { name: "Ada Lovelace", email: "ada@example.com" },
        items: [
          { sku: "SKU-1", qty: 2 },
          { sku: "SKU-2", qty: 5 },
        ],
      }),
      "```",
      "Thanks!",
    ].join("\n");

    // ---- self-contained path leaves nested-object / array-of-object components NULL ----
    // (the historical FR-010 gap: the baked-schema path treats them as opaque leaves and the
    // generated mirror initializer emits null for object fields). The delegating path below
    // is what populates them.
    const selfContained = parser.recoverOrderOut(dirty);
    expect(selfContained.data.customer).toBeNull();
    expect(selfContained.data.items).toBeNull();

    // ---- runtime-delegating path POPULATES nested + array-of-objects ----
    const { data, report } = parser.recoverOrderOutWithLoader(root, dirty);
    expect(data).not.toBeNull();

    // root scalars
    expect(data.orderId).toBe("A-100");

    // nested object recovered into the typed CustomerRecovered mirror
    expect(data.customer).not.toBeNull();
    expect(data.customer.name).toBe("Ada Lovelace");
    expect(data.customer.email).toBe("ada@example.com");

    // array-of-objects recovered into LineItemRecovered[]
    expect(Array.isArray(data.items)).toBe(true);
    expect(data.items.length).toBe(2);
    expect(data.items[0].sku).toBe("SKU-1");
    expect(data.items[0].qty).toBe(2);
    expect(data.items[1].sku).toBe("SKU-2");
    expect(data.items[1].qty).toBe(5);

    // never threw; report present
    expect(report).toBeDefined();
    expect(typeof report.isEmpty).toBe("function");
  });
});
