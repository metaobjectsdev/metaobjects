// fixtures/codegen-conformance/xpkg-value-object-refs/ (TypeScript lane). One generated file meets
// two same-named types from two packages: `acme::app::Host` holds `acme::alpha::Note` and
// `acme::beta::Note`, and the callable wrapper for `acme::app::Summary` takes its arguments object
// `acme::alpha::Summary`. Nothing is renamed (ruling R52): under the package layout each file
// binds the pair under package-qualified local aliases, and the whole output type-checks.

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { runGen } from "../src/runner.js";
import { defineConfig } from "../src/metaobjects-config.js";
import { entityFile } from "../src/generators/entity-file.js";
import { routesFile } from "../src/generators/routes-file.js";
import { callableFile } from "../src/generators/callable-file.js";
import { ERR_NAME_COLLISION } from "../src/naming/name-claims.js";

const CORPUS = resolve(import.meta.dir, "../../../../../fixtures/codegen-conformance/xpkg-value-object-refs/input");
const TEMP_DIRS: string[] = [];
afterAll(() => { for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true }); });

async function load() {
  const res = await new MetaDataLoader().load(
    readdirSync(CORPUS).sort().map((f) => new FileSource(join(CORPUS, f))),
  );
  expect(res.errors).toEqual([]);
  return res.root;
}

async function gen(outputLayout: "flat" | "package"): Promise<{ dir: string; files: Map<string, string> }> {
  // Under the package dir, so the output resolves drizzle-orm, zod and runtime-ts.
  const dir = mkdtempSync(join(import.meta.dir, "xpkg-vo-refs-"));
  TEMP_DIRS.push(dir);
  await runGen({
    config: defineConfig({
      outDir: dir, extStyle: "js", dbImport: "./db", dialect: "postgres", outputLayout,
      generators: [entityFile(), callableFile(), routesFile()],
    }),
    metadata: await load(),
  });
  const files = new Map<string, string>();
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) files.set(relative(dir, join(e.parentPath, e.name)), readFileSync(join(e.parentPath, e.name), "utf8"));
  }
  return { dir, files };
}

describe("xpkg-value-object-refs", () => {
  test("under the flat layout the same-named pairs share one module directory and are refused", async () => {
    await expect(gen("flat")).rejects.toThrow(new RegExp(`${ERR_NAME_COLLISION}.*"(Note|Summary)" in the module directory`));
  });

  test("under the package layout every file binds the pair under local aliases, and it type-checks", async () => {
    const { dir, files } = await gen("package");
    const host = files.get("acme/app/Host.ts")!;
    expect(host).toMatch(/type Note as AcmeAlphaNote[\s\S]*?\} from "\.\.\/alpha\/Note\.js";/);
    expect(host).toMatch(/type Note as AcmeBetaNote[\s\S]*?\} from "\.\.\/beta\/Note\.js";/);
    const callable = files.get("acme/app/Summary.callable.ts")!;
    expect(callable).toContain('import type { Summary as AcmeAlphaSummary } from "../alpha/Summary.js";');
    expect(callable).toContain("args: AcmeAlphaSummary");
    expect(callable).toContain('type Summary } from "./Summary.js"');

    // Only the NAME-binding diagnostics are this corpus's concern: a duplicate or conflicting
    // import, a missing export, an unresolved relative module or name. The rest (the routes'
    // fastify / runtime-ts peer types, drizzle's row typing) is environment, which is why
    // the codegen-compile conformance lane leaves routes out too.
    const NAME_CODES = new Set([2300, 2304, 2305, 2307, 2440, 2724]);
    const roots = [...files.keys()].map((f) => join(dir, f));
    const program = ts.createProgram(roots, {
      noEmit: true, strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program)
      .filter((d) => NAME_CODES.has(d.code))
      .map((d) => `${d.file ? relative(dir, d.file.fileName) : "?"}: TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`)
      // The routes import the adopter's db singleton and fastify, which this test does not provide.
      .filter((m) => !/'(\.\.\/)*\.?\/?db\.js'|'fastify'/.test(m));
    expect(diagnostics).toEqual([]);
  });
});
