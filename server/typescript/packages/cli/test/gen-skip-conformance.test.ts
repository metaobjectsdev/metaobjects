// ADR-0064 — the shared case table, `fixtures/codegen-skip-conformance/cases.json`, run
// against a TypeScript project: run `meta gen` once, apply each case's change, then ask
// the skip decision `meta gen` makes (after loading the model, before rendering) and the
// one a local `verify --codegen` makes.
//
// A case id this runner does not know fails, so a case added to the table reaches this
// port at once.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { genCommand } from "../src/commands/gen.js";
import { run } from "../src/index.js";
import { parseGenArgs } from "../src/lib/args.js";
import { genMaySkip } from "../src/lib/gen-skip.js";
import {
  FINGERPRINT_FILE, computeGenInputs, decideGenSkip, decideVerifyNoDrift, isCi, withModel,
  type FingerprintEntry, type GenSelection,
} from "../src/lib/gen-fingerprint.js";
import { collectionLoadOptions } from "../src/lib/collection-load-options.js";
import { loadMemory, resolveCollection } from "@metaobjectsdev/sdk";
import { modelHashTree } from "@metaobjectsdev/codegen-ts";

const CASES = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../../../../fixtures/codegen-skip-conformance/cases.json"), "utf-8",
)) as { cases: { id: string; gen: "skip" | "regenerate"; verify: "may-answer-no-drift" | "must-render" }[] };

// Inside the monorepo, so the config's `@metaobjectsdev/*` imports resolve as in the other
// command tests.
const WORKSPACE_TMP = resolve(import.meta.dirname, "fixtures/__tmp__");
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const AUDITED = (extra: unknown[] = []) => ({
  "object.entity": {
    name: "Audited",
    abstract: true,
    children: [{ "field.string": { name: "note" } }, ...extra],
  },
});

const entity = (name: string, table: string, parent?: string) => ({
  "object.entity": {
    name,
    ...(parent !== undefined ? { extends: parent } : {}),
    children: [
      { "source.rdb": { "@table": table } },
      { "field.long": { name: "id" } },
      { "field.string": { name: "title" } },
      { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
    ],
  },
});

const meta = (pkg: string, ...children: unknown[]) =>
  JSON.stringify({ "metadata.root": { package: pkg, children } }, null, 2) + "\n";

const OWNED = `import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** An owned generator that reads a file of its own, declared as an extra input. */
export function mine(opts: { cache?: boolean } = {}) {
  return {
    name: "mine",
    inputs: ["extra.txt"],
    ...(opts.cache === false ? { cache: false } : {}),
    generate(ctx: { inputRoot?: string; projectRoot?: string }) {
      const dir = ctx.inputRoot ?? ctx.projectRoot ?? ".";
      // A tally of renders, so a test can tell a skipped run from one that rendered.
      appendFileSync(join(dir, "renders.log"), "x");
      const text = readFileSync(join(dir, "extra.txt"), "utf-8");
      if (text.includes("boom")) throw new Error("boom");
      return [{ path: "mine.txt", content: text }];
    },
  };
}
`;

const config = (mineArgs = "", docs = false) => `import { defineConfig } from "@metaobjectsdev/codegen-ts";
${docs ? 'import { docsFile, templateGenerator } from "@metaobjectsdev/codegen-ts/generators";\n' : ""}import { mine } from "./codegen/generators/mine";
export default defineConfig({
  outDir: "generated",
  dialect: "sqlite",
  dbImport: "~/db",
  extStyle: "none",
${docs ? '  targets: { docs: { outDir: "./docs/generated" } },\n' : ""}  generators: ["entity", mine(${mineArgs})${docs
    ? ', templateGenerator({ name: "note", template: "note", scope: "perEntity", outputPattern: "notes/{name}.txt" }), docsFile()'
    : ""}],
});
`;

interface Project { root: string; }

function makeProject(opts: { uncacheable?: boolean; docs?: boolean } = {}): Project {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(WORKSPACE_TMP, "gen-skip-"));
  made.push(root);
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "metaobjects"));
  mkdirSync(join(root, ".metaobjects"));
  mkdirSync(join(root, "templates"));
  mkdirSync(join(root, "codegen", "generators"), { recursive: true });
  writeFileSync(join(root, "metaobjects", "meta.shop.json"), meta("shop", entity("Order", "orders", "Audited")));
  writeFileSync(join(root, "metaobjects", "meta.audit.json"), meta("shop", AUDITED()));
  writeFileSync(join(root, "metaobjects", "meta.crm.json"), meta("crm", entity("Customer", "customers")));
  writeFileSync(join(root, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1, sources: [] }, null, 2) + "\n");
  writeFileSync(join(root, "templates", "note.mustache"), "{{name}}\n");
  writeFileSync(join(root, "codegen", "generators", "mine.ts"), OWNED);
  writeFileSync(join(root, "extra.txt"), "extra\n");
  writeFileSync(join(root, "README.md"), "a project\n");
  writeFileSync(join(root, "metaobjects.config.ts"), config(opts.uncacheable === true ? "{ cache: false }" : "", opts.docs === true));
  return { root };
}

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log; const err = console.error;
  console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.error = err; }
};

const gen = (p: Project, args: string[] = []) => quiet(() => genCommand(args, p.root, "text"));
const stateFile = (p: Project) => join(p.root, ".metaobjects", ".gen-state", FINGERPRINT_FILE);

/** The inputs `meta gen` and `verify` decide from: the generator half, then the loaded model. */
async function inputsFor(p: Project, selection: GenSelection, engine?: FingerprintEntry[]) {
  const c = await resolveCollection(p.root);
  const root = await loadMemory(c.configDir, collectionLoadOptions(c));
  return withModel(computeGenInputs(p.root, c, c, selection, engine), modelHashTree(root));
}

const selectionOf = (flags: ReturnType<typeof parseGenArgs>): GenSelection => ({
  entities: flags.entities, generators: flags.generators, strict: flags.strict, baseline: flags.baseline,
});

async function genSkips(p: Project, r: Runner): Promise<boolean> {
  const flags = parseGenArgs(r.args ?? []);
  if (!genMaySkip(flags)) return false;
  return decideGenSkip(await inputsFor(p, selectionOf(flags), r.engine)).skip;
}

/**
 * The local `verify --codegen` shortcut. `full` is verify's spelling of `--force`. Verify
 * itself takes no selection flags, so a changed selection is asked as the shortcut sees it:
 * inputs read with that selection against the key the default run stored.
 */
async function verifyMayAnswer(p: Project, r: Runner): Promise<boolean> {
  if (r.full === true || isCi(r.env ?? {})) return false;
  const flags = parseGenArgs(r.args?.filter((a) => a !== "--force") ?? []);
  return decideVerifyNoDrift(await inputsFor(p, selectionOf(flags), r.engine)).skip;
}

/** One case: what to change, and how to ask afterwards. */
interface Runner {
  uncacheable?: boolean;
  /** Also configure a `template` generator and a docs page generator. */
  docs?: boolean;
  change?: (p: Project) => void | Promise<void>;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  engine?: FingerprintEntry[];
  /** `verify --codegen --full`. */
  full?: boolean;
  /** Checked after both answers: what the read-only questions must have left alone. */
  after?: (p: Project) => void | Promise<void>;
}

/** Every file under `dir`, recursively, with its bytes and modification time. */
const snapshotTree = (dir: string): [string, string, number][] =>
  !existsSync(dir) ? [] : readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e): [string, string, number] => {
      const f = join(e.parentPath, e.name);
      return [f, readFileSync(f, "utf-8"), statSync(f).mtimeMs];
    })
    .sort((a, b) => a[0].localeCompare(b[0]));

const append = (path: string, text: string) => writeFileSync(path, readFileSync(path, "utf-8") + text);

const RUNNERS: Record<string, Runner> = {
  "no-change": {},
  "metadata-touched": {
    change: (p) => {
      const f = join(p.root, "metaobjects", "meta.shop.json");
      writeFileSync(f, readFileSync(f));
      const later = new Date(Date.now() + 60_000);
      utimesSync(f, later, later);
    },
  },
  "unrelated-file-edited": { change: (p) => append(join(p.root, "README.md"), "more\n") },
  "metadata-reformatted": {
    // Same content, no indentation, every object's keys in reverse order.
    change: (p) => {
      const f = join(p.root, "metaobjects", "meta.shop.json");
      const reverse = (v: unknown): unknown => Array.isArray(v) ? v.map(reverse)
        : v !== null && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverse(x)]))
          : v;
      writeFileSync(f, JSON.stringify(reverse(JSON.parse(readFileSync(f, "utf-8")))));
    },
  },
  "metadata-moved": {
    change: (p) => {
      unlinkSync(join(p.root, "metaobjects", "meta.crm.json"));
      writeFileSync(join(p.root, "metaobjects", "meta.customers.json"), meta("crm", entity("Customer", "customers")));
    },
  },
  "metadata-edited": {
    change: (p) => writeFileSync(join(p.root, "metaobjects", "meta.shop.json"),
      meta("shop", entity("Order", "orders", "Audited"), entity("Invoice", "invoices"))),
  },
  "metadata-added": { change: (p) => writeFileSync(join(p.root, "metaobjects", "meta.billing.json"), meta("billing", entity("Bill", "bills"))) },
  "metadata-removed": { change: (p) => unlinkSync(join(p.root, "metaobjects", "meta.crm.json")) },
  "parent-edited": {
    change: (p) => writeFileSync(join(p.root, "metaobjects", "meta.audit.json"),
      meta("shop", AUDITED([{ "field.string": { name: "reason" } }]))),
  },
  "config-edited": { change: (p) => writeFileSync(join(p.root, "metaobjects.config.ts"), config().replace('"entity", ', "")) },
  "project-config-edited": {
    change: (p) => writeFileSync(join(p.root, ".metaobjects", "config.json"),
      JSON.stringify({ schema_version: 1, sources: [], libraries: [] }, null, 2) + "\n"),
  },
  "template-edited": { change: (p) => append(join(p.root, "templates", "note.mustache"), "{{title}}\n") },
  "template-added": { change: (p) => writeFileSync(join(p.root, "templates", "other.mustache"), "x\n") },
  "owned-generator-edited": { change: (p) => append(join(p.root, "codegen", "generators", "mine.ts"), "// edited\n") },
  "engine-changed": { engine: [{ kind: "engine", name: "@metaobjectsdev/cli/package.json", hash: "a-different-engine" }] },
  "selection-changed": { args: ["--strict"] },
  "declared-extra-edited": { change: (p) => append(join(p.root, "extra.txt"), "more\n") },
  "uncacheable-generator": { uncacheable: true },
  "generated-file-deleted": { change: (p) => unlinkSync(join(p.root, "generated", "mine.txt")) },
  "generated-file-edited": { change: (p) => append(join(p.root, "generated", "mine.txt"), "hand edit\n") },
  "hand-edit-kept": {
    change: async (p) => {
      append(join(p.root, "generated", "mine.txt"), "hand edit\n");
      expect(await gen(p)).toBe(0);
      expect(readFileSync(join(p.root, "generated", "mine.txt"), "utf-8")).toContain("hand edit");
    },
  },
  "fingerprint-missing": { change: (p) => unlinkSync(stateFile(p)) },
  // ADR-0064 Amendment 1: put the manifest back in its pre-1.3.0 single-file form.
  "legacy-manifest": {
    change: (p) => {
      const state = join(p.root, ".metaobjects", ".gen-state");
      const merged: Record<string, unknown> = {};
      for (const name of readdirSync(join(state, ".hashes")).sort()) {
        Object.assign(merged, JSON.parse(readFileSync(join(state, ".hashes", name), "utf-8")));
      }
      rmSync(join(state, ".hashes"), { recursive: true, force: true });
      writeFileSync(join(state, ".hashes.json"), JSON.stringify(merged, null, 2) + "\n");
    },
    // A local verify reads the union and migrates nothing, so the legacy file is still there.
    after: (p) => {
      expect(existsSync(join(p.root, ".metaobjects", ".gen-state", ".hashes.json"))).toBe(true);
    },
  },
  "force": { args: ["--force"], full: true },
  "template-and-docs-rerun": {
    docs: true,
    after: async (p) => {
      // The first run really wrote the template output and the docs page.
      expect(existsSync(join(p.root, "generated", "notes", "Order.txt"))).toBe(true);
      expect(snapshotTree(join(p.root, "docs", "generated")).length).toBeGreaterThan(0);
      const watched = () => [
        ...snapshotTree(join(p.root, "generated")),
        ...snapshotTree(join(p.root, "docs", "generated")),
        ...snapshotTree(join(p.root, ".metaobjects", ".gen-state", ".hashes")),
      ];
      const before = watched();
      await new Promise((r) => setTimeout(r, 20));
      // A forced run renders everything again and writes zero files.
      expect(await gen(p, ["--force"])).toBe(0);
      expect(watched()).toEqual(before);
    },
  },
  "ci": { env: { CI: "true" } },
  "failed-run": {
    change: async (p) => {
      const extra = join(p.root, "extra.txt");
      const before = readFileSync(extra);
      writeFileSync(extra, "boom\n");
      expect(await gen(p)).not.toBe(0);
      writeFileSync(extra, before);
    },
  },
};

describe("codegen-skip-conformance (ADR-0064)", () => {
  test("every case in the table has a runner, and every runner a case", () => {
    expect(CASES.cases.map((c) => c.id).sort()).toEqual(Object.keys(RUNNERS).sort());
  });

  for (const c of CASES.cases) {
    test(`${c.id}: gen ${c.gen}, verify ${c.verify}`, async () => {
      const runner = RUNNERS[c.id];
      if (runner === undefined) throw new Error(`no runner for case "${c.id}"`);
      const p = makeProject({ uncacheable: runner.uncacheable === true, docs: runner.docs === true });
      expect(await gen(p)).toBe(0);
      expect(existsSync(stateFile(p))).toBe(runner.uncacheable !== true);
      await runner.change?.(p);
      expect(await genSkips(p, runner)).toBe(c.gen === "skip");
      expect(await verifyMayAnswer(p, runner)).toBe(c.verify === "may-answer-no-drift");
      await runner.after?.(p);
    }, 30_000);
  }
});

describe("meta gen with nothing changed (ADR-0064)", () => {
  test("renders nothing and writes nothing: no file, the manifest and the stored key included", async () => {
    const p = makeProject();
    expect(await gen(p)).toBe(0);
    const watched = [
      join(p.root, "generated", "mine.txt"),
      join(p.root, ".metaobjects", ".gen-state", ".hashes", ".root.json"),
      stateFile(p),
    ];
    const before = watched.map((f) => statSync(f).mtimeMs);
    const renders = readFileSync(join(p.root, "renders.log"), "utf-8");
    await new Promise((r) => setTimeout(r, 20));
    expect(await gen(p)).toBe(0);
    expect(watched.map((f) => statSync(f).mtimeMs)).toEqual(before);
    expect(readFileSync(join(p.root, "renders.log"), "utf-8")).toBe(renders);
    // --force renders again.
    expect(await gen(p, ["--force"])).toBe(0);
    expect(readFileSync(join(p.root, "renders.log"), "utf-8").length).toBeGreaterThan(renders.length);
  }, 30_000);

  test("a full run that changes nothing rewrites no generated file and no manifest", async () => {
    const p = makeProject();
    expect(await gen(p)).toBe(0);
    const watched = [
      join(p.root, "generated", "mine.txt"),
      join(p.root, ".metaobjects", ".gen-state", ".hashes", ".root.json"),
    ];
    const before = watched.map((f) => statSync(f).mtimeMs);
    await new Promise((r) => setTimeout(r, 20));
    expect(await gen(p, ["--force"])).toBe(0);
    expect(watched.map((f) => statSync(f).mtimeMs)).toEqual(before);
    expect(existsSync(stateFile(p))).toBe(true);
  }, 30_000);

  test("a run after an input change regenerates and stores a new fingerprint", async () => {
    const p = makeProject();
    expect(await gen(p)).toBe(0);
    const firstKey = readFileSync(stateFile(p), "utf-8");
    writeFileSync(join(p.root, "extra.txt"), "changed\n");
    expect(await gen(p)).toBe(0);
    expect(readFileSync(join(p.root, "generated", "mine.txt"), "utf-8")).toBe("changed\n");
    expect(readFileSync(stateFile(p), "utf-8")).not.toBe(firstKey);
    expect(await genSkips(p, {})).toBe(true);
  }, 30_000);

  test("a run that names entities renders, and neither writes nor satisfies the full-run key", async () => {
    const p = makeProject();
    expect(await gen(p)).toBe(0);
    const key = readFileSync(stateFile(p), "utf-8");
    const renders = readFileSync(join(p.root, "renders.log"), "utf-8");
    expect(await gen(p, ["Order"])).toBe(0);
    expect(readFileSync(join(p.root, "renders.log"), "utf-8").length).toBeGreaterThan(renders.length);
    expect(readFileSync(stateFile(p), "utf-8")).toBe(key);
    // The full-run key is still the full run's: the next full run skips.
    expect(await genSkips(p, {})).toBe(true);
    // And a narrowed run repeated over unchanged inputs still renders.
    expect(await genSkips(p, { args: ["Order"] })).toBe(false);
  }, 30_000);

  test("--dry-run neither skips nor stores a fingerprint", async () => {
    const p = makeProject();
    expect(await gen(p, ["--dry-run"])).toBe(0);
    expect(existsSync(stateFile(p))).toBe(false);
  }, 30_000);
});

describe("an output outside the project root (ADR-0064)", () => {
  test("a deleted output there makes the next gen and the local verify shortcut render", async () => {
    const p = makeProject();
    const outside = mkdtempSync(join(WORKSPACE_TMP, "gen-skip-out-"));
    made.push(outside);
    writeFileSync(join(p.root, "metaobjects.config.ts"),
      config().replace('outDir: "generated"', `outDir: ${JSON.stringify(outside)}`));
    expect(await gen(p)).toBe(0);
    expect(existsSync(join(outside, "mine.txt"))).toBe(true);
    expect(await genSkips(p, {})).toBe(true);

    unlinkSync(join(outside, "mine.txt"));

    expect(await genSkips(p, {})).toBe(false);
    expect(await verifyMayAnswer(p, {})).toBe(false);
    expect(await gen(p)).toBe(0);
    expect(existsSync(join(outside, "mine.txt"))).toBe(true);
  }, 30_000);
});

describe("an orphan the sweep refuses to delete (ADR-0064)", () => {
  test("stores no key, so the next gen runs again and repeats the refusal", async () => {
    const p = makeProject();
    expect(await gen(p)).toBe(0);
    expect(existsSync(stateFile(p))).toBe(true);
    const orphan = join(p.root, "generated", "Customer.ts");
    expect(existsSync(orphan)).toBe(true);
    append(orphan, "// mine\n");
    unlinkSync(join(p.root, "metaobjects", "meta.crm.json"));

    expect(await gen(p)).toBe(0);
    expect(existsSync(orphan)).toBe(true);
    expect(existsSync(stateFile(p))).toBe(false);
    expect(await genSkips(p, {})).toBe(false);
  }, 30_000);
});

describe("verify --codegen renders in memory (ADR-0064)", () => {
  test("a full render writes no temp tree and no file anywhere", async () => {
    const p = makeProject();
    expect(await gen(p)).toBe(0);
    const scratch = mkdtempSync(join(WORKSPACE_TMP, "verify-scratch-"));
    made.push(scratch);
    const saved = { TMPDIR: process.env.TMPDIR, DEV_SCRATCH: process.env.DEV_SCRATCH };
    process.env.TMPDIR = scratch;
    process.env.DEV_SCRATCH = scratch;
    const genState = join(p.root, ".metaobjects", ".gen-state");
    const before = fs.readdirSync(genState).map((f) => [f, statSync(join(genState, f)).mtimeMs]);
    try {
      expect(await quiet(() => run(["verify", "--cwd", p.root, "--codegen", "--full"]))).toBe(0);
      // A hand edit is still found, in memory.
      append(join(p.root, "generated", "mine.txt"), "x\n");
      await quiet(() => run(["verify", "--cwd", p.root, "--codegen", "--full"]));
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
    // `jiti`, the config loader's own transpile cache, is the only thing allowed there.
    expect(fs.readdirSync(scratch).filter((f) => f !== "jiti")).toEqual([]);
    expect(fs.readdirSync(genState).map((f) => [f, statSync(join(genState, f)).mtimeMs])).toEqual(before);
  }, 60_000);
});

