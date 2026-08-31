// §A1/§A2/§A6 — namesFile() itself is executed by no other test: reference-byte-identical.test.ts
// covers it end-to-end through five fixtures via runGen, but that gate proves parity with
// the reference template, not the generator's own contract. This file is that direct check:
// a sourced entity emits `<Entity>.names.ts`, a sourceless object emits nothing (#248), and
// the generator declares the markers the runner and eventual consumers key off of.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { runGen, defineConfig } from "../../src/index.js";
import { entityFile } from "../../src/generators/entity-file.js";
import { namesFile } from "../../src/generators/names-file.js";
import { GENERATED_HEADER } from "../../src/constants.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codegen-names-file-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function loadRoot(children: unknown[]) {
  const result = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: "acme::probe", children } })),
  ]);
  expect(result.errors).toEqual([]);
  return result.root;
}

const AUTHOR = {
  "object.entity": {
    name: "Author",
    children: [
      { "source.rdb": { "@table": "authors" } },
      { "field.string": { name: "id" } },
      { "identity.primary": { name: "pk", "@fields": "id" } },
    ],
  },
};

// Same entity, but declaring its `package` on the NODE rather than inheriting the file
// default. Object nodes keep `.package` undefined when the package is a file default
// (FR5d — `fqn()` stays bare), and every per-entity generator places output off
// `entity.package`, so a file-default fixture would render flat no matter what the layout
// says and could not see the placement bug at all.
const PACKAGED_AUTHOR = {
  "object.entity": {
    name: "Author",
    package: "acme::probe",
    children: [
      { "source.rdb": { "@table": "authors" } },
      { "field.string": { name: "id" } },
      { "identity.primary": { name: "pk", "@fields": "id" } },
    ],
  },
};

// A plain object.value — no identity, no source (ADR-0028 value purity). The generator's
// #248 branch (renderNamesDecl returns "" with no primary source) must emit nothing.
const STAMP = {
  "object.value": {
    name: "Stamp",
    children: [{ "field.string": { name: "label" } }],
  },
};

function genConfig(outDir: string) {
  return defineConfig({
    outDir,
    extStyle: "none",
    dbImport: "~/server/db",
    dialect: "postgres",
    generators: [namesFile()],
  });
}

describe("namesFile() generator", () => {
  test("declares the marker + name the runner and meta init key off of", () => {
    const gen = namesFile();
    expect(gen.name).toBe("names");
    expect(gen.emitsNames).toBe(true);
  });

  test("a sourced entity emits <Entity>.names.ts carrying the exported const", async () => {
    const root = await loadRoot([AUTHOR]);
    const out = await runGen({ config: genConfig(tmp), metadata: root });
    expect(out.warnings).toEqual([]);

    const at = (name: string) => join(tmp, name);
    const paths = new Set(out.files.map((f) => f.path));
    expect(paths.has(at("Author.names.ts"))).toBe(true);

    const content = readFileSync(at("Author.names.ts"), "utf8");
    expect(content).toContain("export const AuthorNames = {");
    // Every other generator's output carries the @generated header as line 1;
    // names.ts was the one exception until this test.
    expect(content.split("\n")[0]).toBe(`// ${GENERATED_HEADER} — DO NOT EDIT.`);
  });

  test("a sourceless object.value emits no names file (#248)", async () => {
    const root = await loadRoot([AUTHOR, STAMP]);
    const out = await runGen({ config: genConfig(tmp), metadata: root });
    expect(out.warnings).toEqual([]);

    const paths = new Set(out.files.map((f) => f.path));
    expect(paths.has(join(tmp, "Stamp.names.ts"))).toBe(false);
    expect(existsSync(join(tmp, "Stamp.names.ts"))).toBe(false);

    // Nothing beyond what runGen reported landed on disk either.
    expect(readdirSync(tmp).sort()).toEqual(["Author.names.ts"]);
  });

  // The names artifact DESCRIBES the entity module, and §A6 makes the entity module
  // IMPORT it — so the two have to land in the same directory. Every other per-entity
  // generator routes its path through entityOutputPath (entity-file.ts, queries-file.ts,
  // routes-file-hono.ts); this one emitted a bare filename, so under
  // outputLayout: "package" it landed at the target ROOT while its entity landed at
  // <pkg>/<Entity>.ts — an unresolvable import, and a conflicting-duplicate-path hard
  // failure the moment two packages declare a same-bare-named entity.
  //
  // No gate could see it: reference-byte-identical.test.ts runs its five fixtures through
  // a defineConfig that never sets outputLayout, and under "flat" a bare filename and
  // entityOutputPath(...) return the identical string.
  test("under outputLayout: 'package' the file lands beside its entity module", async () => {
    const root = await loadRoot([PACKAGED_AUTHOR]);
    const out = await runGen({
      config: defineConfig({
        outDir: tmp,
        extStyle: "none",
        dbImport: "~/server/db",
        dialect: "postgres",
        outputLayout: "package",
        // The entity generator rides along deliberately: the assertion is that the two
        // artifacts share a DIRECTORY, which is what makes the import resolvable. A bare
        // `expect(path).toBe(<literal>)` would pin one generator's answer to a hand-written
        // string and could pass while the pair still disagreed.
        generators: [entityFile(), namesFile()],
      }),
      metadata: root,
    });
    expect(out.warnings).toEqual([]);

    const byBase = new Map(out.files.map((f) => [basename(f.path), dirname(f.path)]));
    expect(byBase.get("Author.names.ts")).toBe(join(tmp, "acme/probe"));
    expect(byBase.get("Author.names.ts")).toBe(byBase.get("Author.ts"));
    expect(existsSync(join(tmp, "Author.names.ts"))).toBe(false);
  });
});
