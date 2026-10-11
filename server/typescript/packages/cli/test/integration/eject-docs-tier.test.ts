/**
 * The docs tier, owned — end to end, through the BUILT CLI (ADR-0034 Amendment 7).
 *
 * `docs` and `api-docs` could not be ejected while `meta docs` constructed the packaged
 * generators itself: there was nothing to hand an owned copy to. The seam is the docs
 * door's own config, `docs: { generators: [...] }`, read by a marker on the generator
 * (`docsSurface`). These tests drive it the way an adopter does — `meta eject`,
 * `metaobjects.config.ts`, `meta docs`, `meta verify --docs`, `meta gen` — because the
 * claim is about which command runs which copy, and no factory-level test can see that.
 *
 * The standalone `mermaid-er` generator that used to sit in this tier was removed in 1.1:
 * `meta docs` draws the diagrams. The last describe pins what a project that still wires
 * it is told, by name and by factory.
 *
 * Each gate is shown to FAIL as well as pass: an edited copy changes the page and the
 * drift check convicts the committed tree. A seam that only ever agreed with the packaged
 * generator would pass every equality here without running the copy at all.
 *
 * Subprocess-per-command for the reason `verify-codegen-ejected-generator` gives: the
 * config is re-read under a fresh name each load but the modules it imports are cached.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { meta, requireFreshDist } from "./support/built-cli.js";

const FIXTURES = resolve(import.meta.dirname, "..", "fixtures");
// Inside the workspace, so an ejected template's `@metaobjectsdev/codegen-ts` import
// resolves by walking up to the workspace root.
const WORKSPACE_TMP = join(FIXTURES, "__tmp__");
const OUT = "generated";
// The default `docs.outDir`: where `meta docs` writes and `verify --docs` reads.
const DOCS = join("docs", "generated");

/**
 * @param docsGenerators what goes in `docs: { generators: [...] }`, the docs door's list.
 * @param genGenerators  appended to the top-level `generators`, the array `meta gen` runs.
 */
function config(imports: readonly string[], docsGenerators: string, genGenerators = ""): string {
  return [
    `import { defineConfig } from "@metaobjectsdev/codegen-ts";`,
    `import { entityFile, routesFile } from "@metaobjectsdev/codegen-ts/generators";`,
    ...imports,
    `export default defineConfig({`,
    `  outDir: ${JSON.stringify(OUT)},`,
    `  dialect: "sqlite",`,
    `  dbImport: "~/db",`,
    `  extStyle: "none",`,
    `  apiPrefix: "/api",`,
    `  generators: [entityFile(), routesFile()${genGenerators}],`,
    ...(docsGenerators === "" ? [] : [`  docs: { generators: [${docsGenerators}] },`]),
    `});`,
  ].join("\n");
}

/** Nothing docs-related listed: `meta docs` runs the packaged generators. */
const PACKAGED = config([], "");

const OWNED_DOCS_IMPORT = `import { docsFile } from "./codegen/generators/docs.js";`;
const OWNED_API_IMPORT = `import { apiDocsFile } from "./codegen/generators/api-docs.js";`;
/** Both owned copies, listed exactly as `meta eject` prints. */
const OWNED_BOTH = config([OWNED_DOCS_IMPORT, OWNED_API_IMPORT], "docsFile(), apiDocsFile()");

function setupRepo(configSource: string): string {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(WORKSPACE_TMP, "docs-tier-"));
  cpSync(join(FIXTURES, "trainer-website-meta"), root, { recursive: true });
  writeFileSync(join(root, "metaobjects.config.ts"), configSource);
  // Its own repository. `verify --docs` skips a page the project git-ignores, and this
  // directory sits under an ignored path of the workspace it borrows `node_modules` from:
  // without a repository of its own every page here would be exempt and the gate would
  // have nothing to compare.
  expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
  return root;
}

/** Every file under `<root>/<dir>`, path → contents. Empty when the directory is absent. */
function tree(root: string, dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const base = join(root, dir);
  if (!existsSync(base)) return out;
  for (const f of readdirSync(base, { recursive: true, withFileTypes: true })) {
    if (!f.isFile()) continue;
    const abs = join(f.parentPath, f.name);
    out.set(abs.slice(base.length + 1), readFileSync(abs, "utf8"));
  }
  return out;
}

function edit(root: string, rel: string, from: string, to: string): void {
  const path = join(root, rel);
  const before = readFileSync(path, "utf8");
  // An edit that matched nothing would leave the copy unmodified and every "the edited
  // copy ran" assertion below would be testing the reference.
  expect(before).toContain(from);
  writeFileSync(path, before.replace(from, to));
}

// Precondition once per FILE, not per test: this gate runs the BUILT CLI.
beforeAll(requireFreshDist);

describe("docs and api-docs — owned copies run by `meta docs`", () => {
  test("unmodified owned copies write exactly the pages `meta docs` writes without them", async () => {
    const root = setupRepo(PACKAGED);
    try {
      expect(await meta(root, "docs")).toMatchObject({ exit: 0 });
      const packaged = tree(root, DOCS);
      // Vacuity guard: both surfaces are in the tree being compared.
      expect([...packaged.keys()]).toEqual(expect.arrayContaining(["README.md", "User.md", "api/README.md", "api/AGENT-API.md", "api/User.md"]));

      // Take ownership of both, changing nothing about them.
      expect(await meta(root, "eject", "docs", "api-docs")).toMatchObject({ exit: 0 });
      writeFileSync(join(root, "metaobjects.config.ts"), OWNED_BOTH);

      // The committed pages were written by the PACKAGE's generators. If the owned copies
      // would write anything else, this is where it shows.
      expect(await meta(root, "verify", "--docs")).toMatchObject({ exit: 0 });

      const owned = await meta(root, "docs");
      expect(owned).toMatchObject({ exit: 0 });
      // The summary names the copy, so "did mine run?" has an answer on the terminal.
      expect(owned.output).toContain("from the owned generator 'docs-file'");
      expect(owned.output).toContain("from the owned generator 'api-docs'");
      expect(tree(root, DOCS)).toEqual(packaged);

      // And back: dropping the unmodified copies is equally a no-op.
      writeFileSync(join(root, "metaobjects.config.ts"), PACKAGED);
      expect(await meta(root, "verify", "--docs")).toMatchObject({ exit: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  test("an edited model-docs copy is the one that runs, and `verify --docs` convicts the stale pages", async () => {
    const root = setupRepo(PACKAGED);
    try {
      expect(await meta(root, "docs")).toMatchObject({ exit: 0 });
      expect(tree(root, DOCS).get("README.md")).toStartWith("# Data Model\n");

      expect(await meta(root, "eject", "docs")).toMatchObject({ exit: 0 });
      writeFileSync(join(root, "metaobjects.config.ts"), config([OWNED_DOCS_IMPORT], "docsFile()"));
      edit(root, "codegen/generators/docs.ts", 'out.push("# Data Model");', 'out.push("# Our Model");');

      // The committed README still has the packaged title: the gate has to say so.
      const stale = await meta(root, "verify", "--docs");
      expect(stale.exit).toBe(1);
      expect(stale.output).toContain("README.md");

      expect(await meta(root, "docs")).toMatchObject({ exit: 0 });
      const pages = tree(root, DOCS);
      expect(pages.get("README.md")).toStartWith("# Our Model\n");
      // The api surface was not ejected: the packaged generator still writes it.
      expect(pages.has("api/AGENT-API.md")).toBe(true);
      expect(await meta(root, "verify", "--docs")).toMatchObject({ exit: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  test("an edited api-docs copy is the one that runs, with the model surface still packaged", async () => {
    const root = setupRepo(PACKAGED);
    try {
      expect(await meta(root, "docs")).toMatchObject({ exit: 0 });
      const before = tree(root, DOCS);
      expect(before.has("api/AGENT-API.md")).toBe(true);

      expect(await meta(root, "eject", "api-docs")).toMatchObject({ exit: 0 });
      writeFileSync(join(root, "metaobjects.config.ts"), config([OWNED_API_IMPORT], "apiDocsFile()"));
      // Own a decision the packaged generator does not offer: no agent form.
      edit(
        root,
        "codegen/generators/api-docs.ts",
        "          { path: agentFilename, content: renderAgentApi(model, provider) },\n",
        "",
      );

      // `meta docs` only writes, so the agent form written before the edit would still be
      // on disk. A fresh tree is what shows the copy ran: it no longer contains that file.
      rmSync(join(root, DOCS), { recursive: true, force: true });
      expect(await meta(root, "docs")).toMatchObject({ exit: 0 });
      const fresh = tree(root, DOCS);
      expect(fresh.has("api/AGENT-API.md")).toBe(false);
      // Everything else is untouched, the packaged model surface included.
      expect(fresh.get("api/User.md")).toBe(before.get("api/User.md"));
      expect(fresh.get("README.md")).toBe(before.get("README.md"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  test("an owned copy that fails to load stops `meta docs`: the pages are not rewritten by the packaged generator", async () => {
    const root = setupRepo(PACKAGED);
    try {
      expect(await meta(root, "eject", "docs")).toMatchObject({ exit: 0 });
      writeFileSync(join(root, "metaobjects.config.ts"), config([OWNED_DOCS_IMPORT], "docsFile()"));
      edit(root, "codegen/generators/docs.ts", 'out.push("# Data Model");', 'out.push("# Our Model");');
      expect(await meta(root, "docs")).toMatchObject({ exit: 0 });
      const owned = tree(root, DOCS);
      expect(owned.get("README.md")).toStartWith("# Our Model\n");

      // An error in the copy: the config imports it, so the config no longer loads.
      const copy = join(root, "codegen", "generators", "docs.ts");
      writeFileSync(copy, `${readFileSync(copy, "utf8")}\nthrow new Error("owned docs copy is broken");\n`);

      // `meta gen` is the reference for this failure: exit 2 and the load error.
      const gen = await meta(root, "gen", "--format", "text");
      expect(gen.exit).toBe(2);
      expect(gen.output).toContain("owned docs copy is broken");

      const docs = await meta(root, "docs");
      expect(docs.exit).toBe(2);
      expect(docs.output).toContain("owned docs copy is broken");
      // The packaged generator would have put "# Data Model" back.
      expect(tree(root, DOCS)).toEqual(owned);
      expect((await meta(root, "verify", "--docs")).exit).not.toBe(0);

      // And with no pages on disk, none are written.
      rmSync(join(root, DOCS), { recursive: true, force: true });
      expect((await meta(root, "docs")).exit).toBe(2);
      expect(existsSync(join(root, DOCS))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  test("a docs generator reads the project's own files through `ctx.inputRoot` under `meta docs`", async () => {
    // Hand-written, as the guide has an owned generator read a project file:
    // `join(ctx.inputRoot, <file>)`.
    const root = setupRepo(
      config([`import { titlePage } from "./codegen/generators/title-page.js";`], "titlePage()"),
    );
    try {
      mkdirSync(join(root, "codegen", "generators"), { recursive: true });
      writeFileSync(
        join(root, "codegen", "generators", "title-page.ts"),
        [
          `import { readFileSync } from "node:fs";`,
          `import { join } from "node:path";`,
          `import type { Generator } from "@metaobjectsdev/codegen-ts";`,
          `export const titlePage = (): Generator => ({`,
          `  name: "title-page",`,
          `  docsSurface: "model",`,
          `  generate: (ctx) => [`,
          `    { path: "README.md", content: "# " + readFileSync(join(ctx.inputRoot as string, "MODEL-TITLE"), "utf8") + "\\n" },`,
          `  ],`,
          `});`,
        ].join("\n"),
      );
      writeFileSync(join(root, "MODEL-TITLE"), "From The Project");

      // `--templates` repoints `ctx.projectRoot`. The project's files are not there.
      mkdirSync(join(root, "elsewhere"), { recursive: true });
      expect(await meta(root, "docs", "--templates", "elsewhere")).toMatchObject({ exit: 0 });
      expect(tree(root, DOCS).get("README.md")).toBe("# From The Project\n");
      expect(await meta(root, "verify", "--docs")).toMatchObject({ exit: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  test("`meta gen` is untouched by listed docs generators, and points a misplaced one at the docs door", async () => {
    const root = setupRepo(PACKAGED);
    try {
      expect(await meta(root, "eject", "docs", "api-docs")).toMatchObject({ exit: 0 });
      writeFileSync(join(root, "metaobjects.config.ts"), OWNED_BOTH);

      // Listed where they belong, the copies are none of `meta gen`'s business: it runs
      // what is in `generators`, writes no page, and has nothing to say about docs.
      const gen = await meta(root, "gen", "--format", "text");
      expect(gen).toMatchObject({ exit: 0 });
      expect(gen.output).not.toContain("docs generator");
      expect(gen.output).not.toContain("docs are produced by");
      const generated = [...tree(root, OUT).keys()];
      expect(generated).toContain("User.ts");
      expect(generated.filter((p) => p.endsWith(".md"))).toEqual([]);
      expect(existsSync(join(root, DOCS))).toBe(false);
      // The codegen drift gate regenerates through the same runner, so it is unaffected.
      expect(await meta(root, "verify", "--codegen")).toMatchObject({ exit: 0 });

      // The same copy in the array `meta gen` runs is in the wrong place. It is skipped,
      // and the warning names where it goes instead of leaving `meta docs` quietly
      // running the packaged generator.
      writeFileSync(join(root, "metaobjects.config.ts"), config([OWNED_DOCS_IMPORT], "", ", docsFile()"));
      const misplaced = await meta(root, "gen", "--format", "text");
      expect(misplaced).toMatchObject({ exit: 0 });
      expect(misplaced.output).toContain(
        "[docs-file] is a docs generator: 'meta docs' runs it, from `docs: { generators: [...] }`",
      );
      expect([...tree(root, OUT).keys()].filter((p) => p.endsWith(".md"))).toEqual([]);
      // And `meta docs` did not pick it up from there: the packaged generator ran.
      const docs = await meta(root, "docs");
      expect(docs).toMatchObject({ exit: 0 });
      expect(docs.output).not.toContain("from the owned generator");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  test("a `docs.generators` list `meta docs` cannot run is refused by name, by `meta docs` and by `verify --docs`", async () => {
    const root = setupRepo(PACKAGED);
    try {
      expect(await meta(root, "eject", "docs")).toMatchObject({ exit: 0 });

      // Two for one surface: each would write the same pages.
      writeFileSync(join(root, "metaobjects.config.ts"), config([OWNED_DOCS_IMPORT], "docsFile(), docsFile()"));
      const two = await meta(root, "docs");
      expect(two.exit).toBe(2);
      expect(two.output).toContain('`docs.generators` lists two generators for the model surface ("docs-file" and "docs-file")');
      expect(existsSync(join(root, DOCS))).toBe(false);
      expect((await meta(root, "verify", "--docs")).exit).not.toBe(0);

      // No marker: a generator `meta gen` runs, listed in the docs block by mistake. The
      // door has no surface to give it, so it neither runs it nor drops it.
      writeFileSync(
        join(root, "metaobjects.config.ts"),
        config([OWNED_DOCS_IMPORT], "docsFile(), entityFile()"),
      );
      const unmarked = await meta(root, "docs");
      expect(unmarked.exit).toBe(2);
      expect(unmarked.output).toContain('`docs.generators` lists "entity-file", which carries no `docsSurface`');
      expect(existsSync(join(root, DOCS))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("`meta eject --list` and `meta gen --list` treat the tier like every other ejectable generator", async () => {
    const root = setupRepo(PACKAGED);
    try {
      expect(await meta(root, "eject", "docs", "api-docs")).toMatchObject({ exit: 0 });
      edit(root, "codegen/generators/docs.ts", 'out.push("# Data Model");', 'out.push("# Our Model");');

      const list = await meta(root, "eject", "--list", "--format", "json");
      expect(list.exit).toBe(0);
      const rows = (JSON.parse(list.output) as { generators: Array<{ name: string; status: string }> }).generators;
      const status = (name: string) => rows.find((r) => r.name === name)?.status;
      expect(status("api-docs")).toBe("identical");
      expect(status("docs")).toBe("differs");
      expect(status("mermaid-er")).toBeUndefined();

      const catalog = await meta(root, "gen", "--list", "--format", "json");
      expect(catalog.exit).toBe(0);
      const catalogRows = JSON.parse(catalog.output) as Array<{
        name: string;
        source: { kind: string; ejectable: boolean; owned: boolean | null };
      }>;
      for (const name of ["docs", "api-docs"]) {
        const row = catalogRows.find((r) => r.name === name);
        expect({ name, source: row?.source }).toEqual({
          name,
          source: expect.objectContaining({ kind: "reference-template", ejectable: true, owned: true }),
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("mermaid-er — removed; `meta docs` draws the diagrams", () => {
  const REMOVED_FACTORY = [
    `import { defineConfig } from "@metaobjectsdev/codegen-ts";`,
    `import { entityFile, mermaidErDiagram } from "@metaobjectsdev/codegen-ts/generators";`,
    `export default defineConfig({ outDir: ${JSON.stringify(OUT)}, dialect: "sqlite", generators: [entityFile(), mermaidErDiagram()] });`,
  ].join("\n");
  const REMOVED_NAME = [
    `import { defineConfig } from "@metaobjectsdev/codegen-ts";`,
    `export default defineConfig({ outDir: ${JSON.stringify(OUT)}, dialect: "sqlite", generators: ["entity", "mermaid-er"] });`,
  ].join("\n");
  /** The removed import one module away from the config: the shape an owned generator has. */
  const VIA_OWNED_MODULE = [
    `import { defineConfig } from "@metaobjectsdev/codegen-ts";`,
    `import { diagram } from "./codegen/generators/diagram.js";`,
    `export default defineConfig({ outDir: ${JSON.stringify(OUT)}, dialect: "sqlite", generators: [diagram()] });`,
  ].join("\n");

  test("a config that still calls the removed factory is told what replaced it, and nothing is written", async () => {
    const root = setupRepo(REMOVED_FACTORY);
    try {
      const gen = await meta(root, "gen", "--format", "text");
      expect(gen.exit).not.toBe(0);
      expect(gen.output).toContain('mermaidErDiagram is no longer exported from "@metaobjectsdev/codegen-ts/generators": 1.1 removed that generator');
      // True of this project: the import is in the config itself.
      expect(gen.output).toContain("in your metaobjects.config.ts or in a module the config imports");
      expect(gen.output).toContain("`meta docs` draws the ER diagram");
      expect(gen.output).toContain("delete the import and the `mermaidErDiagram()` entry");
      expect(existsSync(join(root, OUT))).toBe(false);

      // `meta docs` reads the same config, so it stops on it too and writes no page.
      const docs = await meta(root, "docs");
      expect(docs.exit).toBe(2);
      expect(docs.output).toContain("mermaidErDiagram is no longer exported");
      expect(existsSync(join(root, DOCS))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("a commented-out import of the removed factory is not an import: the config loads", async () => {
    const root = setupRepo(
      [
        `import { defineConfig } from "@metaobjectsdev/codegen-ts";`,
        `import { entityFile } from "@metaobjectsdev/codegen-ts/generators";`,
        `// import { mermaidErDiagram } from "@metaobjectsdev/codegen-ts/generators";`,
        `/* import { mermaidErDiagram } from "@metaobjectsdev/codegen-ts/generators"; */`,
        `export default defineConfig({ outDir: ${JSON.stringify(OUT)}, dialect: "sqlite", generators: [entityFile()] });`,
      ].join("\n"),
    );
    try {
      const gen = await meta(root, "gen", "--format", "text");
      expect(gen).toMatchObject({ exit: 0 });
      expect(gen.output).not.toContain("mermaidErDiagram");
      expect([...tree(root, OUT).keys()]).toContain("User.ts");
      expect(await meta(root, "docs")).toMatchObject({ exit: 0 });
      expect(tree(root, DOCS).has("README.md")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("a config that still names \"mermaid-er\" is told the same, not \"unknown generator\"", async () => {
    const root = setupRepo(REMOVED_NAME);
    try {
      const gen = await meta(root, "gen", "--format", "text");
      expect(gen.exit).not.toBe(0);
      expect(gen.output).toContain('generator "mermaid-er" was removed in 1.1');
      expect(gen.output).toContain("`meta docs` draws the ER diagram");
      expect(gen.output).not.toContain("unknown generator");
      expect(existsSync(join(root, OUT))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("the removed import in a module the config imports is diagnosed too", async () => {
    const root = setupRepo(VIA_OWNED_MODULE);
    try {
      mkdirSync(join(root, "codegen", "generators"), { recursive: true });
      writeFileSync(
        join(root, "codegen", "generators", "diagram.ts"),
        [
          `import { mermaidErDiagram } from "@metaobjectsdev/codegen-ts/generators";`,
          `export const diagram = () => mermaidErDiagram({ outFile: "docs/erd.md" });`,
        ].join("\n"),
      );
      const gen = await meta(root, "gen", "--format", "text");
      expect(gen.exit).not.toBe(0);
      expect(gen.output).toContain('mermaidErDiagram is no longer exported from "@metaobjectsdev/codegen-ts/generators"');
      expect(gen.output).toContain("`meta docs` draws the ER diagram");
      expect(gen.output).toContain("codegen/generators/");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("and `meta docs` does draw them: the whole model on the overview page, a neighbourhood on an entity's page", async () => {
    const root = setupRepo(PACKAGED);
    try {
      expect(await meta(root, "docs")).toMatchObject({ exit: 0 });
      const pages = tree(root, DOCS);
      expect(pages.get("README.md")).toContain("## Diagram\n\n```mermaid\nerDiagram\n");
      expect(pages.get("README.md")).toContain("User ||--o{ Post");
      expect(pages.get("Post.md")).toContain("```mermaid\nflowchart TB\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
