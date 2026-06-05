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
import ts from "typescript";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { renderOutputParser } from "../src/templates/output-parser.js";
import { renderExtractor } from "../src/templates/extractor.js";
import { generatePayloadInterfaces } from "../src/payload-codegen.js";
import { entityFile } from "../src/generators/index.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import type { GenContext } from "../src/generator.js";

// Emit the REAL per-VO entity modules (`<VO>.ts` exporting `interface <VO>` +
// its enum union-aliases) the same way `meta gen` does, so the generated
// extractor's `from "./<VO>.js"` payload imports RESOLVE against the modules
// that actually exist (no hand-written `payloads.ts` that no generator emits).
async function writeEntityModules(
  dir: string,
  root: Awaited<ReturnType<typeof loadRoot>>,
): Promise<void> {
  const renderContext = makeRenderContext({
    dialect: "sqlite",
    loadedRoot: root,
    outDir: "/tmp",
    dbImport: "~/db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
  const ctx: GenContext = {
    entities: root.objects(),
    loadedRoot: root,
    matches: () => true,
    projectRoot: "/tmp",
    config: { outDir: "/tmp", extStyle: "none", dbImport: "~/db", dialect: "sqlite" } as never,
    renderContext,
    warn: () => {},
  };
  for (const f of await entityFile().generate(ctx)) {
    writeFileSync(join(dir, f.path), f.content);
  }
}

// ---------------------------------------------------------------------------
// tsc --strict compile gate (mirrors fr004-verify-demo.test.ts's `compile()`).
//
// Type-checks the EMITTED payload + output-parser + extractor sources with the
// real TS compiler API under `{ strict: true, noEmit: true }`. This is what
// proves the union-typed enum payload is genuinely value-constrained AND that
// the generated mapper compiles: a bare `m.priority!` (string) assigned into the
// `OrderPriority` union field is a TS2322 error — the gate fails unless the
// extractor CASTS the mirror string to the union alias. Ambient `.d.ts` stubs
// stand in for the engine packages so the program is hermetic (no workspace
// self-link noise); `skipLibCheck` keeps the check focused on the emitted graph.
// ---------------------------------------------------------------------------

function compile(dir: string, files: string[]): readonly ts.Diagnostic[] {
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
  return ts.getPreEmitDiagnostics(program);
}

// Just-enough ambient surface for the engine packages the emitted output imports.
// The point of the gate is the cross-module mirror→strict mapping (enum casts);
// these stubs keep the resolver happy without pulling the real (workspace-linked)
// type surface in.
// `z` is used as BOTH a value (z.object(...)) and a type namespace (z.infer<...>) in the
// emitted parser, so it is declared as an importable namespace whose every member is `any`.
// The render/runtime surfaces are intentionally permissive (`any`) — the engine itself is a
// real, separately-compiled package; the gate's job is the EMITTED extractor's enum casts +
// the mirror→strict payload mapping, NOT re-type-checking the engine.
const ENGINE_STUBS = `declare module "zod" {
  export namespace z {
    export type infer<T> = any;
    export type ZodType = any;
    export type ZodError = any;
  }
  export const z: any;
}
declare module "@metaobjectsdev/metadata" {
  export type MetaRoot = any;
}
declare module "@metaobjectsdev/runtime-ts" {
  export function extractObject(...args: any[]): any;
}
declare module "@metaobjectsdev/render" {
  // data is nullable in the real engine surface; the emitted extractor reads \`r.data!\`.
  export interface ExtractionResult<T> { data: T | null; report: any; }
  export const extract: any;
  export const extractSchema: any;
  export const Format: any;
  export const scalar: any;
  export const enumField: any;
  export const FieldKind: any;
  export type ExtractSchema = any;
  export type ExtractOptions = any;
  export function asString(...args: any[]): any;
  export function asStringList(...args: any[]): any;
}
`;

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
        // REQUIRED single enum `priority` (-> union "LOW" | "HIGH"),
        // REQUIRED enum ARRAY `labels` (-> union "A" | "B", as OrderLabels[]).
        { "field.enum": { name: "priority", "@required": true, "@values": ["LOW", "HIGH"] } },
        { "field.enum": { name: "labels", isArray: true, "@required": true, "@values": ["A", "B"] } },
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
      "m.flags == null ? undefined : m.flags.filter((x): x is NonNullable<typeof x> => x != null)",
    );
    expect(src).not.toContain("m.tags!");
    expect(src).not.toContain("m.flags!");
    // optional single nested object → undefined-guarded recurse into its mapper
    // (the strict entity-module interface types optionals `?: T` = `T | undefined`).
    expect(src).toContain("m.shipTo ? toStrictCustomer(m.shipTo) : undefined");
  });

  test("payload typing: field.enum is a value-constrained union alias (not unknown), single + array", async () => {
    const root = await loadRoot(MODEL);
    const payloadSrc = generatePayloadInterfaces(root, "Order");

    // Inline enum naming = <Entity><FieldPascal> (reused from renderEnumTypeAliases).
    expect(payloadSrc).toContain(`export type OrderPriority = "LOW" | "HIGH";`);
    expect(payloadSrc).toContain(`export type OrderLabels = "A" | "B";`);
    // Field typed as the union alias — NOT `unknown`, NOT bare `string`.
    expect(payloadSrc).toContain("priority: OrderPriority;");
    expect(payloadSrc).toContain("labels: OrderLabels[];");
    expect(payloadSrc).not.toContain("priority: unknown");
    expect(payloadSrc).not.toContain("labels: unknown");
  });

  test("shared abstract field.enum on the payload path → ONE union alias (super-named), both fields typed it", async () => {
    // Cross-port parity (mirrors the Python/C#/Kotlin/Java extractor shared-enum
    // dedup proof): an abstract `field.enum` `Priority` with two PAYLOAD fields
    // (`priority` REQUIRED + `escalation` OPTIONAL) that BOTH `extends` it and carry
    // no own values. The union alias must be named for the SUPER (`Priority`, not
    // `SharedOrderPriority`/`SharedOrderEscalation`) and emitted exactly ONCE; both
    // fields must be typed `Priority` (the effective `@values` resolve through `extends`).
    const sharedRoot = await loadRoot([
      // Abstract enum declared at root so `extends: "Priority"` resolves the super + its @values.
      { "field.enum": { name: "Priority", abstract: true, "@values": ["LOW", "HIGH"] } },
      {
        "object.value": {
          name: "SharedOrder",
          children: [
            // priority: REQUIRED, extends the abstract → inherits @values, no own values.
            { "field.enum": { name: "priority", "@required": true, extends: "Priority" } },
            // escalation: OPTIONAL, also extends the SAME abstract → must collapse to one alias.
            { "field.enum": { name: "escalation", extends: "Priority" } },
          ],
        },
      },
    ]);
    const payloadSrc = generatePayloadInterfaces(sharedRoot, "SharedOrder");

    // Exactly ONE union alias, named for the SUPER (`Priority`) — not per-field, not duplicated.
    expect(payloadSrc).toContain(`export type Priority = "LOW" | "HIGH";`);
    expect(payloadSrc.match(/export type Priority =/g)?.length).toBe(1);
    // The per-field/per-owner naming (`<Owner><FieldPascal>`) must NOT appear.
    expect(payloadSrc).not.toContain("SharedOrderPriority");
    expect(payloadSrc).not.toContain("SharedOrderEscalation");
    // BOTH fields typed as the shared `Priority` alias (REQUIRED bare; OPTIONAL `| null`).
    expect(payloadSrc).toContain("priority: Priority;");
    expect(payloadSrc).toContain("escalation?: Priority | null;");

    // tsc --strict gate: the shared alias + both field typings compile cleanly.
    const dir = mkdtempSync(join(import.meta.dir, "shared-enum-tsc-"));
    TEMP_DIRS.push(dir);
    writeFileSync(join(dir, "payloads.ts"), payloadSrc);
    writeFileSync(join(dir, "engine.d.ts"), ENGINE_STUBS);
    const diagnostics = compile(dir, ["payloads.ts", "engine.d.ts"]);
    expect(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
  });

  test("tsc --strict gate: emitted payload + parser + extractor type-check with ZERO diagnostics", async () => {
    const root = await loadRoot(MODEL);
    const parserSrc = renderOutputParser(root, "OrderOut");
    const extractorSrc = renderExtractor(root, "OrderOut");

    // Sanity: the extractor CASTS the enum mirror-string to the union alias (the fix under test).
    // Scalar enum → `m.priority! as OrderPriority`; enum array → `... as OrderLabels[]`.
    expect(extractorSrc).toContain("m.priority! as OrderPriority");
    expect(extractorSrc).toContain(") as OrderLabels[]");
    // The union aliases are imported from the payload module so the cast target resolves.
    expect(extractorSrc).toContain("OrderPriority, OrderLabels");

    const dir = mkdtempSync(join(import.meta.dir, "extractor-tsc-"));
    TEMP_DIRS.push(dir);
    // The REAL per-VO entity modules the extractor imports its payload types from.
    await writeEntityModules(dir, root);
    writeFileSync(join(dir, "OrderOut.output.ts"), parserSrc);
    writeFileSync(join(dir, "OrderOut.extractor.ts"), extractorSrc);
    writeFileSync(join(dir, "engine.d.ts"), ENGINE_STUBS);

    const diagnostics = compile(dir, [
      "Order.ts",
      "Customer.ts",
      "Line.ts",
      "OrderOut.output.ts",
      "OrderOut.extractor.ts",
      "engine.d.ts",
    ]);

    // ZERO diagnostics: the union-typed enum payload AND the strict mapper both compile.
    expect(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
  });
});

describe("Extractor codegen — import-and-RUN proof (bun dynamic import)", () => {
  test("extractOrder() extracts dirty JSON into the strict payload; missing-required throws; extract re-exposed", async () => {
    const root = await loadRoot(MODEL);
    const parserSrc = renderOutputParser(root, "OrderOut");
    const extractorSrc = renderExtractor(root, "OrderOut");

    const dir = mkdtempSync(join(import.meta.dir, "extractor-emit-"));
    TEMP_DIRS.push(dir);
    // The extractor's payload imports are `import type` (erased at runtime), so the
    // VO modules need not be loaded here; the run-proof exercises the emitted logic.
    writeFileSync(join(dir, "OrderOut.output.ts"), parserSrc);
    writeFileSync(join(dir, "OrderOut.extractor.ts"), extractorSrc);

    const ex = await import(join(dir, "OrderOut.extractor.ts"));

    // dirty input: preamble + trailing comma — extract repairs it, extract maps to strict payload.
    // Includes a REQUIRED scalar array `tags` and an OPTIONAL scalar array `flags`.
    const dirty = [
      "Here you go:",
      "```json",
      '{ "customer": { "name": "Ada" }, "lines": [ { "sku": "A", "qty": 2 }, { "sku": "B", "qty": 1 }, ], "note": "rush", "tags": ["urgent", "vip"], "flags": ["fragile"], "priority": "HIGH", "labels": ["A", "B"] }',
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
    // enum scalar: identity-mapped validated member, typed as the OrderPriority union.
    expect(order.priority).toBe("HIGH");
    // enum array: null-filtered, typed as OrderLabels[].
    expect(order.labels).toEqual(["A", "B"]);
    // optional single nested object `shipTo` ABSENT in this input → the `m.shipTo ? toStrictCustomer(...) : undefined`
    // branch produces undefined at runtime (matches the strict `shipTo?: Customer` entity-module
    // interface optionality — not a partial object).
    expect(order.shipTo).toBeUndefined();

    // optional single nested object PRESENT → the guard recurses into toStrictCustomer and populates.
    const withShipTo =
      '{ "customer": { "name": "Ada" }, "lines": [ { "sku": "A", "qty": 2 } ], "tags": ["x"], "priority": "LOW", "labels": ["A"], "shipTo": { "name": "Grace" } }';
    const shipped = ex.extractOrderOut(root, withShipTo);
    expect(shipped.shipTo).not.toBeUndefined();
    expect(shipped.shipTo.name).toBe("Grace");
    // and when shipTo is genuinely absent on a separate clean input, it is undefined (re-confirm the branch)
    const noShipTo = ex.extractOrderOut(
      root,
      '{ "customer": { "name": "Ada" }, "lines": [ { "sku": "A", "qty": 2 } ], "tags": ["x"], "priority": "LOW", "labels": ["A"] }',
    );
    expect(noShipTo.shipTo).toBeUndefined();

    // missing required `customer` → throws
    expect(() => ex.extractOrderOut(root, '{ "lines": [] }')).toThrow();

    // extract re-exposed (nested-capable): clean JSON → no lost-required
    const clean =
      '{ "customer": { "name": "Ada" }, "lines": [ { "sku": "A", "qty": 2 } ], "tags": ["x"], "priority": "LOW", "labels": ["A"] }';
    const r = ex.extractLenientOrderOut(root, clean);
    expect(r.report.hasLostRequired()).toBe(false);

    // The lenient `<Name>Extracted` mirror leaf is UNCHANGED — enum stays a plain string.
    // Assert it works on DIRTY input and returns priority as a raw string (not narrowed).
    const lenientDirty = ex.extractLenientOrderOut(root, dirty);
    expect(lenientDirty.report.hasLostRequired()).toBe(false);
    expect(lenientDirty.data.priority).toBe("HIGH");
    expect(typeof lenientDirty.data.priority).toBe("string");
  });
});
