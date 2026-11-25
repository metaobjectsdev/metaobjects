// The TypeScript runner of `fixtures/docs-page-conformance/` — the shared corpus that pins the
// requirements pages and the model-only schema page for every port (plan G0, design call 17).
//
// TypeScript is the SOURCE of the expected bytes: each case's `expected/` is what the
// TypeScript builders and the shared templates produce from the case's `input/`, and this
// runner fails the moment they disagree. Every other port runs the same cases against its
// own builders and the same templates. `expected/data/` pins what each template is FED, so a
// port can tell a builder defect (wrong data) from a render defect (right data, wrong bytes).
// `expected/rows/` pins the layer below that (D0a): the ledger rows and the model-only schema
// rows each page is built from, in the shapes the docs site reads too.
//
// The schema page pinned here is the MODEL-ONLY one (`physical: false`): the page a port
// without the expected schema writes. TypeScript builds its input from the expected schema
// and then leaves out every fact only that schema knows, so the bytes are exactly what a port
// computes from the model with its own naming helpers. The README lists what is left out.
//
// Regenerate after an intended change: `UPDATE_DOCS_PAGE_FIXTURES=1 bun test
// test/docs-page-conformance.test.ts`, then review the diff — it is the cross-port contract.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { InMemoryStringSource, MetaDataLoader, physicalNamingOf } from "@metaobjectsdev/metadata";
import type { MetaRoot } from "@metaobjectsdev/metadata";
import { resolveSchemaConventions } from "@metaobjectsdev/migrate-ts";
import {
  agentRequirementsPageData,
  agentSchemaPageData,
  renderAgentRequirementsPage,
  renderAgentSchemaPage,
  renderRequirementsMarkdown,
  renderRequirementsToon,
  requirementRows,
  requirementsLedgerData,
  requirementsToonData,
  schemaInputFromRows,
  schemaRows,
} from "@metaobjectsdev/codegen-ts";
import { buildAgentSchemaInput } from "../src/lib/agent-schema.js";

const CORPUS = resolve(import.meta.dir, "../../../../../fixtures/docs-page-conformance/cases");
const UPDATE = process.env.UPDATE_DOCS_PAGE_FIXTURES === "1";

async function load(dir: string): Promise<MetaRoot> {
  const files = readdirSync(dir).filter((f) => /^meta\..*\.json$/.test(f)).sort();
  const res = await new MetaDataLoader().load(
    files.map((f) => new InMemoryStringSource(readFileSync(join(dir, f), "utf8"), { id: f, format: "json" })),
  );
  expect(res.errors).toEqual([]);
  return res.root;
}

/** Every pinned output of one case, by path under `expected/`. An absent page is no entry. */
async function outputsOf(root: MetaRoot, migrate: boolean): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

  const rows = requirementRows(root);
  if (rows.length > 0) {
    out.set("requirements.md", renderRequirementsMarkdown(rows));
    out.set("requirements.toon", renderRequirementsToon(rows));
    out.set("data/requirements.md.json", json(requirementsLedgerData(rows)));
    out.set("data/requirements.toon.json", json(requirementsToonData(rows)));
    // The rows layer (D0a): what both requirements pages, and the docs site, are built from.
    out.set("rows/requirements.json", json(rows));
  }
  const agentRequirements = agentRequirementsPageData(root);
  if (agentRequirements !== undefined) {
    out.set("agent/requirements.md", renderAgentRequirementsPage(root));
    out.set("data/agent-requirements.md.json", json(agentRequirements));
  }

  // The schema the TypeScript toolchain builds; the dialect only feeds what the model-only
  // page leaves out, so the page does not depend on it.
  const schema = buildAgentSchemaInput(root, "postgres", () => {}, {
    conventions: resolveSchemaConventions(undefined),
    skipRedundantChecks: false,
    foreignKeyIndexes: false,
    foreignKeyTargets: "refuse",
  }, migrate);
  if (schema !== undefined) {
    const naming = physicalNamingOf(root).columns;
    const data = agentSchemaPageData(root, schema, naming, { physical: false });
    if (data !== undefined) {
      out.set("agent/schema.md", renderAgentSchemaPage(root, schema, naming, { physical: false }));
      out.set("data/agent-schema.md.json", json(data));
      // The rows layer (D0a). The page data must follow from the rows and the model alone:
      // that is all a port without the expected schema has.
      const rowsLayer = schemaRows(schema);
      out.set("rows/schema.json", json(rowsLayer));
      expect(agentSchemaPageData(root, schemaInputFromRows(rowsLayer, migrate), naming, { physical: false })).toEqual(data);
    }
  }
  return out;
}

/** The case chose a `meta migrate` dialect: its `input/.metaobjects/config.json` sets
 *  `migrate.dialect`. Feeds the schema page's `hasMigrate`. */
function choseMigrateDialect(inputDir: string): boolean {
  const path = join(inputDir, ".metaobjects", "config.json");
  if (!existsSync(path)) return false;
  const config = JSON.parse(readFileSync(path, "utf8")) as { migrate?: { dialect?: string } };
  return config.migrate?.dialect !== undefined;
}

function expectedOf(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  const walk = (d: string, prefix: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name), `${prefix}${e.name}/`);
      else out.set(`${prefix}${e.name}`, readFileSync(join(d, e.name), "utf8"));
    }
  };
  walk(dir, "");
  return out;
}

const cases = readdirSync(CORPUS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

describe("docs-page-conformance", () => {
  test("the corpus is not empty", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const name of cases) {
    test(name, async () => {
      const caseDir = join(CORPUS, name);
      const actual = await outputsOf(await load(join(caseDir, "input")), choseMigrateDialect(join(caseDir, "input")));
      const expectedDir = join(caseDir, "expected");
      if (UPDATE) {
        rmSync(expectedDir, { recursive: true, force: true });
        for (const [path, content] of actual) {
          mkdirSync(dirname(join(expectedDir, path)), { recursive: true });
          writeFileSync(join(expectedDir, path), content);
        }
      }
      const expected = expectedOf(expectedDir);
      // The SET of pages is pinned too: a page one port writes and another does not is drift.
      expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
      for (const [path, content] of expected) expect({ path, content: actual.get(path) }).toEqual({ path, content });
    });
  }
});
