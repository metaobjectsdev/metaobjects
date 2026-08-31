// FR-040 §4.2(a) — eject copies a reference template into the consumer's repo so they
// own it, for any generator in any package, at any time after init.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ejectGenerator, ejectableNames } from "../src/commands/eject.js";

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "mo-eject-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

describe("meta eject", () => {
  test("writes a UI-tier template and reports the local import line", async () => {
    const r = await ejectGenerator({ cwd, name: "form" });
    expect(r.status).toBe("created");
    const src = await readFile(join(cwd, "codegen/generators/form.ts"), "utf8");
    expect(src).toContain("REFERENCE TEMPLATE");
    expect(r.importLine).toContain('from "./codegen/generators/form.js"');
  });

  test("ejects a server-tier template from codegen-ts too", async () => {
    const r = await ejectGenerator({ cwd, name: "routes-hono" });
    expect(r.status).toBe("created");
    expect(await readFile(join(cwd, "codegen/generators/routes-hono.ts"), "utf8"))
      .toContain("// targets:");
  });

  test("never clobbers a hand-edited generator", async () => {
    await mkdir(join(cwd, "codegen/generators"), { recursive: true });
    await writeFile(join(cwd, "codegen/generators/form.ts"), "// MINE\n", "utf8");
    const r = await ejectGenerator({ cwd, name: "form" });
    expect(r.status).toBe("preserved");
    expect(await readFile(join(cwd, "codegen/generators/form.ts"), "utf8")).toBe("// MINE\n");
  });

  test("an unknown name errors and lists what IS ejectable", async () => {
    await expect(ejectGenerator({ cwd, name: "nope" })).rejects.toThrow(/form|hooks|entity/);
  });

  // Fix round 1: only 2 of the 9 templates (form, routes-hono) were exercised through
  // `extractImportLine`'s header-parsing path above — a header reformat to any of the
  // other 7 (e.g. Task 6 adding a `targets:` line to entity/queries/routes/barrel)
  // could silently break `meta eject` for that name with nothing turning red. Derives
  // the name list from `ejectableNames()` (the same source `--list` reads) rather than
  // hardcoding nine strings, so this test can't go stale either.
  test("every ejectable template has a parseable, non-empty import line", async () => {
    const names = ejectableNames();
    expect(names.length).toBeGreaterThan(0); // guards against a registry regression hiding the loop below
    for (const name of names) {
      const r = await ejectGenerator({ cwd, name, force: true });
      expect(r.importLine).toMatch(/^import \{ \w+ \} from "\.\/codegen\/generators\/[\w.-]+\.js";$/);
      // The regex alone would pass on a wrong-but-well-formed line (e.g. the wrong
      // symbol) — pin the path segment to the name actually ejected, so a header
      // whose import line names a DIFFERENT file (copy-paste drift between templates)
      // is caught too.
      expect(r.importLine).toContain(`/codegen/generators/${name}.js`);
    }
  });

  // Fix round 2. Ejecting is only complete if the config actually ends up importing the
  // LOCAL copy. Every template but the five `meta init` scaffolds is already imported in
  // a working config from its package, so the instruction has to be REPLACE — told to
  // "paste", a reader either duplicates the identifier or, worse, leaves both imports
  // and keeps the generator entry bound to the PACKAGE one, silently running the
  // packaged generator while editing the ejected file.
  test("reports the exact binding to replace, and where it currently comes from", async () => {
    const r = await ejectGenerator({ cwd, name: "grid" });
    // grid.ts exports tanstackGrid — the symbol does NOT follow the file name, which is
    // why this is derived from the template's own import line rather than the name.
    expect(r.exportName).toBe("tanstackGrid");
    expect(r.packageName).toBe("@metaobjectsdev/codegen-ts-tanstack");
  });

  test("the reported export name always matches the template's own import line", async () => {
    for (const name of ejectableNames()) {
      const r = await ejectGenerator({ cwd, name, force: true });
      expect(r.importLine).toBe(`import { ${r.exportName} } from "./codegen/generators/${name}.js";`);
    }
  });

  // An ejected file is ordinary source in the adopter's repo: its imports must be
  // DECLARED or their `tsc` reports TS2307 on the file we just told them they own.
  // `meta init` adds the two packages its five scaffolded generators need; the UI
  // templates import two more that nothing declares, so eject has to say so.
  test("names the @metaobjectsdev packages the ejected file needs but the project lacks", async () => {
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "p", private: true }), "utf8");
    const r = await ejectGenerator({ cwd, name: "form" });
    const notes = r.dependencyNotes.join("\n");
    expect(notes).toContain("@metaobjectsdev/codegen-ts-react");
    expect(notes).toContain("npm i -D");
  });

  test("says nothing about dependencies the project already declares", async () => {
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({
        name: "p",
        private: true,
        devDependencies: {
          "@metaobjectsdev/codegen-ts": "^0.24.4",
          "@metaobjectsdev/codegen-ts-react": "^0.24.4",
          "@metaobjectsdev/metadata": "^0.24.4",
        },
      }),
      "utf8",
    );
    const r = await ejectGenerator({ cwd, name: "form" });
    expect(r.dependencyNotes).toEqual([]);
  });

  // Fix round 3. The question is "will this resolve", not "is it in one particular
  // field". A library consuming MetaObjects through peerDependencies — the correct
  // declaration for a package whose consumer supplies the version — had every one of
  // them reported missing and was told to install what it already had; following that
  // advice adds a competing copy, which is the class-identity split this repo has been
  // bitten by twice (ts-poet, and the metadata node guards).
  test("counts peer and optional dependencies as declared, not missing", async () => {
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({
        name: "p",
        private: true,
        peerDependencies: {
          "@metaobjectsdev/codegen-ts": "^0.24.4",
          "@metaobjectsdev/codegen-ts-react": "^0.24.4",
        },
        optionalDependencies: { "@metaobjectsdev/metadata": "^0.24.4" },
      }),
      "utf8",
    );
    const r = await ejectGenerator({ cwd, name: "form" });
    expect(r.dependencyNotes).toEqual([]);
  });

  // Fix round 3. The matcher required the closing quote straight after the package name,
  // so a SUBPATH import matched nothing and produced no note at all —
  // `@metaobjectsdev/metadata/constants` is a real documented subpath (the browser-safe
  // pure-constants entry, added because a value import from the root barrel dragged
  // node:url into browser bundles). A template gaining one would silently lose its note,
  // which is the drift reading imports from the file is supposed to prevent.
  test("a subpath import still names its package", async () => {
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "p", private: true }), "utf8");
    const r = await ejectGenerator({ cwd, name: "form" });
    // Prove it on the real function rather than a hand-built string, so this cannot
    // pass against a regex the product does not use.
    const { dependencyNotesForTemplate } = await import("../src/commands/eject.js");
    const notes = await dependencyNotesForTemplate(
      cwd,
      'import { X } from "@metaobjectsdev/metadata/constants";\n',
    );
    expect(notes.join("\n")).toContain("@metaobjectsdev/metadata");
    expect(notes.join("\n")).not.toContain("/constants");
    expect(r.path).toBe("codegen/generators/form.ts");
  });
});
