// FR-044 Plan 1 — the reporting vocabulary is INERT in every generator and in migrate.
//
// Plan 1 registers `dimension.*`, `measure.*`, `segment.*` and `object.report` and
// validates them at load, but gives none of them output: a report's lowering (a view, a
// typed row, a route) lands in Plan 2/3. Until then a model that USES the vocabulary must
// generate exactly what the same model without it generates — byte for byte, in every
// catalog generator — and `meta migrate` must propose nothing for it. Anything else is
// churn an adopter sees the day they declare a measure.
//
// The model pair lives in fixtures/codegen-noop/reporting/ and is shared with the other
// four ports' copies of this test. `with/` carries a report that declares a read-only
// `source.rdb @kind: view` (R5 allows one): that is the case that leaked in C#, where it
// emitted a keyless DbSet, a GET route and a filter allowlist for an object with no fields.
//
// `meta docs` is held to the same rule (controller ruling, 2026-10-03): a report's fields
// are derived by its lowering, so a page for one today would show none of them. Every docs
// surface — model pages, agent pages, requirements, the HTML site, and the api surface —
// must come out identical with and without the reporting nodes.

import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { loadUris, type MetaRoot } from "@metaobjectsdev/metadata";
import {
  runGen, makeRenderContext, buildPkMap, buildRelationMap,
  type GenContext, type Generator, type MetaobjectsGenConfig,
} from "@metaobjectsdev/codegen-ts";
import { apiDocsFile } from "@metaobjectsdev/codegen-ts/generators";
import { buildExpectedSchema, diff, type SchemaSnapshot } from "@metaobjectsdev/migrate-ts";
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

describe("FR-044 reporting nodes are inert in codegen", () => {
  test("the with-model really carries the vocabulary (else every check below is vacuous)", () => {
    const reports = withReporting.objects().filter((o) => o.subType === "report");
    expect(reports.map((o) => o.name).sort()).toEqual(["DailyRevenue", "ProgramEngagement", "StoreTotals"]);
    expect(withoutReporting.objects().some((o) => o.subType === "report")).toBe(false);
  });

  const catalog = composeCatalog();
  for (const [name, entry] of Object.entries(catalog)) {
    test(`generator "${name}" emits the same files with and without reporting nodes`, async () => {
      const expected = await emit(withoutReporting, [entry.factory()]);
      const actual = await emit(withReporting, [entry.factory()]);
      expect(Object.keys(actual)).toEqual(Object.keys(expected));
      expect(actual).toEqual(expected);
    });
  }

  test("every runnable generator in ONE run emits the same files (barrels see the whole suite)", async () => {
    // A generator that cannot run from a bare model (shared-model needs a `files`
    // selection, render-helper a template root) throws in both variants above, which is
    // equal and so passes; it would sink the whole combined run, so it sits this one out.
    const runnable: string[] = [];
    for (const [name, entry] of Object.entries(catalog)) {
      const alone = await emit(withoutReporting, [entry.factory()]);
      if (!("<threw>" in alone)) runnable.push(name);
    }
    const suite = (): Generator[] => runnable.map((n) => catalog[n]!.factory());
    const expected = await emit(withoutReporting, suite());
    const actual = await emit(withReporting, suite());
    expect(expected["<threw>"]).toBeUndefined();
    expect(Object.keys(expected).length).toBeGreaterThan(10);
    expect(Object.keys(actual)).toEqual(Object.keys(expected));
    expect(actual).toEqual(expected);
  });
});

describe("FR-044 reporting nodes are inert in migrate", () => {
  test("the expected postgres schema is identical, and diff() proposes no statement", async () => {
    const withSchema: SchemaSnapshot = buildExpectedSchema(withReporting, { dialect: "postgres" });
    const withoutSchema: SchemaSnapshot = buildExpectedSchema(withoutReporting, { dialect: "postgres" });
    expect(withSchema).toEqual(withoutSchema);

    // Live DB = the model without reporting nodes; metadata = the model with them.
    const forward = await diff(withSchema, withoutSchema, { dialect: "postgres" });
    expect(forward.changes).toEqual([]);
    // And from an empty database, the report adds nothing to what the entities need.
    const empty: SchemaSnapshot = { tables: [], views: [] };
    const fromEmptyWith = await diff(withSchema, empty, { dialect: "postgres" });
    const fromEmptyWithout = await diff(withoutSchema, empty, { dialect: "postgres" });
    expect(fromEmptyWith.changes).toEqual(fromEmptyWithout.changes);
  });
});

describe("FR-044 reporting nodes are inert in meta docs", () => {
  /** Run `meta docs` over a project holding one variant, once per surface flag set, and
   *  read back everything written. The project directory has the SAME basename for both
   *  variants: the site stamps it into every page title. */
  async function docsOutput(variant: "with" | "without"): Promise<Record<string, string>> {
    const parent = mkdtempSync(join(tmpdir(), "reporting-inert-docs-"));
    const root = join(parent, "shop");
    try {
      mkdirSync(join(root, "metaobjects"), { recursive: true });
      copyFileSync(join(MODELS, variant, "meta.shop.json"), join(root, "metaobjects", "meta.shop.json"));
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

  test("the api surface is identical", async () => {
    // `meta docs --api` materializes only with a loadable gen config, which a temp project
    // cannot import; so drive the generator with the GenContext `meta docs` builds.
    const api = async (metadata: MetaRoot): Promise<Record<string, string>> => {
      const ctx: GenContext = {
        entities: metadata.objects(),
        loadedRoot: metadata,
        matches: () => true,
        config: { outDir: "docs", extStyle: "none", dbImport: "", dialect: "sqlite", outputLayout: "flat" } as never,
        renderContext: makeRenderContext({
          dialect: "sqlite", loadedRoot: metadata, outDir: "docs", dbImport: "", apiPrefix: "",
          pkMap: buildPkMap(metadata), relationMap: buildRelationMap(metadata),
        }),
        projectRoot: MODELS,
        warn: () => {},
      };
      const out: Record<string, string> = {};
      for (const f of await apiDocsFile({ subDir: "api" }).generate(ctx)) out[f.path] = f.content;
      return out;
    };
    const expected = await api(withoutReporting);
    const actual = await api(withReporting);
    expect(Object.keys(expected).length).toBeGreaterThan(2);
    expect(Object.keys(actual)).toEqual(Object.keys(expected));
    expect(actual).toEqual(expected);
  });
});
