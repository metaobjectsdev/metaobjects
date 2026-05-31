// <Name>Extractor codegen proof (compile-AND-run).
//
// The extract tier sits over the existing tolerant extract<Name>: run extract, throw if a
// @required field was lost, else map the all-nullable <Name>Extracted mirror onto the STRICT
// <Name>Payload via a generated recursive mirror->strict mapper (recurses nested objects +
// arrays-of-objects). extract<Name> is re-exposed unchanged. extract<Name> returns the STRICT
// payload type, NOT the mirror.
//
// Mirrors fr010-output-codegen.test.ts's harness: build a MetaRoot via InMemoryStringSource,
// render the payload + output + extractor sources to a temp dir, dynamically import() the
// emitted extractor module under bun, and CALL the generated functions.

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { renderOutputParser } from "../src/templates/output-parser.js";
import { renderExtractor } from "../src/templates/extractor.js";
import { generatePayloadInterfaces } from "../src/payload-codegen.js";

const TEMP_DIRS: string[] = [];
afterAll(() => {
  for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true });
});

async function loadRoot(children: unknown[]) {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: "acme::ai", children } })),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}

// Order: REQUIRED single nested object `customer` (-> Customer{name:string}),
// REQUIRED array-of-objects `lines` (-> Line{sku:string, qty:int}), OPTIONAL scalar `note:string`,
// REQUIRED scalar-array `tags:string[]`, OPTIONAL scalar-array `flags:string[]`,
// OPTIONAL single nested object `shipTo` (-> Customer) to hit the null-guard branch.
const MODEL = [
  {
    "object.value": {
      name: "Customer",
      children: [{ "field.string": { name: "name", "@required": true } }],
    },
  },
  {
    "object.value": {
      name: "Line",
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
        { "field.object": { name: "customer", "@required": true, "@objectRef": "Customer" } },
        { "field.object": { name: "lines", isArray: true, "@required": true, "@objectRef": "Line" } },
        { "field.string": { name: "note" } },
        { "field.string": { name: "tags", isArray: true, "@required": true } },
        { "field.string": { name: "flags", isArray: true } },
        { "field.object": { name: "shipTo", "@objectRef": "Customer" } },
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
];

describe("Extractor codegen — source shape", () => {
  test("renderExtractor emits extract<Name> returning the strict payload + re-exports extract", async () => {
    const root = await loadRoot(MODEL);
    const src = renderExtractor(root, "OrderOut");

    expect(src).toContain("export function extractOrderOut(");
    // returns the STRICT payload type (the payload VO's interface name, not the mirror)
    expect(src).toContain("): Order {");
    expect(src).toContain("hasLostRequired()");
    // extract is re-exposed (nested-capable, loader-driven path — see Java ExtractorCodeGenerator)
    expect(src).toContain("export function extractLenientOrderOut(");
    // recursive mirror->strict mappers for nested types
    expect(src).toContain("toStrictCustomer");
    expect(src).toContain("toStrictLine");
    // array-of-objects mapped element-wise
    expect(src).toContain(".map(");
    // C1: scalar arrays are null-filtered (so `(string|null)[]` narrows to the strict `string[]`),
    // NOT a bare `m.tags!` / `m.flags!` (which would be a tsc --strict TS2322 error).
    expect(src).toContain("(m.tags ?? []).filter((x): x is NonNullable<typeof x> => x != null)");
    expect(src).toContain(
      "m.flags == null ? null : m.flags.filter((x): x is NonNullable<typeof x> => x != null)",
    );
    expect(src).not.toContain("m.tags!");
    expect(src).not.toContain("m.flags!");
    // optional single nested object → null-guarded recurse into its mapper
    expect(src).toContain("m.shipTo ? toStrictCustomer(m.shipTo) : null");
  });
});

describe("Extractor codegen — import-and-RUN proof (bun dynamic import)", () => {
  test("extractOrder() extracts dirty JSON into the strict payload; missing-required throws; extract re-exposed", async () => {
    const root = await loadRoot(MODEL);
    const payloadSrc = generatePayloadInterfaces(root, "Order");
    const parserSrc = renderOutputParser(root, "OrderOut");
    const extractorSrc = renderExtractor(root, "OrderOut");

    const dir = mkdtempSync(join(import.meta.dir, "extractor-emit-"));
    TEMP_DIRS.push(dir);
    writeFileSync(join(dir, "payloads.ts"), payloadSrc);
    writeFileSync(join(dir, "OrderOut.output.ts"), parserSrc);
    writeFileSync(join(dir, "OrderOut.extractor.ts"), extractorSrc);

    const ex = await import(join(dir, "OrderOut.extractor.ts"));

    // dirty input: preamble + trailing comma — extract repairs it, extract maps to strict payload.
    // Includes a REQUIRED scalar array `tags` and an OPTIONAL scalar array `flags`.
    const dirty = [
      "Here you go:",
      "```json",
      '{ "customer": { "name": "Ada" }, "lines": [ { "sku": "A", "qty": 2 }, { "sku": "B", "qty": 1 }, ], "note": "rush", "tags": ["urgent", "vip"], "flags": ["fragile"] }',
      "```",
    ].join("\n");

    // extract takes the loaded MetaRoot (nested-capable extract path — matches the Java port's
    // loader-driven ExtractorCodeGenerator). The all-nullable mirror is mapped onto the strict payload.
    const order = ex.extractOrderOut(root, dirty);
    expect(order.customer.name).toBe("Ada");
    expect(order.lines.length).toBe(2);
    expect(order.lines[0].sku).toBe("A");
    expect(order.lines[1].qty).toBe(1);
    // C1 (compile-and-run): the required scalar array is a populated string[] with no null elements.
    expect(order.tags).toEqual(["urgent", "vip"]);
    expect(order.tags.every((t: unknown) => typeof t === "string")).toBe(true);
    // optional scalar array present → null-filtered string[]
    expect(order.flags).toEqual(["fragile"]);

    // missing required `customer` → throws
    expect(() => ex.extractOrderOut(root, '{ "lines": [] }')).toThrow();

    // extract re-exposed (nested-capable): clean JSON → no lost-required
    const clean =
      '{ "customer": { "name": "Ada" }, "lines": [ { "sku": "A", "qty": 2 } ], "tags": ["x"] }';
    const r = ex.extractLenientOrderOut(root, clean);
    expect(r.report.hasLostRequired()).toBe(false);
  });
});
