// FR-010 Plan 2.1 — nested-extract codegen import-and-RUN proof (the TS analogue of the
// Java GeneratedNestedExtractCompileRunTest). Generates the output parser for a payload with a
// NESTED object + an ARRAY-OF-objects, writes the emitted .ts, dynamically import()s it under bun,
// then calls the runtime-DELEGATING extract<Name>WithLoader(root, dirtyJson) and asserts the
// nested object + array-of-objects populate into the typed nullable mirror (NOT null) — the
// single metadata-driven extract path reads the live metadata and assembles the full graph.

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
// plus a scalar + enum at the root — exercises both nested shapes the delegating path populates.
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
        "template.prompt": {
          name: "OrderOut",
          "@payloadRef": "Order",
          "@responseRef": "Order",
          "@textRef": "out/order",
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

describe("FR-010 nested extract codegen — source shape", () => {
  test("emits a typed nested mirror, nested mappers, and the runtime-delegating overload", async () => {
    const root = await loadRoot();
    const src = renderOutputParser(root, "OrderOut");

    // delegating wiring
    expect(src).toContain('import { extractObject } from "@metaobjectsdev/runtime-ts";');
    expect(src).toContain('import type { MetaRoot } from "@metaobjectsdev/metadata";');
    expect(src).toContain('export const ORDEROUT_PAYLOAD_NAME = "Order";');
    expect(src).toContain("export function extractLenientOrderOutWithLoader(");
    expect(src).toContain("extractObject(mo, text, Format.JSON, opts)");

    // Move 1: the self-contained / baked path is gone — only the delegating overload remains.
    expect(src).not.toContain("export function extractLenientOrderOut(");
    expect(src).not.toContain("tryExtractLenientOrderOut");
    expect(src).not.toContain("ExtractSchema =");

    // nested-aware mirror types (NOT `unknown`)
    expect(src).toContain("export interface OrderOutExtracted {");
    expect(src).toContain("customer: CustomerExtracted | null;");
    expect(src).toContain("items: (LineItemExtracted | null)[] | null;");
    expect(src).toContain("export interface CustomerExtracted {");
    expect(src).toContain("export interface LineItemExtracted {");

    // nested mappers — root mapper is template-named (`from<Template>Extracted`); nested use VO names
    expect(src).toContain("function fromOrderOutExtracted(");
    expect(src).toContain("function fromCustomerExtracted(");
    expect(src).toContain("function fromLineItemExtracted(");
    expect(src).toContain("mapObjectList(readProp(o,");
  });
});

describe("FR-010 nested extract codegen — import-and-RUN proof (delegating path populates nested)", () => {
  test("extractLenientOrderOutWithLoader(root, dirtyJson) populates the nested object + array-of-objects", async () => {
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
        status: "open", // off-canonical case → still extracts the scalar surface
        customer: { name: "Ada Lovelace", email: "ada@example.com" },
        items: [
          { sku: "SKU-1", qty: 2 },
          { sku: "SKU-2", qty: 5 },
        ],
      }),
      "```",
      "Thanks!",
    ].join("\n");

    // ---- runtime-delegating path POPULATES nested + array-of-objects ----
    // (the single metadata-driven extract path reads live metadata + assembles the full graph;
    // the historical FR-010 gap — nested/array components left null — no longer exists.)
    const { data, report } = parser.extractLenientOrderOutWithLoader(root, dirty);
    expect(data).not.toBeNull();

    // root scalars
    expect(data.orderId).toBe("A-100");

    // nested object extracted into the typed CustomerExtracted mirror
    expect(data.customer).not.toBeNull();
    expect(data.customer.name).toBe("Ada Lovelace");
    expect(data.customer.email).toBe("ada@example.com");

    // array-of-objects extracted into LineItemExtracted[]
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
