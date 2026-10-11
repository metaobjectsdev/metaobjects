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

interface RepoOpts {
  /** Statements placed before the config's `export default`. */
  extra?: string;
  /** The config's `docs` block, as an object literal. Absent means no `docs` key. */
  docs?: string;
}

/** `generators` is the config's array literal, verbatim. */
function setupRepo(generators: string, opts: RepoOpts = {}): string {
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
import { apiDocsFile, docsFile } from "@metaobjectsdev/codegen-ts/generators";
${opts.extra ?? ""}
export default defineConfig({
  outDir: "generated",
  dialect: "sqlite",
  dbImport: "../db",
  extStyle: "none",
  generators: ${generators},${opts.docs !== undefined ? `\n  docs: ${opts.docs},` : ""}
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
async function meta(generators: string, args: string[], opts: RepoOpts = {}):
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
  project?: { wired: boolean; refused?: true; wiredInDocsDoor?: true; wouldEmit: number | null; probeError?: string };
}

const WIRED = `["entity", apiDocsFile(), docsFile()]`;

/**
 * An owned docs generator, as `meta eject docs` leaves one: the packaged generator's
 * name, and the `docsSurface` marker that says which surface it takes over.
 */
const OWNED_DOCS = `const ownedDocs = { name: "docs-file", docsSurface: "model" as const, generate: () => [] };`;
const OWNED_MOVE_WARNING =
  "[docs-file] is a docs generator: 'meta docs' runs it, from `docs: { generators: [...] }` " +
  "in metaobjects.config.ts, and 'meta gen' does not. Move it there. Skipped.";

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

const NEUTRAL_REFUSAL = (name: string): string =>
  `generator "${name}" is neutral (owned by 'meta docs'); not selectable in the gen suite.`;

const MERMAID_ER_REMOVED = 'generator "mermaid-er" was removed in 1.1: `meta docs` draws the ER diagram';

describe("meta gen — a doc generator's stable name is refused: `docs` as neutral, `mermaid-er` as removed", () => {
  // 1.1 removed the standalone `mermaid-er` generator (ADR-0022 Part 2 D1, as amended):
  // `meta docs` draws the diagram. The name is told so, not called neutral or unknown.
  test("the stable name `mermaid-er` is refused as removed, and nothing is written", async () => {
    const root = setupRepo(`["entity", "mermaid-er"]`);
    try {
      expect(await run(["gen", "--format", "json", "--cwd", root])).not.toBe(0);
      const said = err.join("\n");
      expect(said).toContain(MERMAID_ER_REMOVED);
      expect(said).toContain('Remove "mermaid-er" from `generators` and run `meta docs`.');
      expect(said).not.toContain("is neutral");
      expect(said).not.toContain("unknown generator");
      expect(existsSync(join(root, "generated"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the stable name `docs` is refused the same way: `meta docs` owns it", async () => {
    const r = await meta(`["entity", "docs"]`, ["gen", "--format", "json"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(NEUTRAL_REFUSAL("docs"));
  });

  test("an unknown name is not offered a neutral name or a skipped one", async () => {
    const r = await meta(`["entity", "no-such-generator"]`, ["gen", "--format", "json"]);
    expect(r.code).not.toBe(0);
    const offered = (/Available native generators: ([^.]*)\./.exec(r.stderr)?.[1] ?? "")
      .split(",").map((s) => s.trim());
    expect(offered).toContain("entity");
    for (const name of ["mermaid-er", "docs", "api-docs"]) expect(offered, name).not.toContain(name);
    expect(r.stderr).toContain("run 'meta docs'");
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

describe("meta gen — an owned docs generator under `generators` is skipped and told where it goes", () => {
  // ADR-0034 Amendment 7. The runner skips it by its `docsSurface` marker. Before it was
  // also REPORTED as skipped, a config wiring only an owned copy read "no entities to
  // generate", and the next step for any skipped doc generator was "remove it".
  test("json: wired alone, the summary names the real reason and the next step is to MOVE it", async () => {
    const r = await meta(`[ownedDocs]`, ["gen", "--format", "json"], { extra: OWNED_DOCS });
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as GenPayload;
    expect(payload.gen).toEqual([]);
    expect(payload.summary).toContain("doc generator");
    expect(payload.summary).not.toContain("no entities");
    expect(payload.warnings).toEqual([OWNED_MOVE_WARNING]);
    expect(payload.help).toEqual([
      "run `meta docs` for documentation, and move the owned docs generators from `generators` " +
        "to `docs: { generators: [...] }` in metaobjects.config.ts",
    ]);
    expect(payload.help.join("\n")).not.toContain("remove");
    expect(payload.help.join("\n")).not.toContain("author entities");
  });

  test("text: wired alone, stdout names the real reason", async () => {
    const r = await meta(`[ownedDocs]`, ["gen", "--format", "text"], { extra: OWNED_DOCS });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("No entities to generate");
    expect(r.stdout).toContain("every wired generator is a doc generator");
    expect(r.stderr).toContain(OWNED_MOVE_WARNING);
  });

  test("json: beside a packaged one, the next step says which to move and which to remove", async () => {
    const r = await meta(`["entity", ownedDocs, apiDocsFile()]`, ["gen", "--format", "json"], { extra: OWNED_DOCS });
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as GenPayload;
    expect(payload.gen.map((g) => g.file)).toEqual(["generated/Talk.ts"]);
    expect(payload.warnings).toContain(OWNED_MOVE_WARNING);
    expect(payload.warnings?.some((w) => w.includes(API_DOCS_SKIP))).toBe(true);
    const step = payload.help.find((h) => h.includes("skipped 2 doc generator(s)"));
    expect(step).toContain(
      "move the owned docs generators from `generators` to `docs: { generators: [...] }` and remove the packaged ones",
    );
  });

  test("where it belongs, in `docs.generators`, `meta gen` says nothing about it", async () => {
    const r = await meta(`["entity"]`, ["gen", "--format", "json"], {
      extra: OWNED_DOCS,
      docs: `{ generators: [ownedDocs] }`,
    });
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as GenPayload;
    expect(payload.warnings).toBeUndefined();
    expect(payload.help.some((h) => h.includes("meta docs"))).toBe(false);
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

  // The standalone `mermaid-er` generator was removed in 1.1, so the catalog has no row
  // for it, in either form, and a config that still names it does not break the listing.
  test("text: there is no mermaid-er row", async () => {
    const r = await meta(`["entity"]`, ["gen", "--list", "--format", "text"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("mermaid-er");
  });

  test("json: a config that still names it lists cleanly, with no row for it", async () => {
    const r = await meta(`["entity", "mermaid-er"]`, ["gen", "--list", "--format", "json"]);
    expect(r.code).toBe(0);
    expect(rowsOf(r.stdout).some((x) => x.name === "mermaid-er")).toBe(false);
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

  // A neutral name written as a string is not skipped: `meta gen` refuses it and exits
  // non-zero (asserted above). The mark has to say that.
  const BY_NAME = `["entity", "docs", "api-docs"]`;

  test("text: a neutral name wired as a string reads as refused, not skipped or run", async () => {
    const r = await meta(BY_NAME, ["gen", "--list", "--format", "text"]);
    expect(r.code).toBe(0);
    for (const name of ["docs"]) {
      const b = block(r.stdout, name);
      expect(b, name).toContain("WIRED by name, which `meta gen` refuses");
      expect(b, name).not.toContain("WIRED but skipped");
      expect(b, name).not.toMatch(/WIRED[,\]]/);
      expect(b, name).toContain("its name as a string under `generators` is refused");
    }
    // `"api-docs"` resolves, and the runner skips it: the skip wording stands.
    expect(block(r.stdout, "api-docs")).toContain("WIRED but skipped by `meta gen`");
    expect(block(r.stdout, "api-docs")).not.toContain("refuse");
    expect(block(r.stdout, "entity")).not.toContain("refuse");
  });

  test("json: the refusal is on the row's project facts", async () => {
    const r = await meta(BY_NAME, ["gen", "--list", "--format", "json"]);
    const rows = rowsOf(r.stdout);
    for (const name of ["docs"]) {
      expect(row(rows, name).project?.wired, name).toBe(true);
      expect(row(rows, name).project?.refused, name).toBe(true);
    }
    expect(row(rows, "api-docs").project?.wired).toBe(true);
    expect(row(rows, "api-docs").project?.refused).toBeUndefined();
    expect(row(rows, "entity").project?.refused).toBeUndefined();
  });

  test("a constructed docsFile() is skipped, not refused: only the name is refused", async () => {
    const r = await meta(`["entity", docsFile()]`, ["gen", "--list", "--format", "json"]);
    const rows = rowsOf(r.stdout);
    expect(row(rows, "docs").project?.wired).toBe(true);
    expect(row(rows, "docs").project?.refused).toBeUndefined();
  });

  // ADR-0034 Amendment 7: an owned docs generator is listed in the docs block, and
  // `meta docs` runs it from there. The row has to show that it is in use: read off
  // `generators` alone, a correctly wired copy looked like one nobody runs.
  const IN_DOCS_DOOR: RepoOpts = { extra: OWNED_DOCS, docs: `{ generators: [ownedDocs] }` };

  test("json: an owned docs generator in `docs.generators` reads as wired in the docs door", async () => {
    const r = await meta(`["entity"]`, ["gen", "--list", "--format", "json"], IN_DOCS_DOOR);
    expect(r.code).toBe(0);
    const rows = rowsOf(r.stdout);
    expect(row(rows, "docs").project?.wiredInDocsDoor).toBe(true);
    expect(row(rows, "docs").project?.wired).toBe(false);
    // Keyed by surface: the api surface was not taken over.
    expect(row(rows, "api-docs").project?.wiredInDocsDoor).toBeUndefined();
    expect(row(rows, "entity").project?.wiredInDocsDoor).toBeUndefined();
  });

  test("text: the row says where it is wired, and does not call it skipped", async () => {
    const r = await meta(`["entity"]`, ["gen", "--list", "--format", "text"], IN_DOCS_DOOR);
    expect(r.code).toBe(0);
    expect(block(r.stdout, "docs")).toContain("WIRED in `docs.generators`");
    expect(block(r.stdout, "docs")).not.toContain("WIRED but skipped");
    expect(block(r.stdout, "api-docs")).not.toContain("WIRED");
  });

  test("the same copy under `generators` reads as skipped, and not as wired in the docs door", async () => {
    const r = await meta(`["entity", ownedDocs]`, ["gen", "--list", "--format", "json"], { extra: OWNED_DOCS });
    const rows = rowsOf(r.stdout);
    expect(row(rows, "docs").project?.wired).toBe(true);
    expect(row(rows, "docs").project?.wiredInDocsDoor).toBeUndefined();
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

  test("a stable-name string the runner skips is caught too, with the skip wording", async () => {
    const r = await meta(`["entity", "api-docs"]`, ["verify", "--format", "json"]);
    const payload = JSON.parse(r.stdout) as VerifyPayload;
    const rows = payload.antiPatterns.rows.filter((x) => x.rule === "doc-generator-in-gen");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toContain("`meta gen` skips it");
    expect(payload.antiPatterns.rows.filter((x) => x.rule === "doc-generator-refused-by-gen")).toEqual([]);
    expect(payload.help.join("\n")).not.toContain("refuses");
  });

  // `meta gen` exits non-zero on these two strings (asserted in the refused-name block
  // above), so calling them skipped told the reader the run goes on without them.
  test("json: a neutral or removed name wired as a string is reported as refused, not skipped", async () => {
    const r = await meta(`["entity", "docs", "mermaid-er"]`, ["verify", "--format", "json"]);
    const payload = JSON.parse(r.stdout) as VerifyPayload;
    const rows = payload.antiPatterns.rows.filter((x) => x.rule === "doc-generator-refused-by-gen");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.message).toContain(`"docs" is listed under \`generators\`, and \`meta gen\` refuses it`);
    // The removed name carries the message `meta gen` fails with, word for word.
    expect(rows[1]?.message).toBe(
      `metaobjects.config.ts: ${MERMAID_ER_REMOVED}, for the whole model on its overview page (README.md) ` +
        `and around each entity on that entity's page. Remove "mermaid-er" from \`generators\` and run \`meta docs\`.`,
    );
    for (const x of rows) {
      expect(x.message).not.toContain("skips");
      expect(x.message).toContain("Remove");
      expect(x.file).toBe("metaobjects.config.ts");
    }
    expect(payload.antiPatterns.rows.filter((x) => x.rule === "doc-generator-in-gen")).toEqual([]);
    const help = payload.help.filter((h) => h.includes("doc-generator-refused-by-gen"));
    expect(help).toHaveLength(1);
    expect(help[0]).toContain("which `meta gen` refuses");
    expect(help[0]).not.toContain("skips");
  });

  test("text: the refused name is printed as refused", async () => {
    const r = await meta(`["entity", "docs"]`, ["verify", "--format", "text"]);
    expect(r.stderr).toContain(`"docs" is listed under \`generators\`, and \`meta gen\` refuses it`);
    expect(r.stderr).not.toContain("`meta gen` skips");
  });

  // An owned docs generator under `generators` is skipped like a packaged one, and the
  // fix is the opposite. "Remove it" would tell its owner to stop using the copy they
  // ejected; it goes in the docs block, where `meta docs` runs it.
  test("an owned docs generator is told to MOVE to `docs.generators`, not to be removed", async () => {
    const r = await meta(`["entity", ownedDocs, apiDocsFile()]`, ["verify", "--format", "json"], { extra: OWNED_DOCS });
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as VerifyPayload;
    const rows = payload.antiPatterns.rows.filter((x) => x.rule === "doc-generator-in-gen");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.message).toBe(
      'metaobjects.config.ts: the owned docs generator "docs-file" is listed under `generators`, and ' +
        "`meta gen` skips it — `meta docs` runs an owned docs generator from `docs: { generators: [...] }`, " +
        "and `meta verify --docs` checks what it writes. Move it there.",
    );
    expect(rows[0]?.message).not.toContain("Remove");
    expect(rows[0]?.construct).toBe("meta docs");
    // The packaged one beside it keeps its own advice.
    expect(rows[1]?.message).toContain("Remove apiDocsFile() from `generators`.");
    expect(payload.exitCode).toBe(0);
  });

  test("the marker decides, not the name: a renamed owned copy is told the same", async () => {
    const extra = `const myPages = { name: "my-pages", docsSurface: "api" as const, generate: () => [] };`;
    const r = await meta(`["entity", myPages]`, ["verify", "--format", "text"], { extra });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('the owned docs generator "my-pages" is listed under `generators`');
    expect(r.stderr).toContain("Move it there.");
  });

  test("an owned docs generator where it belongs gets no row", async () => {
    const r = await meta(`["entity"]`, ["verify", "--format", "json"], {
      extra: OWNED_DOCS,
      docs: `{ generators: [ownedDocs] }`,
    });
    const payload = JSON.parse(r.stdout) as VerifyPayload;
    expect(payload.antiPatterns.rows.filter((x) => x.rule.startsWith("doc-generator-"))).toEqual([]);
  });
});
