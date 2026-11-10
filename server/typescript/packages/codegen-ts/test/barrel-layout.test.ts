// rc.19 R63: the default outputLayout is "package", so generated modules move under
// <outDir>/<package path>/. Imports through the generated barrel (index.ts) are unaffected: the
// barrel exports the same names in both layouts, and a consumer importing from it type-checks
// against either. Pinned here because the CHANGELOG's upgrade note says so.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import { InMemoryStringSource, MetaDataLoader, type MetaObject } from "@metaobjectsdev/metadata";
import { entityFile } from "../src/generators/entity-file.js";
import { queriesFile } from "../src/generators/queries-file.js";
import { barrel } from "../src/generators/barrel.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import { resolveTargets } from "../src/metaobjects-config.js";
import type { EmittedFile, GenContext } from "../src/generator.js";
import type { OutputLayout } from "../src/import-path.js";

const pk = { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } };
const MODEL = { "metadata.root": { package: "acme::blog", children: [
  { "object.entity": { name: "Author", children: [
    { "source.rdb": { "@table": "authors" } },
    { "field.long": { name: "id" } },
    { "field.string": { name: "name", "@required": true } },
    pk,
  ] } },
  { "object.entity": { name: "Post", children: [
    { "source.rdb": { "@table": "posts" } },
    { "field.long": { name: "id" } },
    { "field.long": { name: "authorId", "@required": true } },
    { "field.string": { name: "title", "@required": true } },
    pk,
    { "identity.reference": { name: "author", "@fields": "authorId", "@references": "Author" } },
  ] } },
] } };

async function generate(layout: OutputLayout | undefined): Promise<EmittedFile[]> {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(MODEL))]);
  expect(errors).toEqual([]);
  // The layout a project gets when it declares none is what resolveTargets resolves.
  const outputLayout = resolveTargets({ outDir: "/x", dbImport: "~/db", dialect: "sqlite", generators: [],
    ...(layout !== undefined ? { outputLayout: layout } : {}) } as never).default!.outputLayout;
  const renderContext = makeRenderContext({ outputLayout,
    dialect: "sqlite", loadedRoot: root, outDir: "/x", dbImport: "~/db",
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
  });
  const genCtx = (g: { filter?: (e: MetaObject) => boolean }): GenContext => ({
    entities: root.objects(), loadedRoot: root, matches: (e) => g.filter?.(e) ?? true, projectRoot: "/x",
    config: { outputLayout, outDir: "/x", extStyle: "none", dbImport: "~/db", dialect: "sqlite" } as never,
    renderContext, warn: () => {},
  });
  const generators = [entityFile({ allowlists: false }), queriesFile(), barrel()];
  return (await Promise.all(generators.map((g) => g.generate(genCtx(g))))).flat();
}

const CONSUMER = `
import { type Author, type Post, authors, posts } from "./generated";
export const tables = [authors, posts];
export function title(p: Post, a: Author): string { return p.title + " by " + a.name; }
`;

function compile(files: EmittedFile[]): string[] {
  const dir = mkdtempSync(join(import.meta.dir, "tmp-barrel-layout-"));
  try {
    for (const f of files) {
      mkdirSync(dirname(join(dir, "generated", f.path)), { recursive: true });
      writeFileSync(join(dir, "generated", f.path), f.content);
    }
    writeFileSync(join(dir, "db.ts"), "export type Db = any;\nexport const db: Db = undefined;\n");
    writeFileSync(join(dir, "consumer.ts"), CONSUMER);
    const program = ts.createProgram([join(dir, "consumer.ts")], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true,
      baseUrl: dir, paths: { "~/db": ["./db.ts"] },
    });
    return ts.getPreEmitDiagnostics(program).map((d) =>
      `${d.file?.fileName.slice(dir.length + 1) ?? ""} ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("R63 — the package layout is the default, and the barrel hides it", () => {
  test("with no outputLayout declared, modules sit under their package directory", async () => {
    const paths = (await generate(undefined)).map((f) => f.path).sort();
    expect(paths).toContain("acme/blog/Post.ts");
    expect(paths).toContain("index.ts");
    expect(paths.filter((p) => p !== "index.ts").every((p) => p.startsWith("acme/blog/"))).toBe(true);
  });

  test("the barrel exports the same names in both layouts", async () => {
    const names = (files: EmittedFile[]) => [...files.find((f) => f.path === "index.ts")!.content
      .matchAll(/export \* from "([^"]+)"/g)].map((m) => m[1]!.split("/").pop()).sort();
    expect(names(await generate(undefined))).toEqual(names(await generate("flat")));
  });

  test("a consumer importing through the barrel type-checks against either layout", async () => {
    expect(compile(await generate("flat"))).toEqual([]);
    expect(compile(await generate(undefined))).toEqual([]);
  }, 60_000);
});
