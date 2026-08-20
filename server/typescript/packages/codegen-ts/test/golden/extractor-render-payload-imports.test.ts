// extractor / render-helper PAYLOAD-IMPORT compile gate.
//
// The bug this gate locks in: the standalone `extractor()` + `renderHelper()`
// generators used to emit `import type { <PayloadVO(s)> } from "./payloads.js"`,
// but NO TS generator emits `payloads.ts`. So in a real `meta gen` run the
// emitted `*.extractor.ts` / `*.render.ts` failed to compile with TS2307
// (module not found). The payload VO interface (and its enum union aliases)
// actually live in the VO's OWN entity module — `entityFile()` emits
// `<VOName>.ts` exporting `export interface <VOName>` + `export type
// <Owner><Field> = ...`. The fix imports the payload types from THERE.
//
// This gate mirrors the sibling CRUD compile gate (api-docs-relative-imports):
// run the REAL generators (entityFile for the VOs + outputParser + extractor +
// renderHelper) into a temp dir and `tsc`-compile the emitted extractor/render
// files AGAINST the REAL generated entity modules — NO hand-written payloads.ts.
// The payload import must RESOLVE (no TS2307) and the payload type must be found.

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import ts from "typescript";
import { MetaDataLoader, InMemoryStringSource, type MetaObject } from "@metaobjectsdev/metadata";
import { entityFile } from "../../src/generators/index.js";
import { renderExtractor } from "../../src/templates/extractor.js";
import { renderRenderHelper } from "../../src/templates/render-helper.js";
import { renderOutputParser } from "../../src/templates/output-parser.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import type { GenContext, EmittedFile } from "../../src/generator.js";
import type { Provider } from "@metaobjectsdev/render";

// A nested payload graph that exercises the multi-VO import grouping:
//   Order (root) -> Customer (single nested), Line (array-of-objects),
//   plus an inline enum `priority` (union alias OWNED BY Order's module).
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
        { "field.string": { name: "summary", "@required": true } },
        // OPTIONAL fields exercise the mapper's `?? undefined` reconciliation against the
        // entity-module interface's `f?: T` (= `T | undefined`) optional shape — a `?? null`
        // would be a TS2322 against that interface.
        { "field.string": { name: "note" } },
        { "field.object": { name: "shipTo", "@objectRef": "Customer" } },
        { "field.enum": { name: "priority", "@required": true, "@values": ["LOW", "HIGH"] } },
      ],
    },
  },
  {
    // ADR-0052: the inbound tier is driven by a responding prompt. @payloadRef
    // and @responseRef name the same shape here because this fixture exercises
    // the extractor's payload IMPORTS, not the request/response distinction.
    "template.prompt": {
      name: "OrderOut",
      "@payloadRef": "Order",
      "@responseRef": "Order",
      "@textRef": "out/order",
    },
  },
  {
    // ADR-0052: the render helper is the OUTBOUND tier and stays on
    // `template.output` — it is the control proving the inbound move did not drag
    // the outbound tier with it. So the render half of this gate needs its own
    // output node; asking renderRenderHelper() for the prompt above throws.
    "template.output": {
      name: "OrderDoc",
      "@payloadRef": "Order",
      "@textRef": "out/order",
    },
  },
];

async function loadRoot(children: unknown[]) {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: "acme::ai", children } })),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}

async function runEntityFiles(
  root: Awaited<ReturnType<typeof loadRoot>>,
): Promise<EmittedFile[]> {
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
    matches: (_e: MetaObject) => true,
    projectRoot: "/tmp",
    config: {
      outDir: "/tmp",
      extStyle: "none",
      dbImport: "~/db",
      dialect: "sqlite",
    } as never,
    renderContext,
    warn: () => {},
  };
  return entityFile().generate(ctx);
}

// A codegen-time provider for the render-helper drift gate — resolves the one
// referenced mustache against the payload field tree (no drift).
const PROVIDER: Provider = {
  resolve(ref: string): string | undefined {
    return ref === "out/order" ? "Order {{summary}} for {{customer.name}}" : undefined;
  },
};

// Ambient stubs for the external packages the generated entity / extractor /
// render code import. The gate proves the PAYLOAD import resolves against the
// REAL generated VO modules — NOT to re-type-check drizzle/zod/render.
const ENGINE_STUBS = `declare module "drizzle-orm" {
  export type InferInsertModel<T> = any;
  export type InferSelectModel<T> = any;
  export const eq: any;
}
declare module "drizzle-orm/sqlite-core" {
  export const integer: any;
  export const sqliteTable: any;
  export const text: any;
  export type BaseSQLiteDatabase<A = any, B = any> = any;
}
declare module "zod" {
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
declare module "@metaobjectsdev/runtime-ts/drizzle-fastify" {
  export type FilterAllowlist = any;
  export type SortAllowlist = any;
}
declare module "@metaobjectsdev/runtime-ts" {
  export function extractObject(...args: any[]): any;
}
declare module "@metaobjectsdev/render" {
  export interface ExtractionResult<T> { data: T | null; report: any; }
  export interface EmailDocument { subject: string; htmlBody: string; textBody?: string; }
  export type Provider = any;
  export const render: any;
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

const TEMP_DIRS: string[] = [];
afterAll(() => {
  for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true });
});

describe("extractor/render payload import resolves against the REAL generated VO modules (no ./payloads.js)", () => {
  test("the emitted *.extractor.ts / *.render.ts compile (no TS2307 on the payload import)", async () => {
    const root = await loadRoot(MODEL);

    // 1. REAL entity (value-object) modules — Customer.ts / Line.ts / Order.ts.
    const entityFiles = await runEntityFiles(root);

    // 2. The standalone extractor + render-helper sources for the template.output,
    //    plus the REAL sibling output-parser the extractor imports from.
    const parserSrc = renderOutputParser(root, "OrderOut");
    const extractorSrc = renderExtractor(root, "OrderOut");
    const renderSrc = renderRenderHelper(root, "OrderDoc", PROVIDER);

    // The dangling `./payloads.js` import must be GONE — the payload types come
    // from the VO's own module instead.
    expect(extractorSrc).not.toContain('from "./payloads.js"');
    expect(renderSrc).not.toContain('from "./payloads.js"');
    // The render-helper imports the payload VO interface from its OWN module.
    expect(renderSrc).toContain('import type { Order } from "./Order.js";');
    // The extractor imports each VO interface from ITS module; the enum alias
    // rides along on the OWNER VO's module (Order).
    expect(extractorSrc).toContain('from "./Order.js"');
    expect(extractorSrc).toContain('from "./Customer.js"');
    expect(extractorSrc).toContain('from "./Line.js"');

    // 3. Lay the real generated VO modules + the extractor/render files into a
    //    temp dir exactly as `meta gen` would (flat, co-located).
    const dir = mkdtempSync(join(tmpdir(), "extractor-render-payload-"));
    TEMP_DIRS.push(dir);
    const write = (rel: string, body: string) => {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, body);
    };
    for (const f of entityFiles) write(f.path, f.content);
    write("OrderOut.response.ts", parserSrc);
    write("OrderOut.extractor.ts", extractorSrc);
    write("OrderOut.render.ts", renderSrc);
    write("engine-stubs.d.ts", ENGINE_STUBS);

    // 4. tsc — the payload import must RESOLVE (no TS2307) and the type be found.
    const fileList = [
      ...entityFiles.map((f) => f.path),
      "OrderOut.response.ts",
      "OrderOut.extractor.ts",
      "OrderOut.render.ts",
      "engine-stubs.d.ts",
    ];
    const diags = compile(dir, fileList);
    const ts2307 = diags
      .filter((d) => d.code === 2307)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    expect(
      ts2307,
      `module-not-found (TS2307) on the payload import:\n${ts2307.join("\n")}`,
    ).toEqual([]);

    // No "Cannot find name 'Order' / 'OrderPriority'" (TS2304) either — the type resolved.
    const ts2304 = diags
      .filter((d) => d.code === 2304)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    expect(ts2304, `unresolved type names (TS2304):\n${ts2304.join("\n")}`).toEqual([]);
  });
});
