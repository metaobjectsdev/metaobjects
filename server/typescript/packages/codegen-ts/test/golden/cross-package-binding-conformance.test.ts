// Cross-port conformance (TS — the reference) for ADR-0059 Decision 7: codegen binds the
// object a reference names, never a same-short-named object and never the object an
// inheritor's package would pick. Loads the shared fixture
// `fixtures/codegen-conformance/cross-package-binding/input/`, checks every binding against
// the port-neutral decision table beside it (`expected-bindings.json`), and checks the
// generated entity, queries and routes modules import the bound target's module.
//
// The fixture loads the wrong candidate first (`a::Tag` before `b::Tag`, `acme::Customer`
// before the root `Customer`), so a short-name lookup or a re-resolve in `acme` binds it.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import {
  MetaDataLoader,
  InMemoryStringSource,
  IDENTITY_REFERENCE_ATTR_REFERENCES,
  isMetaObject,
  isMetaSource,
  refTarget,
  type MetaObject,
  type MetaRoot,
} from "@metaobjectsdev/metadata";
import { runGen, defineConfig } from "../../src/index.js";
import { entityFile } from "../../src/generators/entity-file.js";
import { queriesFile } from "../../src/generators/queries-file.js";
import { routesFile } from "../../src/generators/routes-file.js";
import { buildRelationMap } from "../../src/relation-resolver.js";

function findRepoRoot(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, "fixtures")) && existsSync(join(dir, "server"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("could not locate repo root from " + start);
    dir = parent;
  }
}

const FIXTURE = join(findRepoRoot(import.meta.dir), "fixtures", "codegen-conformance", "cross-package-binding");

interface RelationRow {
  cardinality: "one" | "many";
  target: string;
  targetTable: string;
  fkField?: string;
  junction?: string;
  junctionTable?: string;
  sourceJoinField?: string;
  targetJoinField?: string;
}

const table: { relations: Record<string, RelationRow>; references: Record<string, string> } = JSON.parse(
  readFileSync(join(FIXTURE, "expected-bindings.json"), "utf-8"),
);

async function loadFixture(): Promise<MetaRoot> {
  const dir = join(FIXTURE, "input");
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => new InMemoryStringSource(readFileSync(join(dir, f), "utf-8"), { id: f, format: "json" }));
  const res = await new MetaDataLoader().load(sources);
  expect(res.errors, "the cross-package-binding fixture must load cleanly").toEqual([]);
  return res.root;
}

/** `pkg::Owner.member` → the top-level object and the member name. */
function split(key: string): { owner: string; member: string } {
  const dot = key.lastIndexOf(".");
  return { owner: key.slice(0, dot), member: key.slice(dot + 1) };
}

function objectByKey(root: MetaRoot, key: string): MetaObject {
  const obj = root.objects().find((o) => o.resolutionKey() === key);
  if (obj === undefined) throw new Error(`no object ${key}`);
  return obj;
}

function tableOf(obj: MetaObject): string | undefined {
  // ADR-0039: resolving — a source may be inherited.
  const source = obj.children().find(isMetaSource);
  const t = source?.attr("table");
  return typeof t === "string" ? t : undefined;
}

describe("cross-package binding conformance (TS)", () => {
  test("every identity.reference binds the object the decision table names", async () => {
    const root = await loadFixture();
    for (const [key, expected] of Object.entries(table.references)) {
      const { owner, member } = split(key);
      const ref = objectByKey(root, owner).referenceIdentities().find((r) => r.name === member);
      expect(ref, key).toBeDefined();
      expect(refTarget(ref!, IDENTITY_REFERENCE_ATTR_REFERENCES)?.resolutionKey(), key).toBe(expected);
    }
  });

  test("the relation map binds every relationship's target, junction, tables and join fields", async () => {
    const root = await loadFixture();
    const map = buildRelationMap(root);
    for (const [key, row] of Object.entries(table.relations)) {
      const { owner, member } = split(key);
      const source = objectByKey(root, owner);
      const entry = (map.get(source.name) ?? []).find((e) => e.name === member);
      expect(entry, key).toBeDefined();
      expect(entry!.cardinality, key).toBe(row.cardinality);
      expect(entry!.target.resolutionKey(), key).toBe(row.target);
      expect(tableOf(entry!.target), key).toBe(row.targetTable);
      if (row.cardinality === "one") {
        expect(entry!.fkField, key).toBe(row.fkField);
      } else {
        expect(isMetaObject(entry!.junction) ? entry!.junction.resolutionKey() : undefined, key).toBe(row.junction);
        expect(tableOf(entry!.junction!), key).toBe(row.junctionTable);
        expect(entry!.sourceJoinField, key).toBe(row.sourceJoinField);
        expect(entry!.targetJoinField, key).toBe(row.targetJoinField);
      }
    }
  });

  test("generated modules import the bound target's module, never the wrong same-named one", async () => {
    const root = await loadFixture();
    const tmp = mkdtempSync(join(tmpdir(), "xpkg-binding-"));
    const files: Record<string, string> = {};
    try {
      await runGen({
        config: defineConfig({
          outDir: tmp,
          outputLayout: "package",
          extStyle: "none",
          dbImport: "~/db",
          dialect: "postgres",
          generators: [entityFile(), queriesFile(), routesFile()],
        }),
        metadata: root,
      });
      const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else if (name.endsWith(".ts")) files[relative(tmp, full)] = readFileSync(full, "utf-8");
        }
      };
      walk(tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }

    // a::Post — the M:N route and the to-one relation reach b::Tag's module.
    const postRoutes = files[join("a", "Post.routes.ts")];
    expect(postRoutes, Object.keys(files).join(", ")).toBeDefined();
    expect(postRoutes).toContain('from "../b/Tag"');
    expect(postRoutes).not.toContain('from "./Tag"');
    const post = files[join("a", "Post.ts")]!;
    expect(post).toContain('from "../b/Tag"');
    expect(post).not.toContain('from "./Tag"');
    // b::Tag's key is a long; a::Tag's is a string. The reverse finder takes the bound type.
    const postQueries = files[join("a", "Post.queries.ts")]!;
    expect(postQueries).toContain("featuredTagId: number");

    // acme::Order inherits root BaseOrder's bare `Customer` / `Label`: both mean the root ones.
    const orderRoutes = files[join("acme", "Order.routes.ts")]!;
    expect(orderRoutes).toContain('from "../Label"');
    expect(orderRoutes).not.toContain('from "./Label"');
    const order = files[join("acme", "Order.ts")]!;
    expect(order).toContain('from "../Customer"');
    expect(order).not.toContain('from "./Customer"');
  });
});
