// §A1/§A2/§A6 — namesFile() itself is executed by no other test: reference-byte-identical.test.ts
// covers it end-to-end through five fixtures via runGen, but that gate proves parity with
// the reference template, not the generator's own contract. This file is that direct check:
// a sourced entity emits `<Entity>.names.ts`, a sourceless object emits nothing (#248), and
// the generator declares the markers the runner and eventual consumers key off of.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { runGen, defineConfig } from "../../src/index.js";
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
});
