// api-docs-agent-usability — the USEFULNESS gate (the staff review's headline).
//
// The other api-docs golden tests gate CORRECTNESS: every documented symbol
// actually appears in the generated code (api-docs-accuracy.test.ts), and the
// rendered forms are byte-exact (api-doc-render.test.ts). NONE of them gate the
// question the review cared about most: "could an AGENT write a COMPILING call
// from AGENT-API.md ALONE?"
//
// This test is a STRUCTURAL proxy for that. It renders the AGENT form for a rich
// fixture model and asserts it is ACTIONABLE end-to-end:
//   1. Setup present — db/provider/root each named with a REAL import (the
//      handles the documented signatures take).
//   2. Every CALLABLE symbol (data-access / extractor / render) is IMPORTABLE —
//      the agent form carries an `import { … } from "<module>"` that names it (a
//      group header counts), so no symbol is un-callable for lack of an import.
//   3. Create/update payloads show FIELD SHAPES — the agent sees `data: { … }`
//      with the real field names, not an opaque `data: unknown`.
//   4. At least one RUNNABLE EXAMPLE per entity unit, referencing the documented
//      symbols + real values.
//   5. (Strong) PARSE-check — the example code blocks are extracted, the runtime
//      handles (db/provider/root/llmText) are stubbed as `any`, and each example
//      body is asserted to be PARSE-valid TypeScript via Bun.Transpiler. This
//      catches a future change that strips/garbles examples into broken syntax.
//
// It is the institutional memory of the review: it FAILS if a future change
// strips imports / shapes / setup / examples and makes the docs non-actionable
// again. It does NOT pin bytes (api-doc-render.test.ts owns that) — it pins
// ACTIONABILITY, so it survives benign wording tweaks but catches real regressions.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildApiModel, type ApiModel } from "../../src/generators/api-model.js";
import { renderAgentApi } from "../../src/generators/api-doc-render.js";
import { frameworkTemplatesProvider } from "../../src/render-engine/framework-provider.js";

// A RICH fixture: a CRUD entity (Product) carrying a string field AND an enum
// field (so create/update payload shapes + example values are non-trivial), a
// value object (model-only), and an output template (extractor + render). This
// exercises every callable kind — data-access, extractor, render — plus the
// payload-shape inlining.
const CHILDREN = [
  {
    "object.entity": {
      name: "Product",
      children: [
        { "field.long": { name: "id" } },
        { "field.string": { name: "name", "@required": true } },
        {
          "field.enum": {
            name: "status",
            "@values": ["draft", "published", "archived"],
          },
        },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } },
        { "source.rdb": { "@table": "products" } },
      ],
    },
  },
  {
    "object.value": {
      name: "SummaryVO",
      children: [{ "field.string": { name: "headline", "@required": true } }],
    },
  },
  {
    "template.output": {
      name: "ProductSummary",
      "@kind": "document",
      "@payloadRef": "SummaryVO",
      "@textRef": "out/product-summary",
      "@format": "json",
    },
  },
];

async function loadModel(): Promise<ApiModel> {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(
      JSON.stringify({ "metadata.root": { package: "acme::shop", children: CHILDREN } }),
      { id: "meta.json", format: "json" },
    ),
  ]);
  expect(res.errors).toEqual([]);
  return buildApiModel(res.root, { loadedRoot: res.root });
}

const provider = frameworkTemplatesProvider;

// The CALLABLE kinds — a symbol an agent would actually invoke (and therefore
// MUST be able to import). REST endpoints aren't importable identifiers (they
// mount via a registrar), and `model`/`validation` are types/schemas, so the
// "every callable is importable" check targets just these.
const CALLABLE_KINDS = new Set(["data-access", "extractor", "render"]);

// ---------------------------------------------------------------------------
// Example extraction + the lightweight TS parse harness.
// ---------------------------------------------------------------------------

/** Pull every fenced ```ts block body out of a rendered markdown doc. */
function extractTsBlocks(md: string): string[] {
  const blocks: string[] = [];
  const re = /```ts\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) blocks.push(m[1]!);
  return blocks;
}

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** Assert a TS source string PARSES (syntactically valid). Bun.Transpiler.scan
 *  throws on a syntax error, so a clean scan == parse-valid. */
function assertParses(source: string): void {
  // scan() throws on broken syntax; a clean call means the source parses.
  transpiler.scan(source);
}

describe("api-docs agent-usability gate — an agent could write a compiling call from the AGENT form alone", () => {
  // 1. SETUP present: db / provider / root each named with a real import.
  test("Setup names db/provider/root each with a real import for the handles the signatures need", async () => {
    const out = renderAgentApi(await loadModel(), provider);
    expect(out).toContain("## Setup");
    // db — a real Drizzle construction the queries' `db: Db` param accepts.
    expect(out).toContain("`db`");
    expect(out).toContain(`import { drizzle } from "drizzle-orm/node-postgres"`);
    // provider — the real Provider impl render<Name>(payload, provider) takes.
    expect(out).toContain("`provider`");
    expect(out).toContain(`import { InMemoryProvider } from "@metaobjectsdev/render"`);
    // root — the real loader shortcut extract<Name>(root, …) parses against.
    expect(out).toContain("`root`");
    expect(out).toContain(`import { loadDirectory } from "@metaobjectsdev/metadata"`);
  });

  // 2. Every CALLABLE symbol has an import that names it (group header counts).
  test("every callable symbol (data-access/extractor/render) is importable — its name appears in an import { … } from header", async () => {
    const model = await loadModel();
    const out = renderAgentApi(model, provider);

    // The set of `import { a, b, c } from "mod"` headers the agent form renders.
    const importHeaders = out
      .split("\n")
      .filter((l) => /^`import \{ .* \} from ".*"`$/.test(l) || /^import \{ .* \} from ".*"$/.test(l));
    expect(importHeaders.length).toBeGreaterThan(0);
    // Flatten every imported identifier across all headers.
    const importedNames = new Set<string>();
    for (const h of importHeaders) {
      const m = /import \{ ([^}]*) \} from/.exec(h);
      if (!m) continue;
      for (const n of m[1]!.split(",").map((s) => s.trim())) importedNames.add(n);
    }

    const callables = model.units
      .flatMap((u) => u.symbols)
      .filter((s) => CALLABLE_KINDS.has(s.kind));
    expect(callables.length).toBeGreaterThan(0);
    for (const s of callables) {
      // Each callable's import identity is its own name (it's an importable fn).
      expect(importedNames.has(s.name)).toBe(true);
    }
  });

  // 3. Create/update payloads show the real field shape, not `data: unknown`.
  test("create/update payload lines inline the real field names, not an opaque data: unknown", async () => {
    const out = renderAgentApi(await loadModel(), provider);
    // The create line carries the create-payload field SHAPE (name + status),
    // not the opaque param.
    const createLine = out.split("\n").find((l) => l.includes("createProduct("));
    expect(createLine).toBeDefined();
    expect(createLine!).not.toContain("data: unknown");
    expect(createLine!).toContain("data: {");
    expect(createLine!).toContain("name"); // a real, @required field
    expect(createLine!).toContain("status"); // the enum field
    // And the update line likewise shows a shape (all-optional on PATCH).
    const updateLine = out.split("\n").find((l) => l.includes("updateProduct("));
    expect(updateLine).toBeDefined();
    expect(updateLine!).not.toContain("data: unknown");
    expect(updateLine!).toContain("data: {");
    expect(updateLine!).toContain("name");
  });

  // 4. At least one runnable example per entity unit, using documented symbols.
  test("each entity unit carries a runnable example referencing its documented symbols + real values", async () => {
    const model = await loadModel();
    const out = renderAgentApi(model, provider);
    const entityUnits = model.units.filter(
      (u) => u.nodeKind === "entity" && u.example !== undefined,
    );
    expect(entityUnits.length).toBeGreaterThan(0);
    for (const u of entityUnits) {
      const body = u.example!.body.join("\n");
      // The example body appears verbatim in the agent form (the agent reads it).
      expect(out).toContain(body);
      // It references at least one of the unit's own documented symbols by name.
      const referencesADocumentedSymbol = u.symbols.some((s) =>
        CALLABLE_KINDS.has(s.kind) && body.includes(`${s.name}(`),
      );
      expect(referencesADocumentedSymbol).toBe(true);
    }
    // The Product example uses real values for both field types: a string field
    // becomes "…" and the enum field becomes a real member.
    expect(out).toContain(`createProduct(db, {`);
  });

  // 5. PARSE-check: the agent form's example blocks are syntactically valid TS
  //    once the runtime handles are stubbed. Catches a future change that
  //    garbles an example into broken syntax.
  test("the agent form's example code blocks PARSE as TypeScript (handles stubbed)", async () => {
    const out = renderAgentApi(await loadModel(), provider);
    const blocks = extractTsBlocks(out);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      // Stub the free runtime handles the examples reference (db/provider/root/
      // llmText) as `any` so the body's STRUCTURE is what's under test, not the
      // generated modules. Prepending declarations keeps it a single TS unit.
      const stubbed =
        `declare const db: any;\n` +
        `declare const provider: any;\n` +
        `declare const root: any;\n` +
        `declare const llmText: any;\n` +
        `async function __example() {\n${block}\n}\n`;
      // Throws on a syntax error — so a clean scan proves the example parses.
      expect(() => assertParses(stubbed)).not.toThrow();
    }
  });

  // Guard: the gate is NON-TRIVIAL — it would FAIL on a stripped/empty form.
  test("the gate is non-trivial: a form with no imports/shapes/examples would fail it", async () => {
    const model = await loadModel();
    const out = renderAgentApi(model, provider);
    // Sanity: the rich fixture actually produced imports, a shape, and examples
    // (so the asserts above were exercised, not vacuously satisfied).
    expect(out).toContain("import {");
    expect(out).toContain("data: {");
    expect(extractTsBlocks(out).length).toBeGreaterThan(0);
  });
});
