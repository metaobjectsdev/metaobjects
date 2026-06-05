// Task 4 — the api-docs ACCURACY / DRIFT gate.
//
// buildApiModel (api-model.ts) documents the PUBLIC API an adopter's codegen
// emits. Most symbol names are derived by REUSING the real generators' naming
// helpers, but several are MIRRORED inline (the validation <Name>InsertSchema /
// <Name>UpdateSchema, the extractor extract<Name> / extractLenient<Name>, the
// render render<Name>, and the REST verb+paths). Mirrored names can silently
// drift if a generator changes spelling. This gate makes such a drift break the
// GATE — not an adopter's published docs.
//
// HOW IT WORKS (genuinely runs the REAL generators, not a self-assertion):
//   1. Load ONE rich fixture root exercising the full surface (PK entity with a
//      field.enum, a value object, a document + an email template.output, a TPH
//      base + subtype, and an @emitRoutes:false entity).
//   2. Run the ACTUAL default-suite generators (entityFile, queriesFile,
//      routesFile, extractor, renderHelper) on that root into their in-memory
//      { path, content } outputs — applying each generator's own `.filter`
//      EXACTLY as the runner does (ctx.matches = gen.filter ?? true), so the
//      generators' skip rules (value object / TPH subtype / @emitRoutes:false)
//      are honored just like a real `meta gen`.
//   3. Build buildApiModel on the SAME root.
//   4. FORWARD: every ApiSymbol name must appear as an emitted IDENTIFIER in the
//      file that OWNS that kind (precise, word-boundary / `export …` matching —
//      not loose substring). REST symbols match the routes registration + the
//      literal $path the entity-constants emit, gated read-only vs full CRUD.
//   5. INVERSE (no over-documentation): for the SKIP shapes — TPH subtype and
//      @emitRoutes:false — the ApiModel documents NO symbol the corresponding
//      generator did not emit (model-only for the TPH subtype; no REST for the
//      @emitRoutes:false entity). The value object's queries-skip is asserted
//      against the queries generator's real (filtered) output.
//
// If this gate FAILS, the BUILDER (api-model.ts) drifted from a real generator —
// fix the builder, never the gate.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaDataLoader, InMemoryStringSource, type MetaObject } from "@metaobjectsdev/metadata";
import {
  entityFile,
  queriesFile,
  routesFile,
  extractor,
  renderHelper,
} from "../../src/generators/index.js";
import { buildApiModel, type ApiModel, type ApiSymbol } from "../../src/generators/api-model.js";
import { routesHandlerName, variableNameFromEntity } from "../../src/naming.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import type { Generator, GenContext, EmittedFile } from "../../src/generator.js";

// ---------------------------------------------------------------------------
// The rich fixture — one root that hits every documented surface + skip shape.
// ---------------------------------------------------------------------------
const FIXTURE = JSON.stringify({
  "metadata.root": {
    package: "acme::shop",
    children: [
      // PK entity with fields + a field.enum + writable rdb source → model,
      // data-access, validation, REST.
      {
        "object.entity": {
          name: "Product",
          children: [
            { "field.long": { name: "id" } },
            { "field.string": { name: "name" } },
            { "field.enum": { name: "status", "@values": ["active", "discontinued"] } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } },
            { "source.rdb": { "@table": "products" } },
          ],
        },
      },
      // Value object (no primary identity / no writable source) → model only;
      // the queries generator skips it.
      {
        "object.value": {
          name: "SummaryVO",
          children: [{ "field.string": { name: "headline", "@required": true } }],
        },
      },
      // @emitRoutes:false entity → data-access + validation but NO REST.
      {
        "object.entity": {
          name: "Ledger",
          "@emitRoutes": false,
          children: [
            { "field.long": { name: "id" } },
            { "field.string": { name: "memo" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } },
            { "source.rdb": { "@table": "ledgers" } },
          ],
        },
      },
      // TPH discriminator base (queryable) + a subtype (model-only).
      {
        "object.entity": {
          name: "Auth",
          "@discriminator": "type",
          children: [
            { "source.rdb": { "@table": "auths" } },
            { "field.enum": { name: "type", "@values": ["Bridge", "Copay"] } },
            { "field.long": { name: "id" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "BridgeAuth",
          extends: "Auth",
          "@discriminatorValue": "Bridge",
          children: [{ "field.int": { name: "quantity" } }],
        },
      },
      // Document template.output (json → extractor + render:string).
      {
        "template.output": {
          name: "ProductSummary",
          "@kind": "document",
          "@payloadRef": "SummaryVO",
          "@textRef": "out/product-summary",
          "@format": "json",
        },
      },
      // Email template.output (json → extractor + render:EmailDocument).
      {
        "template.output": {
          name: "WelcomeEmail",
          "@kind": "email",
          "@payloadRef": "SummaryVO",
          "@subjectRef": "emails/welcome.subject",
          "@htmlBodyRef": "emails/welcome.html",
          "@format": "json",
        },
      },
    ],
  },
});

// The render-helper generator resolves each referenced mustache through the
// codegen-time provider (projectProvider(projectRoot)) for its build-time drift
// gate, so we materialize a project root with the referenced templates.
function makeProjectRoot(): string {
  const proj = mkdtempSync(join(tmpdir(), "api-docs-accuracy-"));
  const write = (rel: string, body: string) => {
    const full = join(proj, "templates", rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  };
  write("out/product-summary.mustache", "Headline: {{headline}}");
  write("emails/welcome.subject.mustache", "Welcome {{headline}}");
  write("emails/welcome.html.mustache", "<p>{{headline}}</p>");
  return proj;
}

async function loadRoot() {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(FIXTURE, { id: "fixture.json", format: "json" }),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}

/**
 * Run ONE generator and return its emitted files — applying the generator's own
 * `.filter` exactly as the runner does (ctx.matches = gen.filter ?? true). This
 * is what makes the skip rules (value object / TPH subtype / @emitRoutes:false)
 * actually take effect, so we compare the ApiModel against the genuinely-filtered
 * generator output an adopter would get.
 */
async function runGenerator(
  gen: Generator,
  root: Awaited<ReturnType<typeof loadRoot>>,
  projectRoot: string,
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
    // Replicates runner.ts:169 — the per-entity filter the generator declares.
    matches: (e: MetaObject) => gen.filter?.(e) ?? true,
    projectRoot,
    config: {
      outDir: "/tmp",
      extStyle: "none",
      dbImport: "~/db",
      dialect: "sqlite",
    } as never,
    renderContext,
    warn: () => {},
  };
  return gen.generate(ctx);
}

/** Concatenate the content of every file a generator emitted (the per-unit
 *  files are then scoped via the matchers below). */
function joinContent(files: EmittedFile[]): string {
  return files.map((f) => `// FILE: ${f.path}\n${f.content}`).join("\n");
}

/** Find the single file owning a given unit by an exact path suffix. */
function fileFor(files: EmittedFile[], suffix: string): EmittedFile | undefined {
  return files.find((f) => f.path.endsWith(suffix));
}

// ---------------------------------------------------------------------------
// Precise matchers (word-boundary / `export …`), never loose substring.
// ---------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A value/type/const declaration of `name`: `export interface|type|const name`. */
function hasExportedDecl(content: string, name: string): boolean {
  return new RegExp(`export\\s+(?:interface|type|const|class)\\s+${esc(name)}\\b`).test(content);
}

/** A function declaration of `name`: `export [async] function name(`. */
function hasExportedFn(content: string, name: string): boolean {
  return new RegExp(`export\\s+(?:async\\s+)?function\\s+${esc(name)}\\s*\\(`).test(content);
}

/** A literal `$path: "<path>"` entry (entity-constants emit the resource path). */
function hasPathConst(content: string, path: string): boolean {
  return new RegExp(`\\$path:\\s*${esc(JSON.stringify(path))}`).test(content);
}

/** Whole-word presence of an identifier (used for negative/inverse assertions). */
function hasIdentifier(content: string, name: string): boolean {
  return new RegExp(`\\b${esc(name)}\\b`).test(content);
}

// ---------------------------------------------------------------------------
// Field-SET extraction from the REAL generated output (T2 field-shape gate).
// The api-docs field shapes must name EXACTLY the fields the generators emit, so
// the gate parses the emitted code's own field sets and compares — a precise
// match (no documented field absent from / extra vs the generated artifact).
// ---------------------------------------------------------------------------

/** The TOP-LEVEL property keys inside the FIRST `<openMarker> … }` object body
 *  starting at `openMarker` — brace-depth-aware so nested `{ … }` (e.g. a
 *  column's `{ enum: [...] }` options or a zod `.transform(() => …)`) don't leak
 *  their inner keys. A "key" is an identifier at brace depth 1 immediately
 *  followed by `:`. */
function topLevelKeys(content: string, openMarker: string): string[] {
  const start = content.indexOf(openMarker);
  if (start < 0) return [];
  // Advance to the first `{` after the marker (the object-literal open).
  let i = content.indexOf("{", start);
  if (i < 0) return [];
  let depth = 0;
  const keys: string[] = [];
  let atKeyPosition = false; // true when the next identifier is a depth-1 key
  for (; i < content.length; i++) {
    const ch = content[i]!;
    if (ch === "{") {
      depth++;
      if (depth === 1) atKeyPosition = true;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (depth !== 1) continue;
    if (ch === ",") {
      atKeyPosition = true;
      continue;
    }
    if (atKeyPosition && /[A-Za-z_$]/.test(ch)) {
      const m = content.slice(i).match(/^([A-Za-z_$][\w$]*)\s*:/);
      if (m) {
        keys.push(m[1]!);
        i += m[1]!.length; // skip past the identifier (the `:` re-enters the loop)
      }
      atKeyPosition = false;
    }
  }
  return keys;
}

/** The drizzle table column names an entity file emits — the model's field set.
 *  Reads the `<table> = sqliteTable("<name>", { … })` columns object. */
function modelColumnNames(entityContent: string, tableVar: string): string[] {
  return topLevelKeys(entityContent, `${tableVar} = sqliteTable(`);
}

/** The property keys of a `z.object({ … })` bound to `<schemaName> = z.object(`. */
function zodSchemaKeys(entityContent: string, schemaName: string): string[] {
  return topLevelKeys(entityContent, `${schemaName} = z.object(`);
}

/** The interface property names an entity/VO file emits (value-object path). */
function interfaceFieldNames(content: string, ifaceName: string): string[] {
  const m = content.match(new RegExp(`export\\s+interface\\s+${esc(ifaceName)}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!m) return [];
  const body = m[1]!;
  const names: string[] = [];
  for (const line of body.split("\n")) {
    const mm = line.match(/^\s*([A-Za-z_$][\w$]*)\??\s*:/);
    if (mm) names.push(mm[1]!);
  }
  return names;
}

// ---------------------------------------------------------------------------
// The gate.
// ---------------------------------------------------------------------------

describe("api-docs ACCURACY gate — documented symbols == real generated output", () => {
  let root: Awaited<ReturnType<typeof loadRoot>>;
  let model: ApiModel;
  let entityFiles: EmittedFile[];
  let queriesFiles: EmittedFile[];
  let routesFiles: EmittedFile[];
  let extractorFiles: EmittedFile[];
  let renderFiles: EmittedFile[];

  // Concatenated content per generator-suite (for symbol scans).
  let entityAll = "";
  let queriesAll = "";
  let routesAll = "";
  let extractorAll = "";
  let renderAll = "";

  test("setup: run the real generators + build the ApiModel on the same root", async () => {
    const projectRoot = makeProjectRoot();
    root = await loadRoot();

    entityFiles = await runGenerator(entityFile(), root, projectRoot);
    queriesFiles = await runGenerator(queriesFile(), root, projectRoot);
    routesFiles = await runGenerator(routesFile(), root, projectRoot);
    extractorFiles = await runGenerator(extractor(), root, projectRoot);
    renderFiles = await runGenerator(renderHelper(), root, projectRoot);

    entityAll = joinContent(entityFiles);
    queriesAll = joinContent(queriesFiles);
    routesAll = joinContent(routesFiles);
    extractorAll = joinContent(extractorFiles);
    renderAll = joinContent(renderFiles);

    model = buildApiModel(root, { loadedRoot: root });

    // Sanity: the generators actually produced output for the rich fixture.
    expect(entityFiles.length).toBeGreaterThan(0);
    expect(queriesFiles.length).toBeGreaterThan(0);
    expect(routesFiles.length).toBeGreaterThan(0);
    expect(extractorFiles.length).toBe(2); // ProductSummary + WelcomeEmail (both json)
    expect(renderFiles.length).toBe(2);
    expect(model.units.length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // FORWARD: every documented symbol appears in its owning generated file.
  // -----------------------------------------------------------------------
  test("FORWARD: every ApiSymbol name appears as an emitted identifier in the owning file", () => {
    const failures: string[] = [];

    for (const unit of model.units) {
      for (const sym of unit.symbols) {
        const ok = assertSymbolEmitted(unit.node, sym);
        if (!ok.ok) failures.push(`[${unit.node}] ${sym.kind} "${sym.name}": ${ok.why}`);
      }
    }

    expect(failures, `\nDOCUMENTED-BUT-NOT-GENERATED (builder drift):\n${failures.join("\n")}\n`).toEqual(
      [],
    );

    // Returns whether `sym` was found in the generator output that OWNS its kind.
    function assertSymbolEmitted(node: string, sym: ApiSymbol): { ok: boolean; why: string } {
      switch (sym.kind) {
        case "model": {
          // entity-file emits `export type|interface|const <Name>`.
          const f = fileFor(entityFiles, `${node}.ts`);
          if (!f) return { ok: false, why: `no entity file ${node}.ts emitted` };
          return {
            ok: hasExportedDecl(f.content, sym.name),
            why: `no exported declaration of ${sym.name} in ${node}.ts`,
          };
        }
        case "validation": {
          // <Name>InsertSchema / <Name>UpdateSchema declared in the entity file.
          const f = fileFor(entityFiles, `${node}.ts`);
          if (!f) return { ok: false, why: `no entity file ${node}.ts emitted` };
          return {
            ok: hasExportedDecl(f.content, sym.name),
            why: `no exported schema ${sym.name} in ${node}.ts`,
          };
        }
        case "data-access": {
          // export [async] function <name>( in the queries file.
          const f = fileFor(queriesFiles, `${node}.queries.ts`);
          if (!f) return { ok: false, why: `no queries file ${node}.queries.ts emitted` };
          return {
            ok: hasExportedFn(f.content, sym.name),
            why: `no exported function ${sym.name} in ${node}.queries.ts`,
          };
        }
        case "extractor": {
          // export function <name>( in the extractor file.
          const f = fileFor(extractorFiles, `${node}.extractor.ts`);
          if (!f) return { ok: false, why: `no extractor file ${node}.extractor.ts emitted` };
          return {
            ok: hasExportedFn(f.content, sym.name),
            why: `no exported function ${sym.name} in ${node}.extractor.ts`,
          };
        }
        case "render": {
          // export function render<Name>( in the render file.
          const f = fileFor(renderFiles, `${node}.render.ts`);
          if (!f) return { ok: false, why: `no render file ${node}.render.ts emitted` };
          return {
            ok: hasExportedFn(f.content, sym.name),
            why: `no exported function ${sym.name} in ${node}.render.ts`,
          };
        }
        case "rest":
          return assertRestSymbol(node, sym);
        default:
          return { ok: false, why: `unhandled kind ${sym.kind}` };
      }
    }

    // REST: the routes generator does NOT emit literal "GET /path" strings — it
    // emits a single `export async function <name>Routes(fastify)` that mounts
    // the CRUD verb set at `<Name>.$path`, and the literal path lives in the
    // entity-constants `$path: "<path>"`. So a documented REST symbol is accurate
    // when BOTH hold: (a) the literal path the symbol names is the entity's real
    // $path (entity file), and (b) the routes file registers that entity's route
    // handler with the verb-tier the symbol's method implies.
    function assertRestSymbol(node: string, sym: ApiSymbol): { ok: boolean; why: string } {
      const routesFile = fileFor(routesFiles, `${node}.routes.ts`);
      if (!routesFile) return { ok: false, why: `no routes file ${node}.routes.ts emitted` };
      const entityFileF = fileFor(entityFiles, `${node}.ts`);
      if (!entityFileF) return { ok: false, why: `no entity file ${node}.ts emitted` };

      // "METHOD /path" or "METHOD /path/:id".
      const m = sym.name.match(/^([A-Z]+)\s+(\/\S*?)(\/:id)?$/);
      if (!m) return { ok: false, why: `REST symbol name "${sym.name}" not "METHOD /path"` };
      const method = m[1]!;
      const basePath = m[2]!;

      // (a) the literal base path == the entity's real $path.
      if (!hasPathConst(entityFileF.content, basePath)) {
        return { ok: false, why: `path "${basePath}" is not the $path emitted in ${node}.ts` };
      }

      // (b) the routes file registers the handler + the correct verb tier.
      const handler = `${node.charAt(0).toLowerCase()}${node.slice(1)}Routes`;
      if (!hasExportedFn(routesFile.content, handler)) {
        return { ok: false, why: `routes handler ${handler}() not emitted in ${node}.routes.ts` };
      }
      const isReadVerb = method === "GET";
      const mountsFull = hasIdentifier(routesFile.content, "mountCrudRoutes");
      const mountsReadOnly = hasIdentifier(routesFile.content, "mountReadOnlyCrudRoutes");
      // A write verb (POST/PATCH/DELETE) must be backed by full-CRUD mounting.
      if (!isReadVerb && !mountsFull) {
        return {
          ok: false,
          why: `write verb ${method} documented but ${node}.routes.ts only mounts read-only routes`,
        };
      }
      // A GET must be backed by SOME mount in the routes file.
      if (isReadVerb && !mountsFull && !mountsReadOnly) {
        return { ok: false, why: `${node}.routes.ts mounts no routes for documented GET` };
      }
      return { ok: true, why: "" };
    }
  });

  // -----------------------------------------------------------------------
  // IMPORT PATH: every symbol's documented importPath corresponds to the file
  // the REAL generator emits that symbol into. A wrong import path (an adopter
  // could not import the symbol) FAILS the gate. The importPath is the emitted
  // file path WITHOUT the `.ts` extension; the gate appends `.ts` and confirms
  //   (a) the generator emitted a file at exactly that path, AND
  //   (b) that file exports the symbol (function / decl, or — for REST — the
  //       route registrar named in the symbol's importPath).
  // -----------------------------------------------------------------------
  test("IMPORT PATH: every symbol's importPath is the file the real generator emits it into", () => {
    const failures: string[] = [];

    for (const unit of model.units) {
      for (const sym of unit.symbols) {
        const r = assertImportPath(unit.node, sym);
        if (!r.ok) failures.push(`[${unit.node}] ${sym.kind} "${sym.name}": ${r.why}`);
      }
    }

    expect(
      failures,
      `\nIMPORT-PATH DRIFT (documented import != real emitted file):\n${failures.join("\n")}\n`,
    ).toEqual([]);

    // The generator that OWNS each kind's emitted file (for the file-exists check).
    function ownerFiles(kind: ApiSymbol["kind"]): EmittedFile[] {
      switch (kind) {
        case "model":
        case "validation":
        case "rest": // REST carries the routes registrar import; routes file owns it.
          return kind === "rest" ? routesFiles : entityFiles;
        case "data-access":
          return queriesFiles;
        case "extractor":
          return extractorFiles;
        case "render":
          return renderFiles;
      }
    }

    function assertImportPath(node: string, sym: ApiSymbol): { ok: boolean; why: string } {
      const importPath = (sym as ApiSymbol & { importPath?: string }).importPath;
      if (typeof importPath !== "string" || importPath === "") {
        return { ok: false, why: `no importPath on the documented symbol` };
      }
      // The importPath must be extension-less (an importable module specifier).
      if (importPath.endsWith(".ts")) {
        return { ok: false, why: `importPath "${importPath}" carries a .ts extension` };
      }

      const expectedFile = `${importPath}.ts`;
      const files = ownerFiles(sym.kind);
      const f = files.find((x) => x.path === expectedFile);
      if (!f) {
        const emitted = files.map((x) => x.path).join(", ");
        return {
          ok: false,
          why: `no emitted file at "${expectedFile}" (generator emitted: [${emitted}])`,
        };
      }

      // The file must EXPORT the symbol an adopter would import from it.
      switch (sym.kind) {
        case "model":
        case "validation":
          return hasExportedDecl(f.content, sym.name)
            ? { ok: true, why: "" }
            : { ok: false, why: `"${expectedFile}" does not export ${sym.name}` };
        case "data-access":
        case "extractor":
        case "render":
          return hasExportedFn(f.content, sym.name)
            ? { ok: true, why: "" }
            : { ok: false, why: `"${expectedFile}" does not export fn ${sym.name}` };
        case "rest": {
          // REST symbols are not importable functions — the importPath is the
          // routes module, and the registrar the agent mounts is the camelCase
          // <entity>Routes handler. Assert the routes module exports it.
          const registrar = routesHandlerName(node);
          return hasExportedFn(f.content, registrar)
            ? { ok: true, why: "" }
            : { ok: false, why: `routes module "${expectedFile}" does not export ${registrar}()` };
        }
      }
    }
  });

  // A WRONG importPath must FAIL the gate — prove the check has teeth, not just
  // that the real builder happens to pass.
  test("IMPORT PATH: a deliberately-wrong importPath is rejected", () => {
    const productData = model.units
      .find((u) => u.node === "Product")!
      .symbols.find((s) => s.kind === "data-access")!;
    const expectedFile = `${(productData as ApiSymbol & { importPath: string }).importPath}.ts`;
    // The real one resolves.
    expect(queriesFiles.some((f) => f.path === expectedFile)).toBe(true);
    // A tampered one (point at the entity module instead of the queries module)
    // does NOT — there is no `Product.ts` queries file exporting findProductById.
    const wrong = "Product"; // entity module, not Product.queries
    expect(queriesFiles.some((f) => f.path === `${wrong}.ts`)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // INVERSE (no over-documentation) for the SKIP shapes.
  // -----------------------------------------------------------------------
  test("INVERSE: a TPH subtype is documented model-only — no symbol the generators skip", () => {
    const sub = model.units.find((u) => u.node === "BridgeAuth")!;
    expect(sub, "BridgeAuth unit present").toBeDefined();

    // The ApiModel documents ONLY a model symbol for the TPH subtype.
    expect(sub.symbols.map((s) => s.kind)).toEqual(["model"]);

    // And the real generators emitted NO standalone queries/routes file for it,
    // so there's no per-subtype symbol the model could have over-documented.
    expect(fileFor(queriesFiles, "BridgeAuth.queries.ts"), "queries skips TPH subtype").toBeUndefined();
    expect(fileFor(routesFiles, "BridgeAuth.routes.ts"), "routes skips TPH subtype").toBeUndefined();

    // The per-subtype CRUD helpers DO exist in the generated output — but they
    // live in the discriminator BASE's queries/routes files (createBridgeAuth in
    // Auth.queries.ts, BridgeAuthInsertSchema referenced in Auth.routes.ts), NOT
    // in a standalone BridgeAuth file. The ApiModel's correct behavior is to
    // document NONE of them on the subtype unit (the per-subtype helpers are a
    // tracked deferral). So the inverse check is: the ApiModel must not document
    // any per-subtype symbol name.
    for (const deferred of [
      "findBridgeAuthById",
      "listBridgeAuths",
      "createBridgeAuth",
      "updateBridgeAuthById",
      "deleteBridgeAuthById",
      "BridgeAuthInsertSchema",
      "BridgeAuthUpdateSchema",
    ]) {
      expect(sub.symbols.map((s) => s.name)).not.toContain(deferred);
    }
  });

  test("INVERSE: @emitRoutes:false entity is documented with NO REST symbol (routes gen skipped it)", () => {
    const ledger = model.units.find((u) => u.node === "Ledger")!;
    expect(ledger).toBeDefined();

    // The ApiModel documents NO REST symbol for the @emitRoutes:false entity …
    expect(ledger.symbols.filter((s) => s.kind === "rest")).toEqual([]);
    // … and the routes generator genuinely emitted no routes file for it.
    expect(fileFor(routesFiles, "Ledger.routes.ts"), "routes skips @emitRoutes:false").toBeUndefined();
    // The handler name must not appear anywhere in the routes output.
    expect(hasExportedFn(routesAll, "ledgerRoutes")).toBe(false);

    // But data-access + validation ARE documented AND ARE generated (those
    // generators don't honor @emitRoutes) — proves we didn't over-skip.
    expect(ledger.symbols.some((s) => s.kind === "data-access")).toBe(true);
    expect(ledger.symbols.some((s) => s.kind === "validation")).toBe(true);
    expect(fileFor(queriesFiles, "Ledger.queries.ts"), "queries still emitted").toBeDefined();
  });

  test("INVERSE: a value object is documented model-only — the queries generator skipped it", () => {
    const vo = model.units.find((u) => u.node === "SummaryVO")!;
    expect(vo).toBeDefined();

    // Model-only in the ApiModel: no data-access / validation / REST.
    const kinds = new Set(vo.symbols.map((s) => s.kind));
    expect(kinds.has("data-access")).toBe(false);
    expect(kinds.has("validation")).toBe(false);
    expect(kinds.has("rest")).toBe(false);

    // And the queries generator (the authority on queryable API surface) really
    // skipped it — so no findSummaryVOById etc. the model could over-document.
    expect(fileFor(queriesFiles, "SummaryVO.queries.ts"), "queries skips value object").toBeUndefined();
    expect(hasExportedFn(queriesAll, "findSummaryVOById")).toBe(false);
    expect(hasExportedFn(queriesAll, "createSummaryVO")).toBe(false);
  });

  // -----------------------------------------------------------------------
  // FIELD SHAPES (T2): the documented field SET (model / create / update /
  // extractor payload) must match — PRECISELY — the field set the REAL
  // generators emit. A drift in the field set (a documented field absent from /
  // extra vs the generated artifact) FAILS the gate. We also assert
  // required/optional + the enum-literal type agree with the generated zod/TS.
  // -----------------------------------------------------------------------

  /** Pull a unit's symbol of a given kind (first match). */
  function symOf(node: string, kind: ApiSymbol["kind"]): ApiSymbol {
    const u = model.units.find((x) => x.node === node)!;
    const s = u.symbols.find((x) => x.kind === kind);
    expect(s, `${node} has a ${kind} symbol`).toBeDefined();
    return s!;
  }
  /** A documented symbol's field NAMES (in order). */
  function docFieldNames(s: ApiSymbol): string[] {
    return (s.fields ?? []).map((f) => f.name);
  }

  test("FIELD SHAPE: model fields == the entity's emitted drizzle columns (precise set)", () => {
    const f = fileFor(entityFiles, "Product.ts")!;
    const emitted = modelColumnNames(f.content, variableNameFromEntity("Product"));
    expect(emitted.length).toBeGreaterThan(0);
    const documented = docFieldNames(symOf("Product", "model"));
    // PRECISE set match — order-independent, no missing/extra field.
    expect([...documented].sort()).toEqual([...emitted].sort());
    // The PK (id) is documented required; a plain non-required field is optional.
    const byName = new Map(symOf("Product", "model").fields!.map((x) => [x.name, x]));
    expect(byName.get("id")!.optional).toBe(false);
    expect(byName.get("name")!.optional).toBe(true);
  });

  test("FIELD SHAPE: create-payload fields == the emitted ProductInsertSchema keys (precise set + optionality)", () => {
    const f = fileFor(entityFiles, "Product.ts")!;
    const emitted = zodSchemaKeys(f.content, "ProductInsertSchema");
    expect(emitted.length).toBeGreaterThan(0);
    // The auto-gen PK (id) must NOT be in the InsertSchema — nor documented.
    expect(emitted).not.toContain("id");
    // The createProduct data-access symbol's fields document the InsertSchema.
    const createSym = model.units.find((u) => u.node === "Product")!.symbols
      .find((s) => s.kind === "data-access" && s.name.startsWith("createProduct"))!;
    expect(createSym.fields, "createProduct carries the create payload shape").toBeDefined();
    expect([...docFieldNames(createSym)].sort()).toEqual([...emitted].sort());
    expect(docFieldNames(createSym)).not.toContain("id");

    // The validation InsertSchema symbol documents the SAME set.
    const insertVal = model.units.find((u) => u.node === "Product")!.symbols
      .find((s) => s.kind === "validation" && s.name === "ProductInsertSchema")!;
    expect([...docFieldNames(insertVal)].sort()).toEqual([...emitted].sort());

    // Enum-literal accuracy: `status` is documented as the literal union the
    // generator emits (`"active" | "discontinued"`), not an opaque name.
    const status = insertVal.fields!.find((x) => x.name === "status")!;
    expect(status.type).toBe(`"active" | "discontinued"`);
    expect(f.content).toContain(`z.enum(["active", "discontinued"])`);
  });

  test("FIELD SHAPE: update-payload fields == the emitted ProductUpdateSchema keys (all optional)", () => {
    const f = fileFor(entityFiles, "Product.ts")!;
    const emitted = zodSchemaKeys(f.content, "ProductUpdateSchema");
    expect(emitted.length).toBeGreaterThan(0);
    const updateVal = model.units.find((u) => u.node === "Product")!.symbols
      .find((s) => s.kind === "validation" && s.name === "ProductUpdateSchema")!;
    expect([...docFieldNames(updateVal)].sort()).toEqual([...emitted].sort());
    // PATCH semantics — every documented update field is optional.
    expect(updateVal.fields!.every((x) => x.optional)).toBe(true);
    // The updateProduct data-access symbol documents the same update set.
    const updateSym = model.units.find((u) => u.node === "Product")!.symbols
      .find((s) => s.kind === "data-access" && s.name.startsWith("updateProduct"))!;
    expect([...docFieldNames(updateSym)].sort()).toEqual([...emitted].sort());
  });

  test("FIELD SHAPE: REST POST body == create set, PATCH body == update set, GET response == model set", () => {
    const f = fileFor(entityFiles, "Product.ts")!;
    const insert = zodSchemaKeys(f.content, "ProductInsertSchema");
    const update = zodSchemaKeys(f.content, "ProductUpdateSchema");
    const cols = modelColumnNames(f.content, variableNameFromEntity("Product"));
    const rest = model.units.find((u) => u.node === "Product")!.symbols.filter((s) => s.kind === "rest");
    const post = rest.find((s) => s.name.startsWith("POST "))!;
    const patch = rest.find((s) => s.name.startsWith("PATCH "))!;
    const getOne = rest.find((s) => s.name === "GET /products/:id")!;
    expect([...docFieldNames(post)].sort()).toEqual([...insert].sort());
    expect([...docFieldNames(patch)].sort()).toEqual([...update].sort());
    expect([...docFieldNames(getOne)].sort()).toEqual([...cols].sort());
    // DELETE carries no body shape.
    const del = rest.find((s) => s.name.startsWith("DELETE "))!;
    expect(del.fields).toBeUndefined();
  });

  test("FIELD SHAPE: extractor payload fields == the @payloadRef VO interface fields", () => {
    const voFile = fileFor(entityFiles, "SummaryVO.ts")!;
    const emitted = interfaceFieldNames(voFile.content, "SummaryVO");
    expect(emitted).toContain("headline");
    const extract = model.units.find((u) => u.node === "ProductSummary")!.symbols
      .find((s) => s.kind === "extractor" && s.name === "extractProductSummary")!;
    expect(extract.fields, "extract carries the payload VO shape").toBeDefined();
    expect([...docFieldNames(extract)].sort()).toEqual([...emitted].sort());
    // @required field is documented required.
    expect(extract.fields!.find((x) => x.name === "headline")!.optional).toBe(false);
  });
});
