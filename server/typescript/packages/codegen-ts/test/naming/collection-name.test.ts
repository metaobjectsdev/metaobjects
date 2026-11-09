// rc.19 (R57) — @collectionName names an object's collection everywhere a port derives one: the
// REST segment, the TS list/finder exports and the Drizzle collection variable, and the reverse
// @via hop other objects walk. Absent, the project's pluralizer (`naming.collections`) derives
// it. @dbSetName is its deprecated alias for one release.

import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  MetaDataLoader, InMemoryStringSource, collectionNameOf, pluralizer, registerPluralizer,
  resetNamingStrategiesForTesting, reverseHopName, type MetaRoot,
} from "@metaobjectsdev/metadata";
import { runGen } from "../../src/runner.js";
import { defineConfig } from "../../src/metaobjects-config.js";
import { entityFile } from "../../src/generators/entity-file.js";
import { queriesFile } from "../../src/generators/queries-file.js";
import { routesFile } from "../../src/generators/routes-file.js";

type Json = Record<string, unknown>;

const model = (historyAttrs: Json): Json => ({
  "metadata.root": {
    package: "acme",
    children: [
      { "object.entity": { name: "Case", children: [
        { "source.rdb": { "@table": "cases" } },
        { "field.long": { name: "id" } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } },
      ] } },
      { "object.entity": { name: "CaseHistory", ...historyAttrs, children: [
        { "source.rdb": { "@table": "case_history" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "caseId" } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } },
        { "identity.reference": { name: "caseId", "@fields": "caseId", "@references": "Case" } },
      ] } },
    ],
  },
});

async function load(historyAttrs: Json = {}): Promise<MetaRoot> {
  const res = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(model(historyAttrs)), { id: "m.json", format: "json" })]);
  expect(res.errors).toEqual([]);
  return res.root;
}

async function gen(root: MetaRoot): Promise<{ files: Map<string, string>; warnings: string[] }> {
  const tmp = mkdtempSync(join(tmpdir(), "mo-collection-"));
  try {
    const { warnings } = await runGen({
      config: defineConfig({
        outDir: join(tmp, "src"), extStyle: "js", dbImport: "../db", dialect: "sqlite", outputLayout: "flat",
        generators: [entityFile(), queriesFile(), routesFile()],
      }),
      metadata: root, projectRoot: tmp,
    });
    const files = new Map<string, string>();
    const src = join(tmp, "src");
    if (existsSync(src)) {
      for (const e of readdirSync(src, { recursive: true, withFileTypes: true })) {
        if (e.isFile()) files.set(relative(src, join(e.parentPath, e.name)), readFileSync(join(e.parentPath, e.name), "utf8"));
      }
    }
    return { files, warnings };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const history = (root: MetaRoot) => root.objects().find((o) => o.name === "CaseHistory")!;

afterEach(() => resetNamingStrategiesForTesting());

describe("@collectionName", () => {
  test("absent, the standard pluralizer derives it", async () => {
    const root = await load();
    expect(collectionNameOf(history(root))).toBe("CaseHistories");
    expect(reverseHopName(history(root))).toBe("caseHistories");
  });

  test("names the REST segment, the list and finder exports, the collection variable and the reverse hop", async () => {
    const root = await load({ "@collectionName": "CaseHistory" });
    expect(reverseHopName(history(root))).toBe("caseHistory");
    const { files, warnings } = await gen(root);
    const queries = files.get("CaseHistory.queries.ts")!;
    expect(queries).toContain("export async function listCaseHistory(");
    expect(queries).toContain("export async function findCaseHistoryByCase(");
    expect(queries).toContain(".from(caseHistory)");
    expect(files.get("CaseHistory.ts")!).toContain("export const caseHistory = ");
    expect([...files.values()].join("\n")).toContain('"/case_history"');
    expect(warnings.filter((w) => w.includes("deprecated"))).toEqual([]);
  });

  test("@dbSetName is its deprecated alias: the same names, and a warning", async () => {
    const root = await load({ "@dbSetName": "CaseHistory" });
    const { files, warnings } = await gen(root);
    expect(files.get("CaseHistory.queries.ts")!).toContain("export async function listCaseHistory(");
    expect(warnings.some((w) => w.includes("@dbSetName is deprecated") && w.includes("@collectionName"))).toBe(true);
  });

  test("declaring both is refused", async () => {
    const root = await load({ "@collectionName": "CaseHistory", "@dbSetName": "Histories" });
    expect(() => collectionNameOf(history(root))).toThrow(/declares both @collectionName and @dbSetName/);
  });
});

describe("the pluggable pluralizer (naming.collections)", () => {
  test("the built-ins: standard and none", () => {
    expect(pluralizer("standard")("Category")).toBe("Categories");
    expect(pluralizer("none")("Category")).toBe("Category");
  });

  test("the project's pluralizer names every object without @collectionName", async () => {
    const root = await load();
    Object.assign(root, { physicalNaming: { ...root.physicalNaming, collections: "none" } });
    expect(collectionNameOf(history(root))).toBe("CaseHistory");
    const { files } = await gen(root);
    expect(files.get("Case.queries.ts")!).toContain("export async function listCase(");
  });

  test("an application registers its own", async () => {
    registerPluralizer("latin", (n) => (n.endsWith("History") ? n.slice(0, -1) + "ies" : n + "s"));
    const root = await load();
    Object.assign(root, { physicalNaming: { ...root.physicalNaming, collections: "latin" } });
    expect(collectionNameOf(history(root))).toBe("CaseHistories");
  });

  test("an unknown name fails loudly, naming the built-ins", () => {
    expect(() => pluralizer("klingon")).toThrow(/"naming.collections" names "klingon".*built in: standard, none/);
  });

  test("a built-in cannot be replaced", () => {
    expect(() => registerPluralizer("standard", (n) => n)).toThrow(/built in/);
  });
});
