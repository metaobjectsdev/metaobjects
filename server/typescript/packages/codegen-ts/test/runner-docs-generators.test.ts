// ADR-0034 Amendment 9: documentation is written by generators the project lists, like every
// other output. `meta gen` runs them; they write to the `docs` target unless told otherwise;
// a run that lists one with no `docs` target is refused by name; and the model and api pages
// in one target link to each other from facts the runner reads off the declared list.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { runGen } from "../src/runner.js";
import { DEFAULT_DOCS_DIR, defineConfig, resolveGenerators } from "../src/metaobjects-config.js";
import type { Generator } from "../src/generator.js";
import { agentDocsFile, apiDocsFile, docsFile, metamodelDocsFile, requirementsFile } from "../src/generators/index.js";
import type { AgentSchemaInput } from "../src/generators/agent-schema-input.js";
import { MetaDataLoader, type MetaRoot } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

const FIXTURE = resolve(import.meta.dir, "fixtures", "single-entity.json");

let tmp: string;
let root: MetaRoot;
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "codegen-docs-gen-"));
  root = (await new MetaDataLoader().load([new FileSource(FIXTURE)])).root;
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile())
    .map((f) => relative(dir, join(f.parentPath, f.name)).split("\\").join("/"))
    .sort();
}

const base = (generators: Generator[], withDocsTarget = true) =>
  defineConfig({
    outDir: join(tmp, "src"),
    extStyle: "none",
    dbImport: "../db",
    dialect: "sqlite",
    ...(withDocsTarget && { targets: { docs: { outDir: join(tmp, "docs") } } }),
    generators,
  });

describe("documentation generators under meta gen (ADR-0034 Amendment 9)", () => {
  test("the docs factories write into the docs target, and nothing into the code's directory", async () => {
    await runGen({ config: base([docsFile(), apiDocsFile(), requirementsFile(), metamodelDocsFile()]), metadata: root, projectRoot: tmp });
    const docs = filesUnder(join(tmp, "docs"));
    expect(docs).toContain("README.md");
    expect(docs).toContain("Post.md");
    expect(docs).toContain("api/README.md");
    expect(docs).toContain("api/AGENT-API.md");
    expect(docs).toContain("metamodel/INDEX.md");
    expect(filesUnder(join(tmp, "src"))).toEqual([]);
  });

  test("a docs generator with no docs target is refused, naming the generator and the target", async () => {
    await expect(runGen({ config: base([docsFile()], false), metadata: root, projectRoot: tmp }))
      .rejects.toThrow(/"docs-file" writes documentation to the "docs" target.*declares no targets\.docs/);
    expect(filesUnder(tmp).filter((f) => !f.startsWith(".metaobjects/"))).toEqual([]);
  });

  test("model and api pages in one target link to each other", async () => {
    await runGen({ config: base([docsFile(), apiDocsFile()]), metadata: root, projectRoot: tmp });
    const model = readFileSync(join(tmp, "docs", "Post.md"), "utf8");
    const api = readFileSync(join(tmp, "docs", "api", "Post.md"), "utf8");
    expect(model).toContain("api/Post.md");
    expect(api).toContain("../Post.md");
  });

  test("with only one of the two listed, neither links to pages nothing writes", async () => {
    await runGen({ config: base([docsFile()]), metadata: root, projectRoot: tmp });
    expect(readFileSync(join(tmp, "docs", "Post.md"), "utf8")).not.toContain("api/Post.md");
    rmSync(join(tmp, "docs"), { recursive: true, force: true });
    await runGen({ config: base([apiDocsFile()]), metadata: root, projectRoot: tmp });
    expect(readFileSync(join(tmp, "docs", "api", "Post.md"), "utf8")).not.toContain("../Post.md");
  });

  test("apiSurfaces on docsFile() names the pages to link, another port's included", async () => {
    await runGen({
      config: base([docsFile({ apiSurfaces: [{ lang: "java", subDir: "api/java", baseUrl: "https://example.com/j" }] })]),
      metadata: root,
      projectRoot: tmp,
    });
    const model = readFileSync(join(tmp, "docs", "Post.md"), "utf8");
    expect(model).toContain("Java");
    expect(model).toContain("https://example.com/j/Post.md");
  });

  test("modelBaseUrl on apiDocsFile() links each api page to a hosted model page", async () => {
    await runGen({ config: base([apiDocsFile({ modelBaseUrl: "https://example.com/model/" })]), metadata: root, projectRoot: tmp });
    expect(readFileSync(join(tmp, "docs", "api", "Post.md"), "utf8")).toContain("https://example.com/model/Post.md");
  });

  test("the agent schema is built once, and only when a generator asks for it", async () => {
    let calls = 0;
    const agentSchema = (): AgentSchemaInput | undefined => {
      calls++;
      return undefined;
    };
    await runGen({ config: base([docsFile()]), metadata: root, projectRoot: tmp, agentSchema });
    expect(calls).toBe(0);
    await runGen({
      config: base([agentDocsFile(), agentDocsFile({ subDir: "agent2" })]),
      metadata: root,
      projectRoot: tmp,
      agentSchema,
    });
    expect(calls).toBe(1);
  });

  test("every documentation name resolves as a generator, neutral ones included", () => {
    const names = ["docs", "api-docs", "requirements", "agent-docs", "metamodel-docs", "docs-site"];
    expect(resolveGenerators(names).map((g) => g.name)).toEqual([
      "docs-file", "api-docs", "requirements-file", "agent-docs", "metamodel-docs", "docs-site",
    ]);
    for (const g of resolveGenerators(names)) expect(g.target).toBe("docs");
  });

  test("a config that declares nothing writes nothing", async () => {
    const result = await runGen({ config: base([]), metadata: root, projectRoot: tmp });
    expect(result.files).toEqual([]);
    expect(filesUnder(tmp)).toEqual([]);
  });

  // F57 — the suggested docs directory is a SUB-directory, asserted as a literal: `docs/` is the
  // human documentation folder in most repos, and generated pages should not scatter through it.
  test("the suggested docs directory is a sub-directory MetaObjects can own", () => {
    expect(DEFAULT_DOCS_DIR).toBe("./docs/generated");
  });
});

// R2: `agent/ui.md` is written when the run has a client UI generator or the config sets
// `includeUiTier: true`. Otherwise it is skipped, and the skip is never silent unless the
// config says there is no UI anywhere (`includeUiTier: false`), which a server-only
// project needs so it is not advised on every run.
describe("agent/ui.md and the includeUiTier key under meta gen", () => {
  async function agentRun(includeUiTier?: boolean): Promise<{ written: boolean; advised: string[] }> {
    const result = await runGen({
      config: { ...base([agentDocsFile()]), ...(includeUiTier !== undefined && { includeUiTier }) },
      metadata: root,
      projectRoot: tmp,
    });
    return {
      written: filesUnder(join(tmp, "docs")).includes("agent/ui.md"),
      advised: result.warnings.filter((w) => w.includes("ui.md not written")),
    };
  }

  test("unset with no UI generator: the page is skipped and the run says so", async () => {
    const { written, advised } = await agentRun();
    expect(written).toBe(false);
    expect(advised).toHaveLength(1);
    expect(advised[0]).toContain("includeUiTier: true");
    expect(advised[0]).toContain("includeUiTier: false");
  });

  test("true: the page is written and nothing is advised", async () => {
    expect(await agentRun(true)).toEqual({ written: true, advised: [] });
  });

  test("false: no page, and nothing is advised", async () => {
    expect(await agentRun(false)).toEqual({ written: false, advised: [] });
  });
});
