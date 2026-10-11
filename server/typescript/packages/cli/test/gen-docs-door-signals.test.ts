// ADR-0025: `meta docs` is the single docs door, so `meta gen` warns about and SKIPS a
// `docsFile()` / `apiDocsFile()` it finds under `generators`. The skip is right; the
// signal was not reaching everybody. In `json` / `toon` output — the default on a pipe,
// so the form an agent reads — the runner's warnings went to stderr only, and the
// document described a clean run that produced no API docs and gave no reason. The
// catalog (`meta gen --list`) presented `api-docs` as something to wire, and
// `meta verify` said nothing at all.
//
// Driven through the real CLI entry (`run`), one project, every output form, asserting
// WHERE the signal lands in each.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../src/index.js";

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

/** `generators` is the config's array literal, verbatim. */
function setupRepo(generators: string, opts: { extra?: string } = {}): string {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(WORKSPACE_TMP, "gen-docs-door-"));
  mkdirSync(join(root, "metaobjects"), { recursive: true });
  writeFileSync(join(root, "metaobjects", "meta.app.json"), MODEL, "utf8");
  mkdirSync(join(root, ".metaobjects"), { recursive: true });
  writeFileSync(join(root, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1, sources: [] }), "utf8");
  writeFileSync(
    join(root, "metaobjects.config.ts"),
    `
import { defineConfig } from "@metaobjectsdev/codegen-ts";
import { apiDocsFile, docsFile, mermaidErDiagram } from "@metaobjectsdev/codegen-ts/generators";
${opts.extra ?? ""}
export default defineConfig({
  outDir: "generated",
  dialect: "sqlite",
  dbImport: "../db",
  extStyle: "none",
  generators: ${generators},
});
`,
  );
  return root;
}

const API_DOCS_SKIP = "remove apiDocsFile() from generators. Skipped.";
const DOCS_SKIP = "remove docsFile() from generators. Skipped.";

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
});

/** Run the CLI against a fresh project and hand back both streams. */
async function meta(generators: string, args: string[], opts: { extra?: string } = {}):
  Promise<{ code: number; stdout: string; stderr: string; root: string }> {
  const root = setupRepo(generators, opts);
  try {
    const code = await run([...args, "--cwd", root]);
    return { code, stdout: out.join("\n"), stderr: err.join("\n"), root };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

interface GenPayload {
  gen: { file: string; status: string }[];
  summary: string;
  help: string[];
  warnings?: string[];
}

interface ListRow {
  name: string;
  kind: string;
  note?: string;
  door?: string;
  project?: { wired: boolean; wouldEmit: number | null; probeError?: string };
}

const WIRED = `["entity", apiDocsFile(), docsFile()]`;

describe("meta gen — a skipped doc generator is reported in every output form", () => {
  test("text: the skip is on stderr, and the file listing on stdout is unchanged", async () => {
    const r = await meta(WIRED, ["gen", "--format", "text"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(API_DOCS_SKIP);
    expect(r.stderr).toContain(DOCS_SKIP);
    expect(r.stderr).toContain("meta docs");
    expect(r.stdout).toContain("Talk.ts");
    // Nothing under docs/ was written by `meta gen`.
    expect(r.stdout).not.toContain("docs/");
  });

  test("json: the document's own warnings carry the skip", async () => {
    const r = await meta(WIRED, ["gen", "--format", "json"]);
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as GenPayload;
    expect(payload.warnings?.some((w) => w.includes(API_DOCS_SKIP))).toBe(true);
    expect(payload.warnings?.some((w) => w.includes(DOCS_SKIP))).toBe(true);
    // ...and a next step, because `help` is what an agent acts on.
    expect(payload.help.some((h) => h.includes("meta docs") && h.includes("warnings"))).toBe(true);
    // The entity generator still ran.
    expect(payload.gen.map((g) => g.file)).toEqual(["generated/Talk.ts"]);
    // Still on stderr too, for a person watching the run.
    expect(r.stderr).toContain(API_DOCS_SKIP);
  });

  test("toon: the document's own warnings carry the skip", async () => {
    const r = await meta(WIRED, ["gen", "--format", "toon"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^warnings\[2\]:/m);
    expect(r.stdout).toContain(API_DOCS_SKIP);
    expect(r.stdout).toContain(DOCS_SKIP);
  });

  test("no --format on a pipe (the agent default) is toon, and it carries the skip", async () => {
    // The default is chosen from stdout being a TTY, so pin it: this test must mean the
    // same thing run from a terminal as it does in CI.
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    try {
      const r = await meta(WIRED, ["gen"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/^gen\[1\]/m);
      expect(r.stdout).toContain(API_DOCS_SKIP);
    } finally {
      if (tty !== undefined) Object.defineProperty(process.stdout, "isTTY", tty);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  });

  test("--dry-run: the preview carries the skip and writes nothing", async () => {
    const root = setupRepo(WIRED);
    try {
      expect(await run(["gen", "--dry-run", "--format", "json", "--cwd", root])).toBe(0);
      const payload = JSON.parse(out.join("\n")) as GenPayload;
      expect(payload.warnings?.some((w) => w.includes(API_DOCS_SKIP))).toBe(true);
      expect(existsSync(join(root, "generated"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a run that skips nothing has no warnings key and no docs next step", async () => {
    const r = await meta(`["entity"]`, ["gen", "--format", "json"]);
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as GenPayload;
    expect(payload.warnings).toBeUndefined();
    expect(payload.help.some((h) => h.includes("meta docs"))).toBe(false);
  });
});

describe("meta gen — mermaid-er is a generator `meta gen` runs", () => {
  // The other half of the same ruling: what `meta docs` runs is skipped here, and what
  // it does not run is not. Every surface has to give the same answer.
  test("mermaidErDiagram() writes its file and draws no skip warning", async () => {
    const r = await meta(`["entity", mermaidErDiagram()]`, ["gen", "--format", "json"]);
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as GenPayload;
    expect(payload.gen.map((g) => g.file)).toContain("generated/docs/model.md");
    expect(payload.warnings).toBeUndefined();
    expect(r.stderr).not.toContain("Skipped.");
  });

  test("the stable name selects it, as it does every other generator `meta gen` runs", async () => {
    // It was refused as "neutral (owned by 'meta docs')" while the factory beside it ran.
    const r = await meta(`["entity", "mermaid-er"]`, ["gen", "--format", "json"]);
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as GenPayload;
    expect(payload.gen.map((g) => g.file)).toContain("generated/docs/model.md");
  });

  test("the stable name `docs` is still refused: `meta docs` owns it", async () => {
    const r = await meta(`["entity", "docs"]`, ["gen", "--format", "json"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(`generator "docs" is neutral (owned by 'meta docs')`);
  });
});

describe("meta gen — the structured result carries EVERY warning the run printed", () => {
  // Not only the doc-generator one: every runner warning went to stderr alone.
  test("a generator's own ctx.warn reaches the document", async () => {
    const extra = `
const warner = {
  name: "warner",
  generate: (ctx: { warn: (m: string) => void }) => { ctx.warn("hello from warner"); return []; },
};`;
    const r = await meta(`["entity", warner]`, ["gen", "--format", "json"], { extra });
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as GenPayload;
    expect(payload.warnings).toContain("[warner] hello from warner");
    // Every line the document carries was also printed, and nothing printed as a
    // warning is missing from the document.
    for (const w of payload.warnings ?? []) expect(r.stderr).toContain(w);
  });

  test("the CLI's own advisories ride in it too (stale agent context)", async () => {
    const root = setupRepo(`["entity"]`);
    try {
      writeFileSync(
        join(root, ".metaobjects", ".agent-context.json"),
        JSON.stringify({ version: 1, generatedBy: "0.0.1", servers: [], clients: [], files: {} }),
        "utf8",
      );
      expect(await run(["gen", "--format", "json", "--cwd", root])).toBe(0);
      const payload = JSON.parse(out.join("\n")) as GenPayload;
      expect(payload.warnings?.some((w) => w.includes("agent context was generated by 0.0.1"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("meta gen — a config wiring ONLY doc generators is not told to author entities", () => {
  // It emitted nothing and reported "no entities to generate … author entities in this
  // project's metadata sources", for a project that has them.
  const ONLY_DOCS = `[apiDocsFile(), docsFile()]`;

  test("json: the summary and the next step name the real reason", async () => {
    const r = await meta(ONLY_DOCS, ["gen", "--format", "json"]);
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as GenPayload;
    expect(payload.gen).toEqual([]);
    expect(payload.summary).toContain("doc generator");
    expect(payload.summary).not.toContain("no entities");
    expect(payload.help.join("\n")).toContain("meta docs");
    expect(payload.help.join("\n")).not.toContain("author entities");
    expect(payload.warnings).toHaveLength(2);
  });

  test("text: stdout names the real reason", async () => {
    const r = await meta(ONLY_DOCS, ["gen", "--format", "text"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("No entities to generate");
    expect(r.stdout).toContain("meta docs");
  });

  test("a real generator that emits nothing still reads as no entities", async () => {
    const extra = `const quiet = { name: "quiet", generate: () => [] };`;
    const r = await meta(`[quiet, apiDocsFile()]`, ["gen", "--format", "json"], { extra });
    const payload = JSON.parse(r.stdout) as GenPayload;
    expect(payload.summary).toContain("no entities to generate");
  });
});

describe("meta gen --list — a row `meta gen` does not run says so", () => {
  const rowsOf = (stdout: string): ListRow[] => JSON.parse(stdout) as ListRow[];
  const row = (rows: ListRow[], name: string): ListRow => {
    const found = rows.find((r) => r.kind === "generator" && r.name === name);
    if (found === undefined) throw new Error(`no ${name} row`);
    return found;
  };
  /** The row line for `name`, and the lines indented under it. */
  const block = (text: string, name: string): string => {
    const lines = text.split("\n");
    const at = lines.findIndex((l) => l.startsWith(`  ${name} `));
    if (at === -1) return "";
    let end = at + 1;
    while (end < lines.length && /^ {6,}\S/.test(lines[end] ?? "")) end++;
    return lines.slice(at, end).join("\n");
  };

  test("text: api-docs and docs name `meta docs` as their door, on the row and under it", async () => {
    const r = await meta(`["entity"]`, ["gen", "--list", "--format", "text"]);
    expect(r.code).toBe(0);
    for (const name of ["api-docs", "docs"]) {
      const b = block(r.stdout, name);
      expect(b, name).toContain("run by `meta docs`");
      expect(b, name).toContain("not run by `meta gen`");
      expect(b, name).toContain("warned about and skipped");
    }
    // A generator `meta gen` runs carries neither.
    expect(block(r.stdout, "entity")).not.toContain("meta docs");
  });

  // `meta docs` has never run mermaid-er: `meta gen` writes its file. The row said
  // "surfaced via `meta docs`" (in the registry; nothing printed it), so the one
  // docs-layer generator that belongs in `generators` read as one that does not.
  test("text: mermaid-er is run by `meta gen`, and its row says so", async () => {
    const r = await meta(`["entity"]`, ["gen", "--list", "--format", "text"]);
    const mermaid = block(r.stdout, "mermaid-er");
    expect(mermaid).toContain("run by `meta gen`");
    expect(mermaid).not.toContain("run by `meta docs`");
    expect(mermaid).not.toContain("not run by `meta gen`");
    // ...while still telling the reader the diagram is already on the overview page.
    expect(mermaid).toContain("`meta docs` already draws the same diagram");
  });

  test("json: the row carries the door and the note", async () => {
    const r = await meta(`["entity"]`, ["gen", "--list", "--format", "json"]);
    expect(r.code).toBe(0);
    const rows = rowsOf(r.stdout);
    for (const name of ["api-docs", "docs"]) {
      // `door` is the machine-readable half: present means `meta gen` does not run it.
      expect(row(rows, name).door, name).toBe("meta docs");
      expect(row(rows, name).note ?? "", name).toContain("meta docs");
    }
    expect(row(rows, "mermaid-er").door).toBeUndefined();
    expect(row(rows, "mermaid-er").note ?? "").toContain("run by `meta gen`");
    expect(row(rows, "entity").door).toBeUndefined();
    expect(row(rows, "entity").note).toBeUndefined();
  });

  test("a wired doc generator reads as skipped, not merely WIRED", async () => {
    const r = await meta(WIRED, ["gen", "--list", "--format", "text"]);
    expect(block(r.stdout, "api-docs")).toContain("WIRED but skipped by `meta gen`");
    expect(block(r.stdout, "docs")).toContain("WIRED but skipped by `meta gen`");
    expect(block(r.stdout, "entity")).toContain("WIRED");
    expect(block(r.stdout, "entity")).not.toContain("skipped");
  });

  test("--probe: no file count for a generator `meta gen` does not run", async () => {
    // It printed `would emit 0`, which reads as "nothing in your model needs this" for
    // a generator whose pages `meta docs` writes for every entity.
    const text = await meta(WIRED, ["gen", "--list", "--probe", "--format", "text"]);
    expect(text.code).toBe(0);
    for (const name of ["api-docs", "docs"]) {
      expect(block(text.stdout, name), name).not.toContain("would emit");
      expect(block(text.stdout, name), name).toContain("run by `meta docs`");
    }
    expect(block(text.stdout, "entity")).toContain("would emit 1");
    expect(block(text.stdout, "mermaid-er")).toContain("would emit 1");
  });

  test("--probe --format json: wouldEmit is null beside the door, never 0", async () => {
    const r = await meta(WIRED, ["gen", "--list", "--probe", "--format", "json"]);
    expect(r.code).toBe(0);
    const rows = rowsOf(r.stdout);
    for (const name of ["api-docs", "docs"]) {
      const p = row(rows, name).project;
      expect(p?.wouldEmit, name).toBeNull();
      expect(p?.probeError, name).toBeUndefined();
      expect(p?.wired, name).toBe(true);
      expect(row(rows, name).door, name).toBe("meta docs");
    }
    expect(row(rows, "entity").project?.wouldEmit).toBe(1);
  });
});

describe("meta verify — a doc generator under `generators` is an advisory", () => {
  interface VerifyPayload {
    exitCode: number;
    help: string[];
    antiPatterns: { status: string; total: number; rows: { file: string; rule: string; construct: string; message: string }[] };
  }

  test("json: one advisory row per wired doc generator, and a next step", async () => {
    const r = await meta(WIRED, ["verify", "--format", "json"]);
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as VerifyPayload;
    const rows = payload.antiPatterns.rows.filter((x) => x.rule === "doc-generator-in-gen");
    expect(rows.map((x) => x.message).join("\n")).toContain("apiDocsFile()");
    expect(rows.map((x) => x.message).join("\n")).toContain("docsFile()");
    expect(rows).toHaveLength(2);
    for (const x of rows) {
      expect(x.file).toBe("metaobjects.config.ts");
      expect(x.construct).toBe("meta docs");
    }
    expect(payload.help.some((h) => h.includes("doc-generator-in-gen"))).toBe(true);
    // Advisory: it never reaches the exit code.
    expect(payload.exitCode).toBe(0);
  });

  test("text: the advisory is printed, and names the docs gate", async () => {
    const r = await meta(WIRED, ["verify", "--format", "text"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("apiDocsFile()");
    expect(r.stderr).toContain("meta verify --docs");
  });

  test("a stable-name string is caught too", async () => {
    const r = await meta(`["entity", "api-docs"]`, ["verify", "--format", "json"]);
    const payload = JSON.parse(r.stdout) as VerifyPayload;
    expect(payload.antiPatterns.rows.filter((x) => x.rule === "doc-generator-in-gen")).toHaveLength(1);
  });

  test("a config with no doc generator gets no such row", async () => {
    const r = await meta(`["entity", mermaidErDiagram()]`, ["verify", "--format", "json"]);
    const payload = JSON.parse(r.stdout) as VerifyPayload;
    expect(payload.antiPatterns.rows.filter((x) => x.rule === "doc-generator-in-gen")).toEqual([]);
  });
});
