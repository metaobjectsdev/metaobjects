// ADR-0034 Amendment 8 — `meta eject` hands over the template modules a reference calls.
//
// This file holds the MECHANISM: the scanner that finds a module's specifiers, the closure
// walk, the rewrite, and the writer. What the mechanism must achieve for every real
// generator — nothing outside the engine is imported, the copy typechecks as an adopter's
// project does, and it writes what the packaged generator writes — is
// eject-templates-contract.test.ts, derived from the catalog.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { ENGINE_MODULES } from "@metaobjectsdev/codegen-ts";
import {
  ejectTemplates,
  importRefs,
  OWNED_TEMPLATES_DIR,
  predatesTemplateHandOver,
  templateClosure,
  templateCopyStatus,
  templateDiffCommand,
  type OwnedFile,
  type PackageSource,
} from "../src/lib/template-eject.js";

// ---------------------------------------------------------------------------------------
// the scanner
// ---------------------------------------------------------------------------------------

const specs = (source: string): string[] => importRefs(source).map((r) => r.spec);

describe("importRefs — the specifiers in a module's leading import block", () => {
  test("every form a codegen module uses", () => {
    expect(
      specs(
        [
          'import "side-effect";',
          'import def from "default";',
          'import def2, { a, type B as C } from "mixed";',
          'import * as ns from "namespace";',
          'import type { T } from "type-only";',
          'import { type U, v } from "inline-type";',
          'export * from "star";',
          'export * as ex from "star-as";',
          'export { a as b } from "named";',
          'export type { Q } from "type-export";',
          "",
        ].join("\n"),
      ),
    ).toEqual([
      "side-effect", "default", "mixed", "namespace", "type-only", "inline-type",
      "star", "star-as", "named", "type-export",
    ]);
  });

  test("a clause that spans lines and carries comments with quotes, braces and the word from", () => {
    const source = [
      "import {",
      '  a, // not a real `import { x } from "nope"`',
      "  /* } from 'nope' */ b,",
      "  type C,",
      '} from "real";',
      "import { d } from '../single.js'",
      "const after = 1;",
      "",
    ].join("\n");
    expect(specs(source)).toEqual(["real", "../single.js"]);
  });

  test("the offsets are those of the specifier text, so a rewrite touches nothing else", () => {
    const source = 'import { a } from "./x.js";\nimport b from \'../y.js\';\n';
    for (const r of importRefs(source)) expect(source.slice(r.start, r.end)).toBe(r.spec);
  });

  test("the block ends at the first statement that is not an import", () => {
    // Text that LOOKS like an import inside a template literal is the reason this is a
    // scanner and not a regular expression over the whole file.
    const source = [
      'import { a } from "./real.js";',
      "",
      "/** doc */",
      "export function f(): string {",
      '  return `import { b } from "./inside-a-template.js";`;',
      "}",
      'import { c } from "./after-code.js";',
      "",
    ].join("\n");
    expect(specs(source)).toEqual(["./real.js"]);
  });

  test("a local export, a dynamic import and import.meta end the block", () => {
    expect(specs('import { a } from "a";\nexport { local };\nimport { b } from "b";\n')).toEqual(["a"]);
    expect(specs('import { a } from "a";\nexport const x = 1;\nimport { b } from "b";\n')).toEqual(["a"]);
    expect(specs('import { a } from "a";\nconst m = import("lazy");\nimport { b } from "b";\n')).toEqual(["a"]);
    expect(specs('import { a } from "a";\nimport.meta.url;\n')).toEqual(["a"]);
    expect(specs('import { a } from "a";\nexport type X = 1;\nimport { b } from "b";\n')).toEqual(["a"]);
  });

  test("a file with no imports, and an empty one", () => {
    expect(specs("export const a = 1;\n")).toEqual([]);
    expect(specs("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// the closure, over a package small enough to read
// ---------------------------------------------------------------------------------------

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "mo-template-eject-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function write(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

const CORE = "@metaobjectsdev/codegen-ts";
const UI = "@metaobjectsdev/codegen-ts-react";
const packages = (): PackageSource[] => [
  { name: CORE, srcRoot: join(root, "core/src") },
  { name: UI, srcRoot: join(root, "ui/src") },
];
const ENGINE = new Set(["codegen-ts/src/names.ts"]);

function fixture(): void {
  write("core/src/names.ts", "export const n = 1;\n");
  write(
    "core/src/reference/gen.ts",
    [
      "// REFERENCE TEMPLATE",
      'import { n } from "@metaobjectsdev/codegen-ts";',
      'import { renderA } from "../templates/a.js";',
      'import { fromCube } from "../cube/c.js";',
      "export const gen = [n, renderA, fromCube];",
      "",
    ].join("\n"),
  );
  write(
    "core/src/templates/a.ts",
    [
      'import { code } from "ts-poet";',
      'import { n } from "../names.js";',
      'import { b } from "./b.js";',
      "export const renderA = [code, n, b];",
      "",
    ].join("\n"),
  );
  write(
    "core/src/templates/b.ts",
    [
      "export const b = 1;",
      'export const text = `import { z } from "../not-a-module.js";`;',
      "",
    ].join("\n"),
  );
  write(
    "core/src/cube/c.ts",
    ['import { renderA } from "../templates/a.js";', "export const fromCube = renderA;", ""].join("\n"),
  );
  write(
    "ui/src/reference/ui.ts",
    [
      "// REFERENCE TEMPLATE",
      'import type { Generator } from "@metaobjectsdev/codegen-ts";',
      'import { renderU } from "../templates/u.js";',
      "export const ui = renderU;",
      "",
    ].join("\n"),
  );
  write(
    "ui/src/templates/u.ts",
    [
      'import { renderA } from "@metaobjectsdev/codegen-ts/templates/a";',
      'import { toon } from "@toon-format/toon";',
      "export const renderU = [renderA, toon];",
      "",
    ].join("\n"),
  );
}

const byPath = (files: readonly OwnedFile[]): Record<string, string> =>
  Object.fromEntries(files.map((f) => [f.path, f.content]));

describe("templateClosure — what is copied, where, and what each copy imports", () => {
  test("copies the emit modules a reference reaches and stops at the engine", () => {
    fixture();
    const [core] = packages();
    const closure = templateClosure(packages(), core!, "gen", ENGINE);
    expect(closure.generator.path).toBe("codegen/generators/gen.ts");
    expect(closure.templates.map((f) => f.path)).toEqual([
      "codegen/templates/a.ts",
      "codegen/templates/b.ts",
      "codegen/templates/cube/c.ts",
    ]);
    // The engine module is not among them, and says where it came from for everything else.
    expect(closure.templates.map((f) => f.origin)).toEqual([
      "codegen-ts/src/templates/a.ts",
      "codegen-ts/src/templates/b.ts",
      "codegen-ts/src/cube/c.ts",
    ]);
  });

  test("rewrites module specifiers and nothing else", () => {
    fixture();
    const [core] = packages();
    const closure = templateClosure(packages(), core!, "gen", ENGINE);
    const files = byPath([closure.generator, ...closure.templates]);

    // The reference reaches a `templates/` renderer by path, which is already the spelling
    // the copy needs, and the engine by the package. A module from another directory of the
    // package lands under `templates/` too, so that one specifier moves with it.
    expect(files["codegen/generators/gen.ts"]).toBe(
      readFileSync(join(root, "core/src/reference/gen.ts"), "utf8").replace("../cube/c.js", "../templates/cube/c.js"),
    );
    // An engine module → the package entry; ts-poet → the package's own, never a second copy;
    // a sibling stays a sibling.
    expect(files["codegen/templates/a.ts"]).toBe(
      [
        'import { code } from "@metaobjectsdev/codegen-ts";',
        'import { n } from "@metaobjectsdev/codegen-ts";',
        'import { b } from "./b.js";',
        "export const renderA = [code, n, b];",
        "",
      ].join("\n"),
    );
    // Text that looks like an import, in a template literal, is emitted text. It is not touched.
    expect(files["codegen/templates/b.ts"]).toBe(readFileSync(join(root, "core/src/templates/b.ts"), "utf8"));
    // A module in another directory of the package lands under `templates/<dir>/`, and its
    // path to a template module follows.
    expect(files["codegen/templates/cube/c.ts"]).toContain('from "../a.js"');
  });

  test("a reference in another package reaches the core package's emit code by path", () => {
    fixture();
    const [, ui] = packages();
    const closure = templateClosure(packages(), ui!, "ui", ENGINE);
    expect(closure.templates.map((f) => f.path)).toEqual([
      "codegen/templates/a.ts",
      "codegen/templates/b.ts",
      "codegen/templates/u.ts",
    ]);
    const files = byPath(closure.templates);
    expect(files["codegen/templates/u.ts"]).toContain('from "./a.js"');
    // What the copies import from outside the project: the packages, and a third-party one.
    expect(closure.packages).toEqual(["@metaobjectsdev/codegen-ts", "@toon-format/toon"]);
  });

  test("a copy that would need a file the package does not ship is refused by name", () => {
    fixture();
    write("core/src/templates/b.ts", 'import data from "./data.json";\nexport const b = data;\n');
    const [core] = packages();
    expect(() => templateClosure(packages(), core!, "gen", ENGINE)).toThrow(
      /codegen-ts\/src\/templates\/b\.ts imports "\.\/data\.json", which is not a module of @metaobjectsdev\/codegen-ts/,
    );
  });

  test("two modules that would land on one path are refused", () => {
    fixture();
    write("ui/src/templates/a.ts", "export const a = 1;\n");
    write(
      "ui/src/reference/ui.ts",
      '// REFERENCE TEMPLATE\nimport { a } from "../templates/a.js";\nimport { renderU } from "../templates/u.js";\nexport const ui = [a, renderU];\n',
    );
    const [, ui] = packages();
    expect(() => templateClosure(packages(), ui!, "ui", ENGINE)).toThrow(
      /codegen-ts-react\/src\/templates\/a\.ts and codegen-ts\/src\/templates\/a\.ts would both be copied to codegen\/templates\/a\.ts/,
    );
  });

  test("a generator that calls no template module has no templates", () => {
    write("core/src/reference/lone.ts", 'import { n } from "@metaobjectsdev/codegen-ts";\nexport const lone = n;\n');
    const [core] = packages();
    const closure = templateClosure(packages(), core!, "lone", ENGINE);
    expect(closure.templates).toEqual([]);
    expect(closure.generator.content).toContain("export const lone");
  });
});

// ---------------------------------------------------------------------------------------
// the writer
// ---------------------------------------------------------------------------------------

describe("ejectTemplates — never overwrites a file without force", () => {
  test("creates, then preserves, then replaces", async () => {
    fixture();
    const [core] = packages();
    const closure = templateClosure(packages(), core!, "gen", ENGINE);
    const project = join(root, "project");

    const first = await ejectTemplates(project, [closure], false);
    expect(first.files.map((f) => [f.path, f.status])).toEqual([
      ["codegen/templates/a.ts", "created"],
      ["codegen/templates/b.ts", "created"],
      ["codegen/templates/cube/c.ts", "created"],
    ]);
    expect(readFileSync(join(project, "codegen/templates/a.ts"), "utf8")).toBe(closure.templates[0]!.content);

    // The adopter changes one; a second eject leaves it, and says how it differs.
    writeFileSync(join(project, "codegen/templates/b.ts"), "// MINE\nexport const b = 2;\n");
    const second = await ejectTemplates(project, [closure], false);
    expect(second.files.every((f) => f.status === "preserved")).toBe(true);
    expect(second.files.find((f) => f.path === "codegen/templates/a.ts")?.comparison?.verdict).toBe("identical");
    expect(second.files.find((f) => f.path === "codegen/templates/b.ts")?.comparison?.verdict).toBe("differs");
    expect(readFileSync(join(project, "codegen/templates/b.ts"), "utf8")).toContain("// MINE");

    const forced = await ejectTemplates(project, [closure], true);
    expect(forced.files.every((f) => f.status === "replaced")).toBe(true);
    expect(readFileSync(join(project, "codegen/templates/b.ts"), "utf8")).not.toContain("// MINE");
  });

  test("two generators that call one module share one copy", async () => {
    fixture();
    write("core/src/reference/gen2.ts", 'import { renderA } from "../templates/a.js";\nexport const gen2 = renderA;\n');
    const [core] = packages();
    const one = templateClosure(packages(), core!, "gen", ENGINE);
    const two = templateClosure(packages(), core!, "gen2", ENGINE);
    const result = await ejectTemplates(join(root, "project"), [one, two], false);
    expect(result.files.map((f) => f.path)).toEqual([
      "codegen/templates/a.ts",
      "codegen/templates/b.ts",
      "codegen/templates/cube/c.ts",
    ]);
  });
});

describe("predatesTemplateHandOver — a kept copy from before the hand-over", () => {
  test("is told from the new shape by what it imports", () => {
    fixture();
    const [core] = packages();
    const closure = templateClosure(packages(), core!, "gen", ENGINE);
    // The 1.0 shape: the renderer came from the package entry.
    expect(predatesTemplateHandOver('import { renderA } from "@metaobjectsdev/codegen-ts";\n', closure)).toBe(true);
    expect(predatesTemplateHandOver(closure.generator.content, closure)).toBe(false);
    // A generator with nothing to hand over predates nothing.
    write("core/src/reference/lone.ts", 'import { n } from "@metaobjectsdev/codegen-ts";\nexport const lone = n;\n');
    const lone = templateClosure(packages(), core!, "lone", ENGINE);
    expect(predatesTemplateHandOver("// anything\n", lone)).toBe(false);
  });
});

describe("templateCopyStatus — how the project's copies compare to the package", () => {
  test("identical, reformatted, differs, and a file the package would not write", async () => {
    fixture();
    const [core] = packages();
    const closure = templateClosure(packages(), core!, "gen", ENGINE);
    const project = join(root, "project");
    await ejectTemplates(project, [closure], false);
    const upstream = new Map(closure.templates.map((f) => [f.path, f]));

    writeFileSync(join(project, "codegen/templates/b.ts"), "// MINE\nexport const b = 2;\n");
    writeFileSync(
      join(project, "codegen/templates/cube/c.ts"),
      'import {\n  renderA,\n} from "../a.js";\n\nexport const fromCube = renderA;\n',
    );
    writeFileSync(join(project, "codegen/templates/extra.ts"), "export const extra = 1;\n");

    const rows = await templateCopyStatus(project, upstream);
    expect(rows.map((r) => [r.path, r.verdict])).toEqual([
      ["codegen/templates/a.ts", "identical"],
      ["codegen/templates/b.ts", "differs"],
      ["codegen/templates/cube/c.ts", "reformatted"],
      ["codegen/templates/extra.ts", "not-in-package"],
    ]);
    // The diff command names the packaged module the copy came from.
    expect(templateDiffCommand(rows[1]!)).toBe(
      "diff -u node_modules/@metaobjectsdev/codegen-ts/src/templates/b.ts codegen/templates/b.ts",
    );
    expect(templateDiffCommand(rows[3]!)).toBeUndefined();
    expect(await templateCopyStatus(join(root, "nowhere"), upstream)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// the real packages
// ---------------------------------------------------------------------------------------

const PACKAGES = resolve(import.meta.dirname, "..", "..");
const CODEGEN_DIRS = ["codegen-ts", "codegen-ts-react", "codegen-ts-tanstack"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...sourceFiles(abs));
    else if (entry.endsWith(".ts")) out.push(abs);
  }
  return out;
}

describe("the real codegen packages", () => {
  test("every module of the engine surface exists", () => {
    const missing = ENGINE_MODULES.filter((m) => {
      try {
        statSync(join(PACKAGES, m));
        return false;
      } catch {
        return true;
      }
    });
    expect(missing).toEqual([]);
  });

  test("the engine surface is listed once, in order", () => {
    expect(new Set(ENGINE_MODULES).size).toBe(ENGINE_MODULES.length);
    expect([...ENGINE_MODULES].sort()).toEqual([...ENGINE_MODULES]);
  });

  // The scanner is what decides which specifiers are rewritten, so it is held to the
  // compiler's own reading of every module that can be copied: each module of the three
  // packages that is not engine. A module with an import below its first statement, or any
  // form the scanner does not know, shows up here by name instead of as an unrewritten
  // specifier in an adopter's project.
  test("the scanner reads every import statement the compiler reads, in every module that can be copied", () => {
    const engine = new Set(ENGINE_MODULES);
    const problems: string[] = [];
    let scanned = 0;
    for (const dir of CODEGEN_DIRS) {
      for (const file of sourceFiles(join(PACKAGES, dir, "src"))) {
        const key = relative(PACKAGES, file).split("\\").join("/");
        if (engine.has(key)) continue;
        const text = readFileSync(file, "utf8");
        const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2023, true);
        const expected: string[] = [];
        for (const statement of sf.statements) {
          if (
            (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
            statement.moduleSpecifier !== undefined &&
            ts.isStringLiteral(statement.moduleSpecifier)
          ) {
            expected.push(statement.moduleSpecifier.text);
          }
        }
        scanned++;
        if (JSON.stringify(specs(text)) !== JSON.stringify(expected)) {
          problems.push(`${key}: scanner [${specs(text).join(", ")}], compiler [${expected.join(", ")}]`);
        }
      }
    }
    expect(scanned).toBeGreaterThan(100);
    expect(problems).toEqual([]);
  });

  test("a module that is copied never imports a dynamic specifier or an import type", () => {
    // The scanner reads the leading block only, so these two forms would pass unrewritten.
    const engine = new Set(ENGINE_MODULES);
    const found: string[] = [];
    for (const dir of CODEGEN_DIRS) {
      for (const file of sourceFiles(join(PACKAGES, dir, "src"))) {
        const key = relative(PACKAGES, file).split("\\").join("/");
        if (engine.has(key)) continue;
        const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2023, true);
        const visit = (node: ts.Node): void => {
          if (ts.isImportTypeNode(node)) found.push(`${key}: import("…") type`);
          else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            found.push(`${key}: dynamic import()`);
          }
          ts.forEachChild(node, visit);
        };
        visit(sf);
      }
    }
    expect(found).toEqual([]);
  });

  test("the copy lands under the directory the docs name", () => {
    expect(OWNED_TEMPLATES_DIR).toBe("codegen/templates");
  });
});
