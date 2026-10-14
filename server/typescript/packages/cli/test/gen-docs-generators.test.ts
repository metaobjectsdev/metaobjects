// ADR-0034 Amendment 9: one way to generate. Every generator, documentation included, is an
// entry in `generators`; `meta gen` runs the list, `meta verify --codegen` checks it, and
// nothing is written that the list does not declare. The docs command, `meta verify --docs`
// and the config's `docs` block are gone, and each says where it went.
//
// Driven through the real CLI entry (`run`), against small projects written into the
// workspace so a config resolves `@metaobjectsdev/*` the way a project's does.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { run } from "../src/index.js";
import {
  legacyDocsConfigMessage, NO_CONFIG_MESSAGE, REMOVED_DOCS_COMMAND, REMOVED_VERIFY_DOCS,
} from "../src/lib/docs-removed.js";

const WORKSPACE_TMP = resolve(import.meta.dirname, "fixtures", "__tmp__");

const MODEL = JSON.stringify({
  "metadata.root": {
    package: "app",
    children: [
      {
        "object.entity": {
          name: "Talk",
          children: [
            { "source.rdb": { "@table": "talks" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "title", "@required": true } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
});

interface ProjectOpts {
  /** The config body after `defineConfig({`, verbatim. Absent: no config file at all. */
  config?: string;
  /**
   * A git repository of its own in the OS temp directory, instead of the workspace. The
   * workspace scratch directory is git-ignored, and `meta verify --codegen` does not check
   * documentation the repository ignores.
   */
  ownRepo?: boolean;
  /** Statements before the config's `export default`. */
  extra?: string;
}

const dirs: string[] = [];
let out: string[];
let err: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;
beforeEach(() => {
  out = [];
  err = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(opts: ProjectOpts): string {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(opts.ownRepo === true ? tmpdir() : WORKSPACE_TMP, "gen-docs-"));
  dirs.push(root);
  if (opts.ownRepo === true) spawnSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, "metaobjects"), { recursive: true });
  writeFileSync(join(root, "metaobjects", "meta.app.json"), MODEL, "utf8");
  mkdirSync(join(root, ".metaobjects"), { recursive: true });
  writeFileSync(join(root, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1, sources: [] }), "utf8");
  if (opts.config !== undefined) {
    writeFileSync(
      join(root, "metaobjects.config.ts"),
      `import { defineConfig } from "@metaobjectsdev/codegen-ts";
import {
  agentDocsFile, apiDocsFile, docsFile, docsSiteFile, metamodelDocsFile, requirementsFile, routesFile, routesFileHono,
} from "@metaobjectsdev/codegen-ts/generators";
import { tanstackQuery } from "@metaobjectsdev/codegen-ts-tanstack";
${opts.extra ?? ""}
export default defineConfig({
${opts.config}
});
`,
      "utf8",
    );
  }
  return root;
}

/** The base config: code into ./generated, documentation into ./docs/generated. */
const base = (generators: string, more = ""): string => `
  outDir: "generated",
  dialect: "sqlite",
  dbImport: "../db",
  extStyle: "none",
  targets: { docs: { outDir: "./docs/generated" } },
  generators: ${generators},${more}`;

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile())
    .map((f) => relative(dir, join(f.parentPath, f.name)).split("\\").join("/"))
    .sort();
}

const stderr = (): string => err.join("\n");

describe("the removed docs commands say where they went (ADR-0034 Amendment 9)", () => {
  test("`meta docs` prints the fixed line and exits 2", async () => {
    const root = project({ config: base("[docsFile()]") });
    expect(await run(["docs", "--cwd", root])).toBe(2);
    expect(stderr()).toContain(REMOVED_DOCS_COMMAND);
    expect(REMOVED_DOCS_COMMAND).toBe(
      "`meta docs` was removed in 1.1.0. `meta gen` writes documentation now: declare each docs generator " +
        "in `generators` in metaobjects.config.ts. See docs/features/migrations/docs-are-generators.md, " +
        'section "TypeScript".',
    );
    expect(existsSync(join(root, "docs"))).toBe(false);
  });

  test("`meta verify --docs` prints the fixed line and exits 2", async () => {
    const root = project({ config: base("[docsFile()]") });
    expect(await run(["verify", "--docs", "--cwd", root])).toBe(2);
    expect(stderr()).toContain(REMOVED_VERIFY_DOCS);
    expect(REMOVED_VERIFY_DOCS).toBe(
      "`meta verify --docs` was removed in 1.1.0. `meta verify --codegen` checks documentation now, " +
        "with everything else `generators` declares. See docs/features/migrations/docs-are-generators.md, " +
        'section "TypeScript".',
    );
  });
});

describe("meta gen refuses a config it cannot read the list from", () => {
  test("no metaobjects.config.ts: the fixed line, exit 2, nothing written", async () => {
    const root = project({});
    const before = filesUnder(root);
    expect(await run(["gen", "--cwd", root])).toBe(2);
    expect(stderr()).toContain(NO_CONFIG_MESSAGE);
    expect(NO_CONFIG_MESSAGE).toContain('A 1.0 project that ran `meta docs` with no config: see docs/features/migrations/docs-are-generators.md, section "TypeScript".');
    expect(filesUnder(root)).toEqual(before);
  });

  test("a 1.0 `docs` block: the fixed line, exit 2, nothing written", async () => {
    const root = project({ config: base(`["entity", docsFile()]`, `\n  docs: { outDir: "./docs/generated" },`) });
    const before = filesUnder(root);
    expect(await run(["gen", "--cwd", root])).toBe(2);
    expect(stderr()).toContain(legacyDocsConfigMessage("meta gen"));
    expect(legacyDocsConfigMessage("meta gen")).toBe(
      "meta gen: found 1.0 docs configuration (the docs block in metaobjects.config.ts). Nothing reads it any " +
        "more, so this run would write no documentation. Declare each docs generator in `generators` in " +
        'metaobjects.config.ts. See docs/features/migrations/docs-are-generators.md, section "TypeScript".',
    );
    expect(filesUnder(root)).toEqual(before);
  });

  test("a 1.0 `docs` block fails `meta verify --codegen` the same way", async () => {
    const root = project({ config: base(`["entity"]`, `\n  docs: { outDir: "./docs/generated" },`) });
    expect(await run(["verify", "--codegen", "--cwd", root])).toBe(2);
    expect(stderr()).toContain(legacyDocsConfigMessage("meta verify"));
  });

  test("a docs generator with no docs target is refused, naming it, and nothing is written", async () => {
    const root = project({ config: `
  outDir: "generated",
  dialect: "sqlite",
  dbImport: "../db",
  generators: ["entity", docsFile()],` });
    expect(await run(["gen", "--cwd", root])).not.toBe(0);
    expect(stderr()).toContain('"docs-file" writes documentation to the "docs" target');
    expect(existsSync(join(root, "generated"))).toBe(false);
  });
});

describe("a config that declares nothing writes nothing", () => {
  test("generators: [] — exit 0, and the project tree is as it was", async () => {
    const root = project({ config: base("[]") });
    const before = filesUnder(root);
    expect(await run(["gen", "--cwd", root])).toBe(0);
    expect(filesUnder(root)).toEqual(before);
  });
});

describe("meta gen writes the documentation the list declares", () => {
  test("model, api, agent and metamodel pages land in the docs target and link to each other", async () => {
    const root = project({
      config: base(`["entity", docsFile(), apiDocsFile(), requirementsFile(), agentDocsFile(), metamodelDocsFile()]`),
    });
    expect(await run(["gen", "--cwd", root])).toBe(0);
    const docs = filesUnder(join(root, "docs", "generated"));
    expect(docs).toEqual(expect.arrayContaining([
      "README.md", "Talk.md", "api/README.md", "api/AGENT-API.md", "api/Talk.md",
      "agent/schema.md", "metamodel/INDEX.md", "metamodel/providers.md",
    ]));
    // A model with no requirement.* node gets no ledger file.
    expect(docs.some((p) => p.startsWith("requirements."))).toBe(false);
    expect(readFileSync(join(root, "docs", "generated", "Talk.md"), "utf8")).toContain("api/Talk.md");
    expect(readFileSync(join(root, "docs", "generated", "api", "Talk.md"), "utf8")).toContain("../Talk.md");
    // The schema page describes the project's dialect.
    expect(readFileSync(join(root, "docs", "generated", "agent", "schema.md"), "utf8")).toContain("talks");
    // Nothing of the documentation lands among the code.
    expect(filesUnder(join(root, "generated")).some((p) => p.endsWith(".md"))).toBe(false);
  });

  test("agent/ui.md names the address the routes are served at: the project's apiPrefix", async () => {
    const root = project({
      config: base(`["entity", tanstackQuery(), agentDocsFile()]`, `\n  apiPrefix: "/api",`),
    });
    expect(await run(["gen", "--cwd", root])).toBe(0);
    expect(readFileSync(join(root, "docs", "generated", "agent", "ui.md"), "utf8")).toContain("/api/talks");
  });

  test("the api pages list only the verbs routesFile({ expose }) mounts", async () => {
    const root = project({ config: base(`["entity", routesFile({ expose: ["list", "get"] }), apiDocsFile()]`) });
    expect(await run(["gen", "--cwd", root])).toBe(0);
    const page = readFileSync(join(root, "docs", "generated", "api", "Talk.md"), "utf8");
    expect(page).toContain("GET /talks");
    expect(page).not.toContain("POST /talks");
    expect(page).not.toContain("DELETE /talks");
  });

  test("the docs site lands under site/, and an ejected theme is what it renders with", async () => {
    const root = project({ config: base(`[docsSiteFile()]`) });
    expect(await run(["gen", "--cwd", root])).toBe(0);
    const site = join(root, "docs", "generated", "site");
    expect(existsSync(join(site, "index.html"))).toBe(true);
    // No date in the footer: the pages depend on the model alone.
    expect(readFileSync(join(site, "index.html"), "utf8")).toContain("generated · metadata-docs");

    expect(await run(["eject", "docs-site", "--cwd", root])).toBe(0);
    const css = join(root, "codegen", "docs-site", "assets", "site.css");
    expect(existsSync(css)).toBe(true);
    writeFileSync(css, "/* owned theme */\n", "utf8");
    // A re-run keeps the edit.
    expect(await run(["eject", "docs-site", "--cwd", root])).toBe(0);
    expect(readFileSync(css, "utf8")).toBe("/* owned theme */\n");
    expect(await run(["gen", "--cwd", root])).toBe(0);
    expect(readFileSync(join(site, "assets", "site.css"), "utf8")).toBe("/* owned theme */\n");
  });
});

describe("meta gen --generators narrows a run to declared entries", () => {
  const generators = `["entity", routesFile(), routesFileHono(), docsFile(), apiDocsFile()]`;

  test("names the docs entries: only the pages are written", async () => {
    const root = project({ config: base(generators) });
    expect(await run(["gen", "--generators", "docs,api-docs", "--cwd", root])).toBe(0);
    expect(existsSync(join(root, "generated"))).toBe(false);
    expect(filesUnder(join(root, "docs", "generated"))).toEqual(expect.arrayContaining(["Talk.md", "api/Talk.md"]));
  });

  test("a narrowed run reads the run's facts from the whole list: the Hono routes are documented", async () => {
    const root = project({ config: base(generators) });
    expect(await run(["gen", "--generators", "api-docs", "--cwd", root])).toBe(0);
    expect(readFileSync(join(root, "docs", "generated", "api", "AGENT-API.md"), "utf8")).toContain("routes.hono");
    // ...and the model pages it did not write are still linked from it, because the list declares them.
    expect(readFileSync(join(root, "docs", "generated", "api", "Talk.md"), "utf8")).toContain("../Talk.md");
  });

  test("a name the config does not declare is refused, exit 2, nothing written", async () => {
    const root = project({ config: base(`["entity", docsFile()]`) });
    expect(await run(["gen", "--generators", "docs,api-docs", "--cwd", root])).toBe(2);
    expect(stderr()).toContain('--generators names "api-docs", which metaobjects.config.ts does not declare');
    expect(existsSync(join(root, "docs"))).toBe(false);
  });
});

describe("meta verify --codegen checks the documentation the list declares", () => {
  test("clean after gen; a model change not regenerated is drift in the pages", async () => {
    const root = project({ config: base(`["entity", docsFile()]`), ownRepo: true });
    expect(await run(["gen", "--cwd", root])).toBe(0);
    expect(await run(["verify", "--codegen", "--cwd", root])).toBe(0);
    // A new object: a page a fresh run writes and the committed tree does not hold.
    const model = JSON.parse(MODEL) as { "metadata.root": { children: unknown[] } };
    model["metadata.root"].children.push({
      "object.value": { name: "Speaker", children: [{ "field.string": { name: "name" } }] },
    });
    writeFileSync(join(root, "metaobjects", "meta.app.json"), JSON.stringify(model), "utf8");
    expect(await run(["verify", "--codegen", "--cwd", root])).toBe(1);
    expect(stderr()).toContain("Speaker.md");
  });

  // Carried from 1.0's `meta verify --docs`: a project may generate many pages and commit a
  // few on purpose, git-ignoring the rest. The check is asked of the repository, so a CI
  // runner without the ignored pages answers as the machine that generated them does.
  test("a git-ignored page is not checked, and the run says how many were not", async () => {
    const root = project({ config: base(`["entity", docsFile()]`), ownRepo: true });
    writeFileSync(join(root, ".gitignore"), "docs/generated/Talk.md\n", "utf8");
    expect(await run(["gen", "--cwd", root])).toBe(0);
    rmSync(join(root, "docs", "generated", "Talk.md"));
    expect(await run(["verify", "--codegen", "--cwd", root])).toBe(0);
    expect([...out, ...err].join("\n")).toContain(
      "1 generated documentation page(s) are git-ignored and were not checked",
    );
  });

  test("a docs directory the repository ignores whole is refused, not reported clean", async () => {
    const root = project({ config: base(`["entity", docsFile()]`), ownRepo: true });
    writeFileSync(join(root, ".gitignore"), "docs/\n", "utf8");
    expect(await run(["gen", "--cwd", root])).toBe(0);
    expect(await run(["verify", "--codegen", "--cwd", root])).toBe(2);
    expect(stderr()).toContain("git-ignores every one of them");
  });
});

describe("an owned docs generator is wired like any other", () => {
  test("`meta eject docs` prints a `generators` entry, and the copy writes the same pages", async () => {
    const packaged = project({ config: base(`["entity", docsFile()]`) });
    expect(await run(["gen", "--cwd", packaged])).toBe(0);

    const owned = project({
      config: base(`["entity", ownedDocs()]`),
      extra: `import { docsFile as ownedDocs } from "./codegen/generators/docs.js";`,
    });
    expect(await run(["eject", "docs", "--cwd", owned])).toBe(0);
    const printed = out.join("\n");
    expect(printed).toContain("docsFile()");
    expect(printed).not.toContain("docs: { generators");
    expect(await run(["gen", "--cwd", owned])).toBe(0);

    const a = join(packaged, "docs", "generated");
    const b = join(owned, "docs", "generated");
    expect(filesUnder(b)).toEqual(filesUnder(a));
    for (const f of filesUnder(a)) expect(readFileSync(join(b, f), "utf8")).toBe(readFileSync(join(a, f), "utf8"));
  });
});

describe("upgrading from 1.0: pages `meta docs` wrote without recording them", () => {
  test("the first `meta gen` refuses them; the migration guide's fresh-baseline run takes them over, and code stays protected", async () => {
    const root = project({ config: base(`["entity", docsFile()]`) });
    expect(await run(["gen", "--cwd", root])).toBe(0);
    const docsDir = join(root, "docs", "generated");
    const fresh = Object.fromEntries(filesUnder(docsDir).map((f) => [f, readFileSync(join(docsDir, f), "utf8")]));
    const codeFile = join(root, "generated", filesUnder(join(root, "generated")).find((f) => f.endsWith(".ts"))!);

    // The 1.0 state: pages whose bytes differ from 1.1's, no record of writing any of them,
    // and a generated code file somebody edited.
    rmSync(join(root, ".metaobjects", ".gen-state"), { recursive: true, force: true });
    for (const f of Object.keys(fresh)) writeFileSync(join(docsDir, f), `1.0 page ${f}\n`, "utf8");
    const editedCode = `${readFileSync(codeFile, "utf8")}// my edit\n`;
    writeFileSync(codeFile, editedCode, "utf8");

    await run(["gen", "--cwd", root]);
    expect(readFileSync(join(docsDir, "README.md"), "utf8")).toBe("1.0 page README.md\n");

    // docs/features/migrations/docs-are-generators.md, "The first run after the upgrade".
    expect(await run(["gen", "--generators", "docs", "--baseline=fresh", "--cwd", root])).toBe(0);
    for (const [f, content] of Object.entries(fresh)) expect(readFileSync(join(docsDir, f), "utf8")).toBe(content);
    expect(readFileSync(codeFile, "utf8")).toBe(editedCode);

    // The pages are recorded now: an ordinary run over them refuses nothing.
    err = [];
    expect(await run(["gen", "--generators", "docs", "--cwd", root])).toBe(0);
    expect(stderr()).not.toContain("Refused");
  });
});

describe("a 1.0 owned docs copy, which sets no target", () => {
  // The shape of a 1.0 `meta eject docs` copy: the packaged implementation name, no `target`,
  // and the retired `docsSurface` marker.
  const extra = `
const oldDocs = () => ({
  name: "docs-file",
  docsSurface: "model",
  generate: () => [{ path: "README.md", content: "# model\\n" }],
});`;

  test("writes to the docs target, not into the code's output directory", async () => {
    const root = project({ config: base(`["entity", oldDocs()]`), extra });
    expect(await run(["gen", "--cwd", root])).toBe(0);
    expect(existsSync(join(root, "docs", "generated", "README.md"))).toBe(true);
    expect(existsSync(join(root, "generated", "README.md"))).toBe(false);
  });

  test("is refused, naming it, when targets declares no docs entry", async () => {
    const root = project({
      config: `
  outDir: "generated",
  dialect: "sqlite",
  dbImport: "../db",
  generators: ["entity", oldDocs()],`,
      extra,
    });
    expect(await run(["gen", "--cwd", root])).not.toBe(0);
    expect(stderr()).toContain('"docs-file" writes documentation to the "docs" target');
    expect(existsSync(join(root, "generated"))).toBe(false);
  });
});

describe("meta gen --list --probe counts the documentation generators as meta gen runs them", () => {
  test("docs-site and agent-docs: the probe's count is the number of files meta gen writes", async () => {
    const probed = project({ config: base("[]") });
    expect(await run(["gen", "--list", "--probe", "--format", "json", "--cwd", probed])).toBe(0);
    const rows = JSON.parse(out.join("\n")) as Array<{
      name: string; project?: { wouldEmit: number | null; probeError?: string };
    }>;
    const row = (name: string) => rows.find((r) => r.name === name)?.project;

    const generated = project({ config: base("[agentDocsFile(), docsSiteFile()]") });
    expect(await run(["gen", "--cwd", generated])).toBe(0);
    const docsDir = join(generated, "docs", "generated");
    const agentFiles = filesUnder(join(docsDir, "agent"));
    const siteFiles = filesUnder(join(docsDir, "site"));
    expect(agentFiles).toContain("schema.md");
    expect(filesUnder(docsDir).length).toBe(agentFiles.length + siteFiles.length);

    expect(row("docs-site")?.probeError).toBeUndefined();
    expect(row("docs-site")?.wouldEmit).toBe(siteFiles.length);
    expect(row("agent-docs")?.probeError).toBeUndefined();
    expect(row("agent-docs")?.wouldEmit).toBe(agentFiles.length);
  });
});

describe("meta gen — the structured result carries every warning the run printed", () => {
  test("a generator's own ctx.warn reaches the document", async () => {
    const root = project({
      config: base(`["entity", warner]`),
      extra: `
const warner = {
  name: "warner",
  generate: (ctx: { warn: (m: string) => void }) => { ctx.warn("hello from warner"); return []; },
};`,
    });
    expect(await run(["gen", "--format", "json", "--cwd", root])).toBe(0);
    const payload = JSON.parse(out.join("\n")) as { warnings?: string[] };
    expect(payload.warnings).toContain("[warner] hello from warner");
    for (const w of payload.warnings ?? []) expect(stderr()).toContain(w);
  });
});

describe("meta gen --list — documentation rows are wired like the rest", () => {
  test("each docs-layer row prints its import, and there is no mermaid-er row", async () => {
    expect(await run(["gen", "--list", "--format", "json"])).toBe(0);
    const rows = (JSON.parse(out.join("\n")) as { generators?: unknown[]; catalog?: unknown[] });
    const list = (rows.generators ?? rows.catalog ?? (Array.isArray(rows) ? rows : [])) as Array<{
      name: string; layer?: string; wire?: { import: string };
    }>;
    const docs = list.filter((r) => r.layer === "docs");
    expect(docs.map((r) => r.name).sort()).toEqual(
      ["agent-docs", "api-docs", "docs", "docs-site", "metamodel-docs", "requirements"],
    );
    for (const r of docs) expect(r.wire?.import, r.name).toContain("@metaobjectsdev/codegen-ts/generators");
    expect(list.some((r) => r.name === "mermaid-er")).toBe(false);
  });
});
