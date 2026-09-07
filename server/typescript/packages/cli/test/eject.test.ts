// FR-040 §4.2(a) — eject copies a reference template into the consumer's repo so they
// own it, for any generator in any package, at any time after init.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ejectGenerator, ejectableNames } from "../src/commands/eject.js";
import { Biome, Distribution } from "@biomejs/js-api";

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

// An owned copy is the one artifact ADR-0034 hands an adopter and then never speaks about
// again. On the public reference app, three of them were ~five minor lines behind the
// engine they ran against — carrying a bare `ts-poet` import (the 0.21.6 split-tree
// defect), the pre-#248 subtype persistability check, and a missing `isWriteThrough`
// branch — with every gate green, because nothing compares an owned copy to anything.
// `meta eject` said only "already exists — left untouched", which answers a question
// nobody has.
// A stand-in for "the adopter ran their own formatter". Deliberately the REAL Biome —
// with settings this repo does not use (tabs, a 120-column width, single quotes) — plus
// the import-specifier sort that `organizeImports` performs, since `formatContent` does
// not reorder. A hand-rolled reformat is not usable here: re-indenting every line also
// rewrites the interiors of the `code` template literals this template emits, which is
// a CONTENT change, and the comparison is right to call that `differs`.
async function reformatAsAnotherProjectWould(src: string): Promise<string> {
  const biome = await Biome.create({ distribution: Distribution.NODE });
  biome.applyConfiguration({
    formatter: { enabled: true, indentStyle: "tab", lineWidth: 120 },
    javascript: { formatter: { quoteStyle: "single", semicolons: "always" } },
  });
  // Anchored at column 0, so the emitted `import { eq } from "drizzle-orm"` lines INSIDE
  // the template literals (always indented) are left alone. Sorted LINE-wise and kept
  // multi-line, which is what organizeImports does: a specifier's trailing comment
  // travels with it. Flattening the block instead detaches the comment onto a line of
  // its own, which is a real content change and rightly reads as `differs`.
  const sorted = src.replace(
    /^(import (?:type )?\{\n)([\s\S]*?)(\n\} from "[^"]+";)$/gm,
    (_m, open: string, inner: string, close: string) =>
      open + inner.split("\n").sort().join("\n") + close,
  );
  const result = biome.formatContent(sorted, { filePath: "in-memory.ts" });
  expect(result.diagnostics).toEqual([]);
  return result.content;
}

describe("meta eject reports how the owned copy compares to the reference", () => {
  async function own(name: string, mutate?: (src: string) => string | Promise<string>): Promise<void> {
    await ejectGenerator({ cwd, name });
    if (mutate) {
      const p = join(cwd, `codegen/generators/${name}.ts`);
      await writeFile(p, await mutate(await readFile(p, "utf8")), "utf8");
    }
  }

  test("an untouched copy reports identical", async () => {
    await own("queries");
    const r = await ejectGenerator({ cwd, name: "queries" });
    expect(r.status).toBe("preserved");
    expect(r.comparison).toEqual({ verdict: "identical", localOnly: 0, referenceOnly: 0 });
  });

  test("a customized copy reports differs, and in which direction", async () => {
    await own("queries", (s) => `${s}\n// my own line\n// and another\n`);
    const r = await ejectGenerator({ cwd, name: "queries" });
    expect(r.status).toBe("preserved");
    expect(r.comparison?.verdict).toBe("differs");
    expect(r.comparison?.localOnly).toBe(2);
    // added lines only — nothing of the reference is missing, so it is not BEHIND
    expect(r.comparison?.referenceOnly).toBe(0);
  });

  test("a copy the reference has moved past reports how far BEHIND it is", async () => {
    // The direction that matters for staleness, and the one the byte comparison never
    // reported: upstream gained lines this copy does not have. Deleting from the copy
    // is the same shape as upstream adding to the reference.
    await own("queries", (s) => s.split("\n").filter((l) => !l.includes("export const queriesFile")).join("\n"));
    const r = await ejectGenerator({ cwd, name: "queries" });
    expect(r.comparison?.verdict).toBe("differs");
    expect(r.comparison?.referenceOnly).toBeGreaterThan(0);
  });

  test("a REFORMATTED copy is not reported as differing", async () => {
    // The defect this comparison exists for. A project that runs its own formatter over
    // the code it owns had every copy reading DIFFERS forever, with a line count made
    // almost entirely of re-wrapping and import order — so the one signal that says
    // "you have fallen behind upstream" was noise on every project that formats.
    //
    // Each mutation below is one thing a formatter does and nothing a human means:
    // re-order the import specifiers, collapse the indentation, and re-wrap.
    await own("queries", (src) => reformatAsAnotherProjectWould(src));
    const r = await ejectGenerator({ cwd, name: "queries" });
    expect(r.status).toBe("preserved");
    expect(r.comparison?.verdict).toBe("reformatted");
    expect(r.comparison?.localOnly).toBe(0);
    expect(r.comparison?.referenceOnly).toBe(0);
  });

  test("--force over a DIFFERING copy reports what it destroyed", async () => {
    // This is the step that silently destroys an adopter's customization — and the
    // file's own header is often the only record the customization was deliberate.
    await own("queries", (s) => `${s}\n// deliberate: trimmed to read-only finders\n`);
    const r = await ejectGenerator({ cwd, name: "queries", force: true });
    expect(r.status).toBe("replaced");
    expect(r.comparison?.verdict).toBe("differs");
    expect(r.comparison?.localOnly).toBe(1);
    // and it really did replace it
    expect(await readFile(join(cwd, "codegen/generators/queries.ts"), "utf8"))
      .not.toContain("deliberate: trimmed");
  });

  test("--force over an IDENTICAL copy is a replace with nothing lost", async () => {
    await own("queries");
    const r = await ejectGenerator({ cwd, name: "queries", force: true });
    expect(r.status).toBe("replaced");
    expect(r.comparison?.verdict).toBe("identical");
  });

  test("a first eject reports no comparison at all", async () => {
    const r = await ejectGenerator({ cwd, name: "barrel" });
    expect(r.status).toBe("created");
    expect(r.comparison).toBeUndefined();
  });
});
