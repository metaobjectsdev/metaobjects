// The docs pages and the docs site share one row shape (1.3.0 D0a).
//
// `fixtures/docs-page-conformance/` pins a ROWS layer under each page's data: the requirement
// ledger rows, and the model-only schema rows. The docs-design ruling is that the site reuses
// those rows rather than pinning a second shape for the same facts. This file holds that to
// the two sources the site actually reads:
//
// - the requirement rows are what the docs view (`explorer.json`, `buildDocsView`) already
//   holds, field for field;
// - the schema rows are a literal subset of `meta schema --as json` (the `serializeSnapshot`
//   format), the storage lens's input.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { InMemoryStringSource, MetaDataLoader, buildDocsView, type DocsView } from "@metaobjectsdev/metadata";
import type { MetaRoot } from "@metaobjectsdev/metadata";
import { requirementRows, type RequirementRow, type SchemaRows } from "@metaobjectsdev/codegen-ts";
import { resolveSchemaConventions, serializeSnapshot } from "@metaobjectsdev/migrate-ts";
import { buildAgentSchemaInput } from "../src/lib/agent-schema.js";

const FIXTURES = resolve(import.meta.dir, "../../../../../fixtures");
const CORPUS = join(FIXTURES, "docs-page-conformance/cases");
const SHOP = join(FIXTURES, "explorer-conformance/shop");

async function load(files: { id: string; text: string }[]): Promise<MetaRoot> {
  const res = await new MetaDataLoader().load(
    files.map((f) => new InMemoryStringSource(f.text, { id: f.id, format: "json" })),
  );
  expect(res.errors).toEqual([]);
  return res.root;
}

function metaFiles(dir: string): { id: string; text: string }[] {
  return readdirSync(dir)
    .filter((f) => /^meta\..*\.json$/.test(f))
    .sort()
    .map((f) => ({ id: f, text: readFileSync(join(dir, f), "utf8") }));
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** The requirement rows as the docs site would read them off the docs view. */
function rowsFromView(view: DocsView): RequirementRow[] {
  return view.requirements.map((r) => ({
    path: r.address,
    depth: r.depth,
    title: str(r.title),
    subType: r.subType,
    level: r.level ?? undefined,
    status: r.status,
    disposition: str(r.disposition),
    trackedBy: r.trackedBy,
    statement: str(r.statement),
    counterexample: str(r.counterexample),
    description: str(r.description),
    implementedBy: r.implementedBy.map((l) => l.ref),
    claimedConcerns: [...new Set(r.implementedBy.filter((l) => l.resolves).map((l) => l.target.kind))],
  }));
}

/** True when every key of `part` is in `whole` with an equal value (arrays: element-wise). */
function isSubset(part: unknown, whole: unknown): boolean {
  if (Array.isArray(part)) {
    return Array.isArray(whole) && part.length === whole.length && part.every((p, i) => isSubset(p, whole[i]));
  }
  if (typeof part === "object" && part !== null) {
    if (typeof whole !== "object" || whole === null || Array.isArray(whole)) return false;
    const w = whole as Record<string, unknown>;
    return Object.entries(part).every(([k, v]) => k in w && isSubset(v, w[k]));
  }
  return part === whole;
}

const byName = <T extends { name: string }>(list: readonly T[]): Map<string, T> => new Map(list.map((x) => [x.name, x]));

describe("docs page rows are the docs site's rows", () => {
  test("requirement rows equal what the docs view holds (explorer-conformance/shop)", async () => {
    const root = await load(metaFiles(join(SHOP, "project/metaobjects")));
    const view = buildDocsView({ root, verify: JSON.parse(readFileSync(join(SHOP, "verify.json"), "utf8")) as unknown });
    const fromModel = requirementRows(root);
    expect(fromModel.length).toBeGreaterThan(0);
    // JSON round trip: absent keys and `undefined` values compare the same, as they do on disk.
    expect(JSON.parse(JSON.stringify(rowsFromView(view)))).toEqual(JSON.parse(JSON.stringify(fromModel)));
  });

  const cases = readdirSync(CORPUS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  for (const name of cases) {
    const pinned = join(CORPUS, name, "expected/rows/schema.json");
    let rows: SchemaRows | undefined;
    try {
      rows = JSON.parse(readFileSync(pinned, "utf8")) as SchemaRows;
    } catch {
      continue; // a case with no schema page pins no schema rows
    }
    test(`${name}: the schema rows are a subset of meta schema --as json`, async () => {
      const root = await load(metaFiles(join(CORPUS, name, "input")));
      const schema = buildAgentSchemaInput(root, "postgres", () => {}, {
        conventions: resolveSchemaConventions(undefined),
        skipRedundantChecks: false,
        foreignKeyIndexes: false,
        foreignKeyTargets: "refuse",
      }, false); // the migrate choice only words the page; the rows do not depend on it
      expect(schema).toBeDefined();
      const file = JSON.parse(
        serializeSnapshot({ tables: [...(schema?.tables ?? [])], views: [...(schema?.views ?? [])] } as never),
      ) as { snapshot: { tables: { name: string; columns: { name: string }[]; foreignKeys: unknown[] }[]; views: { name: string }[] } };
      const tables = byName(file.snapshot.tables);
      for (const t of rows?.tables ?? []) {
        const whole = tables.get(t.name);
        expect({ table: t.name, found: whole !== undefined }).toEqual({ table: t.name, found: true });
        const { columns, foreignKeys, ...rest } = t;
        expect({ table: t.name, ok: isSubset(rest, whole) }).toEqual({ table: t.name, ok: true });
        const cols = byName(whole?.columns ?? []);
        for (const c of columns) expect({ column: `${t.name}.${c.name}`, ok: isSubset(c, cols.get(c.name)) }).toEqual({ column: `${t.name}.${c.name}`, ok: true });
        // A foreign key is matched by its key, not its (dialect) constraint name.
        for (const fk of foreignKeys) {
          expect({ fk: `${t.name}:${fk.columns.join(",")}`, ok: (whole?.foreignKeys ?? []).some((w) => isSubset(fk, w)) })
            .toEqual({ fk: `${t.name}:${fk.columns.join(",")}`, ok: true });
        }
      }
      const views = byName(file.snapshot.views);
      for (const v of rows?.views ?? []) expect({ view: v.name, ok: isSubset(v, views.get(v.name)) }).toEqual({ view: v.name, ok: true });
    });
  }
});
