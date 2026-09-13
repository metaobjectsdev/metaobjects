import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

/** The minimal persistable entity both `meta gen` probes below author into a freshly
 *  scaffolded project. One copy: a metadata-shape change (a newly required child, a
 *  renamed attr) would otherwise have to be applied twice, and missing one makes an
 *  unrelated test fail for a reason that has nothing to do with what it checks. */
const PROBE_ENTITY = JSON.stringify({
  metadata: {
    package: "probe",
    children: [{
      "object.entity": {
        name: "Author",
        children: [
          { "source.rdb": { "@table": "authors" } },
          { "field.string": { name: "id" } },
          { "identity.primary": { "@fields": ["id"] } },
        ],
      },
    }],
  },
}, null, 2);
import { init, initCommand, nextStepsBlock } from "../src/commands/init.js";
import { saveConfig, ConfigSchema } from "@metaobjectsdev/sdk";

// A scaffolded project that will run `meta gen` must live INSIDE this package, never in
// the OS tmpdir. `gen` loads metaobjects.config.ts, whose scaffolded generators import
// `@metaobjectsdev/codegen-ts`, and node resolution walks UP from the project directory.
// Under `test/fixtures/__tmp__/` that reaches cli's own node_modules — the workspace
// copies, plus the real deps the generated routes import (fastify, drizzle-orm, zod,
// runtime-ts) — the way an installed project resolves them. Under `/tmp` it reaches
// `/tmp/node_modules`, which on a developer box may hold a PUBLISHED @metaobjectsdev
// install left by a smoke test. Codegen then runs from that copy, and a second physical
// copy of `metadata` gives the loader's source guards a different class identity, so a
// `source.rdb` entity silently emits no queries and no routes — the test fails for a
// reason that has nothing to do with what it checks, and only on the boxes that have
// ever smoke-tested a published CLI.
// `__tmp__` is also the ONE gitignored slot for this (root .gitignore has `__tmp__/`):
// placed bare under `test/`, a dir surviving a crash or Ctrl-C — the `finally` never
// runs — puts a whole scaffolded project into `git status` and into this package's own
// typecheck, which compiles everything under `test/`.
function mkGenProjectDir(prefix: string): string {
  const tmpRoot = join(import.meta.dirname, "fixtures", "__tmp__");
  mkdirSync(tmpRoot, { recursive: true });
  return mkdtempSync(join(tmpRoot, prefix));
}

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "metaobjects-init-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("init() — next-steps message (S1)", () => {
  test("presents `meta gen` and `meta docs` as working steps, not as unshipped 'later sub-projects'", () => {
    const block = nextStepsBlock();
    // gen + docs work TODAY — they must be shown as actionable next steps.
    expect(block).toContain("meta gen");
    expect(block).toContain("meta docs");
    // ...and must NOT be lumped under the "ship in later sub-projects" framing
    // (only ingest/serve/install-hooks are actually unshipped — matches `meta --help`).
    expect(block).not.toMatch(/later sub-projects[\s\S]*meta gen\b/);
    expect(block).not.toMatch(/later sub-projects[\s\S]*meta docs\b/);
  });

  // The block once took a `dbStubWritten` flag, because the scaffold wrote a throwing
  // `src/db.ts` on some runs and not others while a static string claimed it on every
  // one. Nothing is wired now, so there is no `dbImport` and no stub — the message is
  // the same on every path, and must not mention a file init no longer writes.
  test("mentions no db stub, and routes the reader through the catalog", () => {
    const block = nextStepsBlock();
    expect(block).not.toContain("src/db.ts");
    expect(block).toContain("codegen/generators/");
    // The two commands that replace the wired-suite scaffold.
    expect(block).toContain("meta gen --list");
    expect(block).toContain("meta eject");
  });
});

describe("init() — root .gitignore (S2/newcomer hygiene)", () => {
  test("scaffolds a root .gitignore (ignoring node_modules) when absent", async () => {
    const result = await init({ cwd });
    expect(result.created).toContain(".gitignore");
    const ignore = readFileSync(join(cwd, ".gitignore"), "utf8");
    expect(ignore).toContain("node_modules");
  });

  test("does NOT clobber an existing root .gitignore", async () => {
    writeFileSync(join(cwd, ".gitignore"), "my-custom-entry/\n", "utf8");
    const result = await init({ cwd });
    const ignore = readFileSync(join(cwd, ".gitignore"), "utf8");
    expect(ignore).toContain("my-custom-entry/");
    expect(result.created).not.toContain(".gitignore");
    expect(result.preserved).toContain(".gitignore");
  });
});

describe("init() — happy path", () => {
  test("creates metaobjects/ and .metaobjects/ directory tree", async () => {
    const result = await init({ cwd });
    expect(result.created).toContain("metaobjects");
    expect(result.created).toContain(".metaobjects");
    expect(result.created).toContain(".metaobjects/config.json");
    expect(result.created).toContain(".metaobjects/.gitignore");

    expect(existsSync(join(cwd, "metaobjects"))).toBe(true);
    expect(existsSync(join(cwd, "metaobjects", "meta.common.json"))).toBe(true);
    expect(existsSync(join(cwd, ".metaobjects"))).toBe(true);
    expect(existsSync(join(cwd, ".metaobjects", ".gen-state"))).toBe(true);
  });

  // FR-023 — the v0.3 package.meta.json prototype is deprecated (nothing reads
  // it); `meta init` must no longer scaffold it. Fails if the removed scaffold
  // block (writing a { name, version, extends } manifest when absent) is restored.
  test("does NOT scaffold .metaobjects/package.meta.json (FR-023 — deprecated v0.3 manifest)", async () => {
    const result = await init({ cwd });
    const manifestPath = join(cwd, ".metaobjects", "package.meta.json");
    expect(existsSync(manifestPath)).toBe(false);
    expect(result.created).not.toContain(".metaobjects/package.meta.json");
  });

  // A pre-existing package.meta.json (from a project scaffolded before FR-023)
  // must be left exactly as it was — neither overwritten nor deleted — with its
  // deprecation surfaced as a warning. Fails if init overwrites or deletes the
  // file, or if the deprecation note regresses in wording or is dropped.
  test("leaves a pre-existing .metaobjects/package.meta.json untouched and warns it is deprecated", async () => {
    mkdirSync(join(cwd, ".metaobjects"), { recursive: true });
    const manifestPath = join(cwd, ".metaobjects", "package.meta.json");
    const existingManifest = JSON.stringify({ name: "legacy-pkg", version: "0.1.0", extends: [] }, null, 2) + "\n";
    writeFileSync(manifestPath, existingManifest, "utf8");

    const result = await init({ cwd, force: true });

    expect(readFileSync(manifestPath, "utf8")).toBe(existingManifest);
    expect(result.created).not.toContain(".metaobjects/package.meta.json");
    expect(result.warnings).toContain(
      "note: .metaobjects/package.meta.json is deprecated (nothing reads it; removed in 2.0) — see docs/features/metadata-dependencies.md",
    );
  });

  // The two new dependency-tooling files (deps.lock.json + the deps/ snapshot
  // directory, both written only by `meta deps sync`, never by init) must be
  // tracked rather than swept up by the per-target-shadow ignore pattern. Fails
  // if either negation is missing, or if the old package.meta.json negation lingers.
  test("scaffolded .metaobjects/.gitignore tracks deps/ and deps.lock.json, not package.meta.json", async () => {
    await init({ cwd });
    const ignore = readFileSync(join(cwd, ".metaobjects", ".gitignore"), "utf8");
    expect(ignore).toContain("!deps/");
    expect(ignore).toContain("!deps.lock.json");
    expect(ignore).not.toContain("!package.meta.json");
  });

  // FR-023 fix round 1 — `--print-only` previews what a real run will create; the
  // scaffold-removal above left an orphaned forecast entry at the printOnly branch
  // (a second, separate site from the removed scaffold block) that still named
  // .metaobjects/package.meta.json even though the real path never writes it. Fails
  // if that push is restored, since a real init run never produces this file.
  test("--print-only does not forecast .metaobjects/package.meta.json", async () => {
    const result = await init({ cwd, printOnly: true });
    expect(result.created).not.toContain(".metaobjects/package.meta.json");
  });

  test("writes a valid default config.json under .metaobjects/", async () => {
    await init({ cwd });
    const config = JSON.parse(readFileSync(join(cwd, ".metaobjects", "config.json"), "utf8"));
    expect(config.schema_version).toBe(1);
    expect(config.pending_in_git).toBe(true);
  });

  test("writes a .gitignore under .metaobjects/ that includes .gen-state", async () => {
    await init({ cwd });
    const ignore = readFileSync(join(cwd, ".metaobjects", ".gitignore"), "utf8");
    expect(ignore).toContain(".gen-state/");
  });

  // Issue #75 — a multi-target codegen config can route a target's outDir under
  // .metaobjects/<targetName>/src/generated/. That output is regenerable (re-run
  // `meta gen` recreates it) and must NOT be committed by default. The scaffolded
  // .gitignore must ignore the per-target shadow WITHOUT ignoring the tracked
  // migrations/ or config.json.
  test("scaffolded .gitignore ignores per-target generated shadow but tracks migrations/ and config.json", async () => {
    await init({ cwd });
    const ignore = readFileSync(join(cwd, ".metaobjects", ".gitignore"), "utf8");
    // The per-target generated shadow pattern is present.
    expect(ignore).toContain("*/src/generated/");
    // migrations/ and config.json are NOT ignored (they are meant to be tracked).
    const lines = ignore.split("\n").map((l) => l.trim());
    expect(lines).not.toContain("migrations/");
    expect(lines).not.toContain("migrations");
    expect(lines).not.toContain("config.json");
    // A negated re-include guard keeps migrations tracked even if a broad pattern
    // were ever to match.
    expect(ignore).toContain("!migrations/");
  });

  test("does NOT create legacy .meta/ directory", async () => {
    await init({ cwd });
    expect(existsSync(join(cwd, ".meta"))).toBe(false);
  });
});

// ADR-0034 Amendment 2 — `meta init` copies NO generators.
//
// This block used to pin the exact five it scaffolded, and the pin was load-bearing:
// looping over the full REFERENCE_GENERATOR_NAMES array had once made init silently
// start writing an unwired `routes-hono.ts` into every fresh project. Opt-in codegen
// removes the whole class — there is no eager set to drift — so what is pinned now is
// that the directory is EMPTY and the door still works.
describe("init() — the owned-codegen tier is empty on purpose", () => {
  test("creates codegen/generators/ and copies nothing into it", async () => {
    const result = await init({ cwd });
    const dir = join(cwd, "codegen", "generators");
    expect(existsSync(dir), "the directory is part of the promised layout").toBe(true);
    expect(readdirSync(dir)).toEqual([]);
    expect(result.created.filter((p) => p.startsWith("codegen/generators/"))).toEqual([]);
  });

  test("the scaffolded config wires nothing and points at the catalog", async () => {
    await init({ cwd });
    const configSrc = readFileSync(join(cwd, "metaobjects.config.ts"), "utf8");
    expect(configSrc).toContain("generators: []");
    // No IMPORT of an owned generator. The comment block deliberately NAMES the
    // directory (it is where `meta eject` puts things), so the assertion is on the
    // import statement, not on the string appearing anywhere in the file.
    expect(configSrc).not.toMatch(/^import .* from "\.\/codegen\/generators\//m);
    expect(configSrc).toContain("meta gen --list");
    expect(configSrc).toContain("meta eject");
  });

  test("--print-only forecasts the same: the tier, not files in it", async () => {
    const result = await init({ cwd, printOnly: true });
    expect(result.created).toContain("codegen/generators");
    expect(result.created.filter((p) => p.startsWith("codegen/generators/"))).toEqual([]);
  });

  test("every generator is reachable through `meta eject`", async () => {
    await init({ cwd });
    const { ejectGenerator } = await import("../src/commands/eject.js");
    for (const name of ["entity", "names", "routes-hono"]) {
      const r = await ejectGenerator({ cwd, name });
      expect(r.status, name).toBe("created");
      expect(existsSync(join(cwd, "codegen", "generators", `${name}.ts`)), name).toBe(true);
    }
  });

  test("adds no dependencies to package.json — nothing is wired, so nothing is needed", async () => {
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "x", version: "0.0.0" }));
    await init({ cwd });
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    for (const d of ["drizzle-orm", "zod", "fastify", "@metaobjectsdev/codegen-ts",
                     "@metaobjectsdev/metadata", "@metaobjectsdev/runtime-ts"]) {
      expect(declared, `must not declare ${d}`).not.toContain(d);
    }
  });

  test("still sets `type: module` — the ESM rule is unchanged", async () => {
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "x", version: "0.0.0" }));
    await init({ cwd });
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { type?: string };
    expect(pkg.type).toBe("module");
  });

  test("scaffolds no src/db.ts — there is no dbImport to resolve", async () => {
    await init({ cwd });
    expect(existsSync(join(cwd, "src", "db.ts"))).toBe(false);
    // No dbImport KEY. The comment block names it among the config keys `meta eject`
    // will tell you about when you take `routes`, which is the point.
    expect(readFileSync(join(cwd, "metaobjects.config.ts"), "utf8")).not.toMatch(/^\s*dbImport:/m);
  });
});

describe("init() — re-run safety", () => {
  test("throws when metaobjects/ exists and --force is not set", async () => {
    mkdirSync(join(cwd, "metaobjects"));
    await expect(init({ cwd })).rejects.toThrow(/already exists/);
  });

  test("succeeds when --force is set", async () => {
    mkdirSync(join(cwd, "metaobjects"), { recursive: true });
    writeFileSync(join(cwd, "metaobjects", "entity-preserve-me.json"), "{}");
    const result = await init({ cwd, force: true });
    expect(result.created).toContain(".metaobjects/config.json");
    // Records in metaobjects/ are preserved
    expect(existsSync(join(cwd, "metaobjects", "entity-preserve-me.json"))).toBe(true);
  });

  test("--print-only writes nothing to disk", async () => {
    const result = await init({ cwd, printOnly: true });
    expect(result.created.length).toBeGreaterThan(0);
    expect(existsSync(join(cwd, "metaobjects"))).toBe(false);
    expect(existsSync(join(cwd, ".metaobjects"))).toBe(false);
  });
});

describe("initCommand argv wrapper", () => {
  test("returns 0 on success", async () => {
    expect(await initCommand([], cwd)).toBe(0);
  });
  test("returns 1 when metaobjects/ exists without --force", async () => {
    mkdirSync(join(cwd, "metaobjects"));
    expect(await initCommand([], cwd)).toBe(1);
  });
  test("returns 2 on unknown flag", async () => {
    expect(await initCommand(["--foo"], cwd)).toBe(2);
  });
});

describe("init() --force config preservation", () => {
  test("preserves existing valid config when --force is set", async () => {
    // First init
    await init({ cwd });
    // User customizes config
    const customConfig = {
      schema_version: 1 as const,
      pending_in_git: false,                    // changed from default
      confidence_thresholds: { pending_promote: 0.95, drift_warn: 0.8 },
      sources: [{ package: "@acme/entities" }],
      extract: {},
    };
    await saveConfig(join(cwd, ".metaobjects"), ConfigSchema.parse(customConfig));

    // Re-init with --force
    const result = await init({ cwd, force: true });
    expect(result.preserved).toContain(".metaobjects/config.json");

    // Customizations survived
    const reloaded = JSON.parse(readFileSync(join(cwd, ".metaobjects", "config.json"), "utf8"));
    expect(reloaded.pending_in_git).toBe(false);
    expect(reloaded.confidence_thresholds.pending_promote).toBe(0.95);
    expect(reloaded.sources).toEqual([{ package: "@acme/entities" }]);
  });

  test("writes fresh defaults when existing config is invalid (and warns)", async () => {
    await init({ cwd });
    // Corrupt the config
    writeFileSync(join(cwd, ".metaobjects", "config.json"), "{ not valid", "utf8");

    const result = await init({ cwd, force: true });

    // Warnings array mentions invalid config
    expect(result.warnings.some((w) => w.toLowerCase().includes("invalid"))).toBe(true);

    // Fresh defaults written
    const reloaded = JSON.parse(readFileSync(join(cwd, ".metaobjects", "config.json"), "utf8"));
    expect(reloaded.schema_version).toBe(1);
    expect(reloaded.pending_in_git).toBe(true); // back to default
  });
});

// Issue #77 — `meta init` scaffolds agent-context skills relative to cwd. In a
// monorepo subdir the skills land where Claude Code won't discover them (it only
// walks cwd + ancestors + user level, never down into subdirs). Detect that case
// and WARN, pointing the user at the repo root.
describe("init() — monorepo-subdir agent-context warning (#77)", () => {
  test("warns when init runs from a subdir of a git repo (skills won't be discovered from root)", async () => {
    // cwd is a temp dir; make it a git repo root, then init from a nested subdir.
    mkdirSync(join(cwd, ".git"));
    const subdir = join(cwd, "packages", "api");
    mkdirSync(subdir, { recursive: true });

    const result = await init({ cwd: subdir });
    const warned = result.warnings.some(
      (w) => /repo root/i.test(w) && /--docs-only/.test(w),
    );
    expect(warned).toBe(true);
  });

  test("does NOT warn when init runs at the git repo root", async () => {
    mkdirSync(join(cwd, ".git"));
    const result = await init({ cwd });
    const warned = result.warnings.some((w) => /repo root/i.test(w) && /--docs-only/.test(w));
    expect(warned).toBe(false);
  });

  test("does NOT warn when init runs in a non-git directory", async () => {
    // cwd has no .git anywhere up the tree (tmpdir).
    const result = await init({ cwd });
    const warned = result.warnings.some((w) => /repo root/i.test(w) && /--docs-only/.test(w));
    expect(warned).toBe(false);
  });
});

describe("init() --config-only", () => {
  test("writes just the config, no TypeScript scaffold", async () => {
    const result = await init({ cwd, configOnly: true });

    // The one file it writes.
    expect(result.created).toContain(".metaobjects/config.json");
    const cfg = JSON.parse(readFileSync(join(cwd, ".metaobjects", "config.json"), "utf8"));
    expect(cfg.schema_version).toBe(1);
    expect(cfg.sources).toEqual([]);

    // None of the TypeScript scaffold, none of the metaobjects/ metadata dir, none
    // of the agent-context — this is the whole point of the flag: a Maven- or
    // pip-rooted project declares its sources for the Node CLI without acquiring a
    // TS project it will not use.
    for (const unwanted of [
      "metaobjects.config.ts",
      "codegen/generators/entity.ts",
      "package.json",
      ".gitignore",
      "metaobjects",
      ".metaobjects/.gitignore",
      ".metaobjects/AGENTS.md",
    ]) {
      expect(existsSync(join(cwd, unwanted))).toBe(false);
    }
  });

  test("--print-only writes nothing to disk", async () => {
    // --config-only used to return ABOVE the --print-only guard the full-scaffold
    // path checks below it, so this documented dry run silently wrote the real file.
    const result = await init({ cwd, configOnly: true, printOnly: true });

    expect(result.created).toContain(".metaobjects/config.json");
    expect(existsSync(join(cwd, ".metaobjects"))).toBe(false);
    expect(existsSync(join(cwd, ".metaobjects", "config.json"))).toBe(false);
  });

  test("leaves an existing valid config untouched", async () => {
    mkdirSync(join(cwd, ".metaobjects"), { recursive: true });
    const existing = { schema_version: 1, sources: [{ path: "model" }] };
    writeFileSync(join(cwd, ".metaobjects", "config.json"), JSON.stringify(existing));

    const result = await init({ cwd, configOnly: true });

    expect(result.preserved).toContain(".metaobjects/config.json");
    const cfg = JSON.parse(readFileSync(join(cwd, ".metaobjects", "config.json"), "utf8"));
    expect(cfg.sources).toEqual([{ path: "model" }]);
  });

  test("refuses to overwrite an existing config it cannot parse, without --force", async () => {
    mkdirSync(join(cwd, ".metaobjects"), { recursive: true });
    // Not valid against ConfigSchema.strict() — e.g. written by a newer `meta`
    // or a typo'd key. Before --config-only existed, reaching this failure
    // required an explicit --force; --config-only must not have quietly
    // regressed that safety net.
    writeFileSync(join(cwd, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1, unknownKey: true }));

    await expect(init({ cwd, configOnly: true })).rejects.toThrow(/could not be parsed/);
    // Unmodified — the refusal must be provable, not just declared.
    const cfg = JSON.parse(readFileSync(join(cwd, ".metaobjects", "config.json"), "utf8"));
    expect(cfg.unknownKey).toBe(true);
  });

  test("--force still replaces an existing unparseable config with defaults", async () => {
    mkdirSync(join(cwd, ".metaobjects"), { recursive: true });
    writeFileSync(join(cwd, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1, unknownKey: true }));

    const result = await init({ cwd, configOnly: true, force: true });

    expect(result.warnings).toContain("invalid .metaobjects/config.json replaced with defaults");
    const cfg = JSON.parse(readFileSync(join(cwd, ".metaobjects", "config.json"), "utf8"));
    expect(cfg.sources).toEqual([]);
    // F11 — this destructive replacement must be reported in `result.created`
    // (matching the OTHER two `writeFresh()` call sites in `writeConfigFile`),
    // not silently omitted from both `created` and `preserved`. The CLI's
    // `--config-only` summary keys on `result.created.includes(...)` alone to
    // choose between "Wrote ..." and "already exists — left untouched." —
    // without this, a config the caller just DESTROYED and replaced with
    // defaults is reported as "left untouched", the opposite of what happened.
    expect(result.created).toContain(".metaobjects/config.json");
  });

  test("preserving a valid existing config is reported separately from a fresh write", async () => {
    // The sibling of the case above: a VALID existing config is genuinely left
    // untouched (merged in place via saveConfig, not replaced with defaults) —
    // `result.preserved`, not `result.created`, is the correct bucket for it.
    mkdirSync(join(cwd, ".metaobjects"), { recursive: true });
    writeFileSync(
      join(cwd, ".metaobjects", "config.json"),
      JSON.stringify({ schema_version: 1, sources: [{ path: "model" }] }),
    );

    const result = await init({ cwd, configOnly: true, force: true });

    expect(result.preserved).toContain(".metaobjects/config.json");
    expect(result.created).not.toContain(".metaobjects/config.json");
  });
});

describe("initCommand --config-only", () => {
  test("returns 0 and writes only the config", async () => {
    expect(await initCommand(["--config-only"], cwd)).toBe(0);
    expect(existsSync(join(cwd, ".metaobjects", "config.json"))).toBe(true);
    expect(existsSync(join(cwd, "metaobjects.config.ts"))).toBe(false);
  });
});

describe("init --d1", () => {
  test("scaffolds config with migrate.dialect = 'd1' and prefilled binding from wrangler.toml", async () => {
    writeFileSync(join(cwd, "wrangler.toml"), [
      `name = "myapp"`,
      ``,
      `[[d1_databases]]`,
      `binding = "DB"`,
      `database_name = "myapp-prod"`,
      `database_id = "abc-123"`,
    ].join("\n"));
    const code = await initCommand(["--d1"], cwd);
    expect(code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(cwd, ".metaobjects", "config.json"), "utf8"));
    expect(cfg.migrate.dialect).toBe("d1");
    expect(cfg.migrate.d1.binding).toBe("DB");
  });

  test("scaffolds config with migrate.dialect = 'd1' but no binding when wrangler.toml absent", async () => {
    const code = await initCommand(["--d1"], cwd);
    expect(code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(cwd, ".metaobjects", "config.json"), "utf8"));
    expect(cfg.migrate.dialect).toBe("d1");
    expect(cfg.migrate.d1?.binding).toBeUndefined();
  });

  test("without --d1, existing init behavior is unchanged", async () => {
    const code = await initCommand([], cwd);
    expect(code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(cwd, ".metaobjects", "config.json"), "utf8"));
    // DEFAULT_CONFIG has no migrate block; the d1 path must not pollute the default path
    expect(cfg.migrate?.dialect ?? "sqlite").toBe("sqlite");
  });

  test("--force --d1 on a valid existing config preserves existing config (does not retro-fit d1)", async () => {
    // First init without --d1 — produces sqlite-default config.
    await initCommand([], cwd);
    const before = JSON.parse(readFileSync(join(cwd, ".metaobjects", "config.json"), "utf8"));
    expect(before.migrate?.dialect ?? "sqlite").toBe("sqlite");

    // Re-init with --force --d1 — existing config is preserved, --d1 is ignored.
    const code = await initCommand(["--force", "--d1"], cwd);
    expect(code).toBe(0);
    const after = JSON.parse(readFileSync(join(cwd, ".metaobjects", "config.json"), "utf8"));
    expect(after.migrate?.dialect ?? "sqlite").toBe("sqlite");  // unchanged
  });

  test("scaffolds config with migrate.dialect = 'd1' but no d1 block when wrangler.toml has multiple bindings", async () => {
    writeFileSync(join(cwd, "wrangler.toml"), [
      `name = "myapp"`,
      ``,
      `[[d1_databases]]`,
      `binding = "DB"`,
      `database_name = "myapp-prod"`,
      `database_id = "abc-123"`,
      ``,
      `[[d1_databases]]`,
      `binding = "CACHE"`,
      `database_name = "myapp-cache"`,
      `database_id = "def-456"`,
    ].join("\n"));
    const code = await initCommand(["--d1"], cwd);
    expect(code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(cwd, ".metaobjects", "config.json"), "utf8"));
    expect(cfg.migrate.dialect).toBe("d1");
    expect(cfg.migrate.d1).toBeUndefined();
  });

  test("scaffolds metaobjects.config.ts with dialect = 'd1' when --d1 is passed", async () => {
    const code = await initCommand(["--d1"], cwd);
    expect(code).toBe(0);
    const configTs = readFileSync(join(cwd, "metaobjects.config.ts"), "utf8");
    expect(configTs).toContain('dialect: "d1"');
  });

  test("scaffolds metaobjects.config.ts with dialect = 'sqlite' when --d1 is not passed", async () => {
    const code = await initCommand([], cwd);
    expect(code).toBe(0);
    const configTs = readFileSync(join(cwd, "metaobjects.config.ts"), "utf8");
    expect(configTs).toContain('dialect: "sqlite"');
  });

  test("scaffolds metaobjects.config.ts with outDir = 'src/generated'", async () => {
    const code = await initCommand([], cwd);
    expect(code).toBe(0);
    const configTs = readFileSync(join(cwd, "metaobjects.config.ts"), "utf8");
    expect(configTs).toContain('outDir:  "src/generated"');
  });
});

// A cold adoption probe once found `dbImport: "../db"` scaffolded pointing at a file
// `init` never created, and the fix at the time was a throwing `src/db.ts` stub plus a
// comment — because the scaffold WIRED routesFile(), whose emitted routes do
// `import { db } from …`.
//
// Opt-in codegen removes the premise rather than the symptom. Nothing is wired, so
// nothing emits that import, so there is no `dbImport` to point anywhere and no stub to
// scaffold. `dbImport` became a declared `configKey` on the `routes` catalog entry:
// `meta eject routes` reports it, to the adopter who actually chose routes. What these
// tests pin now is that BOTH artifacts are gone and the config-key path works.
describe("init() — no dbImport, no db stub, and routes still works once chosen", () => {
  test("neither the key nor the stub is scaffolded", async () => {
    const result = await init({ cwd });
    expect(result.created).not.toContain("src/db.ts");
    expect(existsSync(join(cwd, "src", "db.ts"))).toBe(false);
    const configTs = readFileSync(join(cwd, "metaobjects.config.ts"), "utf8");
    expect(configTs).not.toMatch(/^\s*dbImport:/m);
  });

  test("--print-only forecasts no db stub either", async () => {
    const result = await init({ cwd, printOnly: true });
    expect(result.created).not.toContain("src/db.ts");
  });

  test("`meta eject routes` reports dbImport as the key to set", async () => {
    await init({ cwd });
    const { ejectCommand } = await import("../src/commands/eject.js");
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
    try {
      expect(await ejectCommand(["routes"], cwd, "json")).toBe(0);
    } finally {
      console.log = origLog;
    }
    const payload = JSON.parse(lines.join("\n")) as { config: { keys: string[] } };
    expect(payload.config.keys).toContain("dbImport");
  });

  test("a project that wires routes and sets dbImport generates exactly as before", async () => {
    // The regression pin the old block carried, moved to the path that now reaches it:
    // routes is CHOSEN, dbImport is SET, and the emitted import resolves.
    const dir = mkGenProjectDir("dbimport-gen-");
    try {
      expect(await initCommand([], dir)).toBe(0);
      writeFileSync(join(dir, "metaobjects", "meta.common.json"), PROBE_ENTITY);

      const { ejectCommand } = await import("../src/commands/eject.js");
      const origLog = console.log;
      console.log = () => {};
      try {
        expect(await ejectCommand(["entity", "routes"], dir, "text")).toBe(0);
      } finally {
        console.log = origLog;
      }

      const configPath = join(dir, "metaobjects.config.ts");
      writeFileSync(configPath, [
        'import { defineConfig } from "@metaobjectsdev/cli";',
        'import { entityFile } from "./codegen/generators/entity.js";',
        'import { routesFile } from "./codegen/generators/routes.js";',
        "export default defineConfig({",
        '  outDir: "src/generated",',
        '  dialect: "sqlite",',
        '  extStyle: "js",',
        '  dbImport: "../db",',
        "  generators: [entityFile(), routesFile()],",
        "});",
        "",
      ].join("\n"));

      const { genCommand } = await import("../src/commands/gen.js");
      expect(await genCommand([], dir)).toBe(0);
      const routes = readFileSync(join(dir, "src", "generated", "Author.routes.ts"), "utf8");
      expect(routes).toContain('import { db } from "../db.js"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("meta init scaffolds a tsconfig for the tier it just handed you", () => {
  test("writes tsconfig.codegen.json and reports it", async () => {
    const result = await init({ cwd });
    expect(result.created).toContain("tsconfig.codegen.json");
    expect(existsSync(join(cwd, "tsconfig.codegen.json"))).toBe(true);
  });

  test("its include covers BOTH the config and the owned generators", async () => {
    // Either one alone leaves half the tier unchecked, and the half it leaves is the
    // half that broke on the estate.
    await init({ cwd });
    const body = readFileSync(join(cwd, "tsconfig.codegen.json"), "utf8");
    expect(body).toContain("metaobjects.config.ts");
    expect(body).toContain("codegen/**/*.ts");
    expect(body).toContain('"noEmit": true');
    // nodenext, because the scaffolded tier is ESM and the generated imports carry
    // extensions — a bundler-resolution tsconfig would accept code `meta gen` cannot run.
    expect(body).toContain('"moduleResolution": "nodenext"');
  });

  test("an existing tsconfig.codegen.json is PRESERVED, not clobbered", async () => {
    // An adopter with their own arrangement keeps it, and is told it was kept rather
    // than left to discover a silent skip.
    writeFileSync(join(cwd, "tsconfig.codegen.json"), '{"mine": true}\n');
    const result = await init({ cwd });
    expect(result.preserved).toContain("tsconfig.codegen.json");
    expect(readFileSync(join(cwd, "tsconfig.codegen.json"), "utf8")).toContain('"mine"');
  });

  test("--print-only names it without writing it", async () => {
    const result = await init({ cwd, printOnly: true });
    expect(result.created).toContain("tsconfig.codegen.json");
    expect(existsSync(join(cwd, "tsconfig.codegen.json"))).toBe(false);
  });
});
