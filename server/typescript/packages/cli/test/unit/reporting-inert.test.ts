// FR-044 — what a report generates, and what it does not.
//
// Plan 1 registered `dimension.*`, `measure.*`, `segment.*` and `object.report` and gave
// them no output. Plan 2 lowers a report that declares a read-only `source.rdb @kind: view`
// to that view in TypeScript migrate (and so on the `meta docs` agent schema page, which
// lists the views migrate would create). Plan 3 serves that same report: the TypeScript
// generators emit its keyless read-only surface, and nothing else.
//
// So this file holds two lines. A SOURCELESS report is inert everywhere. A SERVED report
// (`StoreTotals`) adds exactly its read-only files: the entity module (Drizzle view
// binding, Zod read schema, descriptor, allowlists), the list query, the Fastify and Hono
// routes, the names artifact and its barrel export. It adds nothing from the UI tier
// (hooks, grid, grid hook, form), which is off for reports until Plan 5, and every file
// the model without reporting nodes emits is byte-identical, the barrel excepted.
//
// The model pair lives in fixtures/codegen-noop/reporting/ and is shared with the other
// four ports' copies of this test. `with/` carries a report that declares a read-only
// `source.rdb @kind: view` (R5 allows one): that is the case that once leaked in C#, where
// it emitted a keyless DbSet, a GET route and a filter allowlist for an object with no fields.
//
// `meta docs` is still held to the Plan 1 rule here (controller ruling, 2026-10-03): every
// docs surface — model pages, agent pages, requirements, the HTML site, and the api surface
// — comes out identical with and without the reporting nodes, bar the one view entry.

import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { loadUris, OBJECT_SUBTYPE_REPORT, DEFAULT_COLUMN_NAMING_STRATEGY, type MetaRoot } from "@metaobjectsdev/metadata";
import {
  runGen, makeRenderContext, buildPkMap, buildRelationMap, buildProjectionViews,
  type AgentSchemaInput, type GenContext, type Generator, type MetaobjectsGenConfig,
  type SchemaColumnLike,
} from "@metaobjectsdev/codegen-ts";
import { agentDocsFile, apiDocsFile } from "@metaobjectsdev/codegen-ts/generators";
import {
  buildExpectedSchema, buildExpectedSchemaWithProvenance, columnTypeSql, diff, qualifiedDbName,
  type SchemaSnapshot,
} from "@metaobjectsdev/migrate-ts";
import { composeCatalog } from "../../src/lib/catalog.js";
import { docsCommand } from "../../src/commands/docs.js";

// test/unit → cli → packages → typescript → server → repo root
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
const MODELS = join(REPO_ROOT, "fixtures", "codegen-noop", "reporting");
const GEN_STATE = ".gen-state";

async function load(variant: "with" | "without"): Promise<MetaRoot> {
  const file = join(MODELS, variant, "meta.shop.json");
  const result = await loadUris([pathToFileURL(file).href]);
  if (result.errors.length > 0) {
    throw new Error(`${file} did not load:\n${result.errors.map((e) => e.message).join("\n")}`);
  }
  return result.root;
}

function walkFiles(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...walkFiles(root, abs));
    else out.push(relative(root, abs));
  }
  return out.sort();
}

/** What one generator set emits for a model: project-relative path → contents, or the
 *  error text when the run threw (a throw must be identical with and without, too). */
async function emit(metadata: MetaRoot, generators: Generator[]): Promise<Record<string, string>> {
  const root = mkdtempSync(join(tmpdir(), "reporting-inert-"));
  const config: MetaobjectsGenConfig = {
    outDir: "src/generated",
    extStyle: "js",
    dialect: "postgres",
    dbImport: "../db",
    generators,
  };
  try {
    // A real write, not a dry run: a dry run reports paths only, and the claim is
    // byte-identical CONTENT.
    await runGen({ config, metadata, projectRoot: root, genStateDir: join(root, GEN_STATE) });
    const files: Record<string, string> = {};
    for (const rel of walkFiles(root)) {
      if (rel.split(sep)[0] === GEN_STATE) continue;
      files[rel] = readFileSync(join(root, rel), "utf8");
    }
    return files;
  } catch (e) {
    return { "<threw>": e instanceof Error ? e.message : String(e) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

let withReporting: MetaRoot;
let withoutReporting: MetaRoot;

beforeAll(async () => {
  withReporting = await load("with");
  withoutReporting = await load("without");
});

/** Table E, TypeScript: the files a served report adds, by the catalog generator that
 *  writes them. A generator that is not listed adds none. */
const OUT = "src/generated";
const SERVED_REPORT_FILES: Readonly<Record<string, readonly string[]>> = {
  entity: [`${OUT}/StoreTotals.ts`],
  names: [`${OUT}/StoreTotals.names.ts`],
  queries: [`${OUT}/StoreTotals.queries.ts`],
  routes: [`${OUT}/StoreTotals.routes.ts`],
  "routes-hono": [`${OUT}/StoreTotals.routes.hono.ts`],
};
/** The one existing file a served report changes: it gains the report's export line. */
const BARREL = `${OUT}/index.ts`;
/** The client UI tier, off for reports until Plan 5 (answer 6). */
const UI_TIER = ["hooks", "grid", "grid-hook", "form"] as const;
const SOURCELESS_REPORTS = ["ProgramEngagement", "DailyRevenue"] as const;

/** Assert `actual` is `expected` plus exactly `added`, with every shared file
 *  byte-identical except the barrel. */
function expectOnlyAdds(
  expected: Record<string, string>,
  actual: Record<string, string>,
  added: readonly string[],
): void {
  expect(Object.keys(actual).filter((p) => !(p in expected)).sort()).toEqual([...added].sort());
  expect(Object.keys(expected).filter((p) => !(p in actual))).toEqual([]);
  for (const [path, content] of Object.entries(expected)) {
    if (path === BARREL) continue;
    expect({ path, content: actual[path] }).toEqual({ path, content });
  }
  // Nothing at all for a sourceless report, in any file name.
  for (const name of SOURCELESS_REPORTS) {
    expect(Object.keys(actual).filter((p) => p.includes(name))).toEqual([]);
  }
}

describe("FR-044 a sourceless report is inert; a served report emits exactly its read-only files", () => {
  test("the with-model really carries the vocabulary (else every check below is vacuous)", () => {
    const reports = withReporting.objects().filter((o) => o.subType === OBJECT_SUBTYPE_REPORT);
    expect(reports.map((o) => o.name).sort()).toEqual(["DailyRevenue", "ProgramEngagement", "StoreTotals"]);
    expect(withoutReporting.objects().some((o) => o.subType === OBJECT_SUBTYPE_REPORT)).toBe(false);
  });

  const catalog = composeCatalog();

  test("every generator named in the expected-files table is in the catalog", () => {
    // A renamed catalog entry would otherwise turn its row into dead text and its
    // generator into one that is expected to add nothing.
    for (const name of [...Object.keys(SERVED_REPORT_FILES), "barrel", ...UI_TIER]) {
      expect(Object.keys(catalog)).toContain(name);
    }
  });

  for (const [name, entry] of Object.entries(catalog)) {
    test(`generator "${name}" adds exactly the served report's files and changes nothing else`, async () => {
      const expected = await emit(withoutReporting, [entry.factory()]);
      const actual = await emit(withReporting, [entry.factory()]);
      if ("<threw>" in expected) {
        // Cannot run from a bare model (pinned by name below): the same throw both ways.
        expect(actual).toEqual(expected);
        return;
      }
      expectOnlyAdds(expected, actual, SERVED_REPORT_FILES[name] ?? []);
      if (name === "barrel") {
        // The barrel is the one shared file that moves, and it moves by the report's
        // export alone: every line it had is still there, in order.
        const before = expected[BARREL]!.split("\n");
        const after = actual[BARREL]!.split("\n");
        const addedLines = after.filter((l) => !before.includes(l));
        expect(addedLines.length).toBeGreaterThan(0);
        for (const l of addedLines) expect(l).toContain("StoreTotals");
        expect(after.filter((l) => before.includes(l))).toEqual(before);
      } else if (BARREL in expected) {
        expect(actual[BARREL]).toBe(expected[BARREL]!);
      }
    });
  }

  for (const name of UI_TIER) {
    test(`UI-tier generator "${name}" emits no file for any report`, async () => {
      const actual = await emit(withReporting, [catalog[name]!.factory()]);
      expect(actual["<threw>"]).toBeUndefined();
      // Not vacuous for hooks and form: they do emit for the entities beside the reports.
      // The two grid generators emit only for an object with a `layout.dataGrid`, which
      // nothing in this model declares, so for them this run shows only that nothing
      // leaks; their gate (`servesClientTier`) is asserted directly in codegen-ts and
      // codegen-ts-tanstack.
      if (name === "hooks" || name === "form") {
        expect(Object.keys(actual).some((p) => p.includes("Program"))).toBe(true);
      }
      expect(Object.keys(actual).filter((p) => p.includes("StoreTotals"))).toEqual([]);
    });
  }

  test("exactly these generators cannot run from a bare model — the list may only shrink", async () => {
    // Each is compared above on its error message alone, which proves nothing about its
    // output. Pinned by name so a generator that starts throwing cannot drop out silently.
    //   shared-model  needs a `files` selection `meta gen` supplies at run time
    const threw: string[] = [];
    for (const [name, entry] of Object.entries(catalog)) {
      if ("<threw>" in (await emit(withoutReporting, [entry.factory()]))) threw.push(name);
    }
    expect(threw.sort()).toEqual(["shared-model"]);
  });

  test("every runnable generator in ONE run adds exactly the Table E list (barrels see the whole suite)", async () => {
    // A generator that cannot run from a bare model (shared-model needs a `files`
    // selection) throws in both variants above, which is equal and so passes; it would
    // sink the whole combined run, so it sits this one out.
    const runnable: string[] = [];
    for (const [name, entry] of Object.entries(catalog)) {
      const alone = await emit(withoutReporting, [entry.factory()]);
      if (!("<threw>" in alone)) runnable.push(name);
    }
    const suite = (): Generator[] => runnable.map((n) => catalog[n]!.factory());
    const expected = await emit(withoutReporting, suite());
    const actual = await emit(withReporting, suite());
    expect(expected["<threw>"]).toBeUndefined();
    expect(actual["<threw>"]).toBeUndefined();
    expect(Object.keys(expected).length).toBeGreaterThan(10);
    expectOnlyAdds(expected, actual, Object.values(SERVED_REPORT_FILES).flat());
    // In the full suite the barrel re-exports the report's modules.
    expect(actual[BARREL]).toContain("StoreTotals");
    expect(expected[BARREL]).not.toContain("StoreTotals");
  });
});

describe("FR-044 a selection of only reports", () => {
  const allGenerators = (): Generator[] =>
    Object.values(composeCatalog()).filter((e) => e.name !== "shared-model").map((e) => e.factory());
  const run = async (entityFilter: string[]) => {
    const root = mkdtempSync(join(tmpdir(), "reporting-inert-only-"));
    try {
      return await runGen({
        config: { outDir: "src/generated", extStyle: "js", dialect: "postgres", dbImport: "../db", generators: allGenerators() },
        metadata: withReporting,
        projectRoot: root,
        genStateDir: join(root, GEN_STATE),
        entityFilter,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  test("only sourceless reports: warns that there is nothing to generate, like an empty selection", async () => {
    const result = await run([...SOURCELESS_REPORTS]);
    expect(result.files).toEqual([]);
    expect(result.warnings.some((w) => w.startsWith("No entities to generate") && w.includes("object.report"))).toBe(true);
  });

  test("a served report among them generates, and only for itself", async () => {
    const result = await run(["DailyRevenue", "ProgramEngagement", "StoreTotals"]);
    expect(result.warnings.some((w) => w.startsWith("No entities to generate"))).toBe(false);
    const names = result.files.map((f) => f.path.split(sep).pop()!);
    for (const file of Object.values(SERVED_REPORT_FILES).flat()) {
      expect(names).toContain(file.split("/").pop()!);
    }
    for (const name of SOURCELESS_REPORTS) {
      expect(names.filter((n) => n.includes(name))).toEqual([]);
    }
  });
});

describe("FR-044 a sourceless report is inert in migrate; a view-backed report proposes exactly its view", () => {
  test("the expected postgres schemas differ by exactly v_store_totals, and diff() proposes exactly that view", async () => {
    const views = (m: MetaRoot) => buildProjectionViews(m, { dialect: "postgres" });
    const withSchema: SchemaSnapshot = buildExpectedSchema(withReporting, { dialect: "postgres", views: views(withReporting) });
    const withoutSchema: SchemaSnapshot = buildExpectedSchema(withoutReporting, { dialect: "postgres", views: views(withoutReporting) });

    // Only StoreTotals declares a view; ProgramEngagement and DailyRevenue are sourceless.
    expect(withoutSchema.views).toEqual([]);
    expect(withSchema.views.map((v) => v.name)).toEqual(["v_store_totals"]);
    // Everything else is the same: the tables do not move.
    expect(withSchema.tables).toEqual(withoutSchema.tables);

    // Live DB = the model without reporting nodes; metadata = the model with them.
    const forward = await diff({ expected: withSchema, actual: withoutSchema });
    expect(forward.changes.map((c) => [c.kind, c.kind === "create-view" ? c.view.name : undefined])).toEqual([
      ["create-view", "v_store_totals"],
    ]);
    // And from an empty database, the report adds exactly that one view to what the entities need.
    const empty: SchemaSnapshot = { tables: [], views: [] };
    const fromEmptyWith = await diff({ expected: withSchema, actual: empty });
    const fromEmptyWithout = await diff({ expected: withoutSchema, actual: empty });
    expect(fromEmptyWith.changes.filter((c) => c.kind !== "create-view")).toEqual(
      fromEmptyWithout.changes.filter((c) => c.kind !== "create-view"),
    );
    expect(fromEmptyWith.changes.filter((c) => c.kind === "create-view")).toHaveLength(1);
  });
});

describe("FR-044 reporting nodes are inert in meta docs, bar the one view entry", () => {
  /** Run `meta docs` over a project holding one variant, once per surface flag set, and
   *  read back everything written. The project directory has the SAME basename for both
   *  variants: the site stamps it into every page title. */
  async function docsOutput(variant: "with" | "without"): Promise<Record<string, string>> {
    const parent = mkdtempSync(join(tmpdir(), "reporting-inert-docs-"));
    const root = join(parent, "shop");
    try {
      mkdirSync(join(root, "metaobjects"), { recursive: true });
      copyFileSync(join(MODELS, variant, "meta.shop.json"), join(root, "metaobjects", "meta.shop.json"));
      // `--agent` is listed for completeness but emits nothing without a gen config; the
      // agent surface is driven directly below, with the UI tier wired.
      for (const flags of [[], ["--agent"], ["--requirements"], ["--site"]]) {
        const out = join(root, "out" + flags.join(""));
        expect(await docsCommand([root, "--out", out, ...flags], root, { silent: true })).toBe(0);
      }
      const files: Record<string, string> = {};
      for (const rel of walkFiles(root)) {
        if (rel.split(sep)[0] === "metaobjects") continue;
        files[rel] = readFileSync(join(root, rel), "utf8");
      }
      return files;
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }

  test("model, agent, requirements and site output are identical", async () => {
    const expected = await docsOutput("without");
    const actual = await docsOutput("with");
    expect(Object.keys(expected).some((p) => p.endsWith(".html"))).toBe(true);
    expect(Object.keys(expected).some((p) => p.endsWith(".md"))).toBe(true);
    expect(Object.keys(actual)).toEqual(Object.keys(expected));
    expect(actual).toEqual(expected);
  });

  /** The GenContext `meta docs` builds, with a full generator suite wired: the Hono
   *  routes and the UI tier both on, so every page that keys off them is rendered. */
  const docsCtx = (metadata: MetaRoot): GenContext => ({
    entities: metadata.objects(),
    loadedRoot: metadata,
    matches: () => true,
    config: {
      outDir: "docs", extStyle: "none", dbImport: "", dialect: "postgres", outputLayout: "flat",
      includeHonoRoutes: true, includeUiTier: true,
    } as never,
    renderContext: makeRenderContext({
      dialect: "postgres", loadedRoot: metadata, outDir: "docs", dbImport: "", apiPrefix: "/api",
      pkMap: buildPkMap(metadata), relationMap: buildRelationMap(metadata),
    }),
    projectRoot: MODELS,
    warn: () => {},
  });

  const compare = (expected: Record<string, string>, actual: Record<string, string>): void => {
    expect(Object.keys(actual)).toEqual(Object.keys(expected));
    expect(actual).toEqual(expected);
  };

  test("the api surface is identical", async () => {
    // `meta docs --api` materializes only with a loadable gen config, which a temp project
    // cannot import; so drive the generator with the GenContext `meta docs` builds.
    const api = async (metadata: MetaRoot): Promise<Record<string, string>> => {
      const out: Record<string, string> = {};
      for (const f of await apiDocsFile({ subDir: "api" }).generate(docsCtx(metadata))) out[f.path] = f.content;
      return out;
    };
    const expected = await api(withoutReporting);
    expect(Object.keys(expected).length).toBeGreaterThan(2);
    compare(expected, await api(withReporting));
  });

  test("the agent surface differs only by the schema page's v_store_totals view, with the UI tier wired", async () => {
    // Same reason as above: `meta docs --agent` needs a loadable gen config. The schema
    // input is built exactly as docs.ts's buildAgentSchemaInput builds it for postgres.
    const agent = async (metadata: MetaRoot): Promise<Record<string, string>> => {
      const dialect = "postgres" as const;
      const strategy = DEFAULT_COLUMN_NAMING_STRATEGY;
      const built = buildExpectedSchemaWithProvenance(metadata, {
        dialect,
        columnNamingStrategy: strategy,
        views: buildProjectionViews(metadata, { dialect, columnNamingStrategy: strategy }),
      });
      const schema: AgentSchemaInput = {
        dialect,
        tables: built.snapshot.tables,
        views: built.snapshot.views,
        provenance: built.provenance,
        columnType: (c: SchemaColumnLike) => columnTypeSql(c as never, dialect),
        qualify: qualifiedDbName,
      };
      const out: Record<string, string> = {};
      const files = await agentDocsFile({ schema, columnNamingStrategy: strategy }).generate(docsCtx(metadata));
      for (const f of files) out[f.path] = f.content;
      return out;
    };
    const expected = await agent(withoutReporting);
    // ui.md is the page that leaked a view-backed report; it must actually be rendered.
    expect(Object.keys(expected).some((p) => p.endsWith("ui.md"))).toBe(true);
    expect(Object.keys(expected).some((p) => p.endsWith("schema.md"))).toBe(true);
    const actual = await agent(withReporting);

    // The schema page lists the views migrate would create (docs.ts feeds it
    // buildProjectionViews), so the one view-backed report appears there and nowhere else.
    const schemaPage = Object.keys(expected).find((p) => p.endsWith("schema.md"))!;
    const entry = "## Views\n\n" +
      "A view is generated from its projection's `origin.*` children or its report's dimensions and measures — it is derived, never hand-written. " +
      "Editing the view SQL directly is drift the tool cannot see.\n\n" +
      "### `v_store_totals`\n\nDeclared by `acme::shop::StoreTotals`.\n\n";
    expect(actual[schemaPage]).toContain(entry);
    expect(actual[schemaPage]!.replace(entry, "")).toBe(expected[schemaPage]!);
    delete actual[schemaPage];
    const rest = { ...expected };
    delete rest[schemaPage];
    compare(rest, actual);
  });
});
