import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { init, initCommand, nextStepsBlock } from "../src/commands/init.js";
import { saveConfig, ConfigSchema } from "@metaobjectsdev/sdk";

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

  test("scaffolds package.meta.json under .metaobjects/ with three-field manifest", async () => {
    await init({ cwd });
    const manifestPath = join(cwd, ".metaobjects", "package.meta.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.name).toBeDefined();
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.extends).toEqual([]);
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

// FR-040 fix round 1, Finding 1 — writeOwnedGenerators() used to loop over ALL of
// @metaobjectsdev/codegen-ts's REFERENCE_GENERATOR_NAMES unconditionally, so when an
// earlier task on this branch registered "routes-hono" there, `meta init` silently
// started scaffolding a fifth, unwired file: nothing in the scaffolded
// metaobjects.config.ts imports routesFileHono. This pins the exact set — a future
// template registered in REFERENCE_GENERATOR_NAMES must NOT silently join init's eager
// scaffold; it stays reachable only via `meta eject <name>` until a human decides
// otherwise.
describe("init() — owned generator scaffold set (FR-040 fix round 1, Finding 1)", () => {
  test("copies exactly the four generators the scaffolded config wires — not routes-hono", async () => {
    const result = await init({ cwd });
    const dir = join(cwd, "codegen", "generators");
    const files = readdirSync(dir).sort();
    expect(files).toEqual(["barrel.ts", "entity.ts", "queries.ts", "routes.ts"]);
    expect(existsSync(join(dir, "routes-hono.ts"))).toBe(false);

    for (const rel of [
      "codegen/generators/entity.ts",
      "codegen/generators/queries.ts",
      "codegen/generators/routes.ts",
      "codegen/generators/barrel.ts",
    ]) {
      expect(result.created).toContain(rel);
    }
    expect(result.created).not.toContain("codegen/generators/routes-hono.ts");
  });

  test("--print-only forecasts the same four-file set, not routes-hono", async () => {
    const result = await init({ cwd, printOnly: true });
    expect(result.created).toContain("codegen/generators/entity.ts");
    expect(result.created).toContain("codegen/generators/queries.ts");
    expect(result.created).toContain("codegen/generators/routes.ts");
    expect(result.created).toContain("codegen/generators/barrel.ts");
    expect(result.created).not.toContain("codegen/generators/routes-hono.ts");
  });

  test("routes-hono is still reachable via `meta eject` — not scaffolded eagerly, but not missing", async () => {
    await init({ cwd });
    // Not written by init...
    expect(existsSync(join(cwd, "codegen", "generators", "routes-hono.ts"))).toBe(false);
    // ...but eject can still copy it on demand (proves it wasn't deregistered, only
    // moved off the eager path).
    const { ejectGenerator } = await import("../src/commands/eject.js");
    const ejectResult = await ejectGenerator({ cwd, name: "routes-hono" });
    expect(ejectResult.status).toBe("created");
    expect(existsSync(join(cwd, "codegen", "generators", "routes-hono.ts"))).toBe(true);
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
    expect(configTs).toContain('dialect:   "d1"');
  });

  test("scaffolds metaobjects.config.ts with dialect = 'sqlite' when --d1 is not passed", async () => {
    const code = await initCommand([], cwd);
    expect(code).toBe(0);
    const configTs = readFileSync(join(cwd, "metaobjects.config.ts"), "utf8");
    expect(configTs).toContain('dialect:   "sqlite"');
  });

  test("scaffolds metaobjects.config.ts with outDir = 'src/generated' (not the ambiguous src/db)", async () => {
    const code = await initCommand([], cwd);
    expect(code).toBe(0);
    const configTs = readFileSync(join(cwd, "metaobjects.config.ts"), "utf8");
    expect(configTs).toContain('outDir:    "src/generated"');
    // "./src/db" as outDir collides with the user-created src/db.ts that the
    // generated routes import via dbImport "../db" — keep them distinct.
    expect(configTs).not.toContain('"./src/db"');
  });
});

describe("init() — scaffolded config.ts honesty", () => {
  // A cold adoption probe found `dbImport: "../db"` scaffolded pointing at a file
  // `init` never creates, with nothing in the config saying so.
  //
  // NOTE: an earlier draft of this fix commented `dbImport` out entirely. That
  // regresses the default scaffold — verified by running `meta gen` against it:
  // the default `generators` array wires routesFile() (Fastify), whose emitted
  // routes DO `import { db } from …` (server/typescript/packages/codegen-ts/src/
  // templates/routes-file.ts), and the runner demands dbImport at that point of
  // use (`runner.ts`'s dbImportUndeclaredFor), throwing `codegen config is
  // missing dbImport` on the very first `meta gen` after a fresh `meta init`.
  // `queriesFile` genuinely takes `db` as a parameter and never reads dbImport —
  // but routesFile (what `init` actually scaffolds) does. So dbImport must stay
  // ACTIVE; the fix is telling the user what to do about the file it names.
  test("dbImport carries a comment naming the file the user must create", async () => {
    const code = await initCommand([], cwd);
    expect(code).toBe(0);
    const configTs = readFileSync(join(cwd, "metaobjects.config.ts"), "utf8");
    expect(configTs).toMatch(/dbImport:\s*"\.\.\/db",/);
    expect(configTs).toContain("src/db.ts");
  });

  test("meta gen still succeeds against the scaffolded config for an entity with a source.rdb", async () => {
    // Regression pin for the near-miss above: the scaffold's dbImport must stay
    // functional (routesFile() genuinely needs it), not just present-with-a-comment.
    expect(await initCommand([], cwd)).toBe(0);
    writeFileSync(
      join(cwd, "metaobjects", "meta.common.json"),
      JSON.stringify({
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
      }, null, 2),
    );
    const { genCommand } = await import("../src/commands/gen.js");
    expect(await genCommand([], cwd)).toBe(0);
    const routes = readFileSync(join(cwd, "src", "generated", "Author.routes.ts"), "utf8");
    expect(routes).toContain('import { db } from "../db.js"');
  });
});

// Task 15 — closes the residue Task 9 (above) made discoverable but did not
// eliminate: `meta init` declared `dbImport: "../db"` but never created the
// module, so a fresh project's FIRST `tsc` failed to resolve it. The fix is a
// scaffolded THROWING STUB: it types clean and satisfies every generated
// import, choosing no driver and adding no dependency, but throws a clear,
// actionable error the first time anything actually touches `db` at runtime.
describe("init() — dbImport throwing stub (Task 15)", () => {
  test("scaffolds src/db.ts as a throwing stub, typed without `any`, that exports `db`", async () => {
    const result = await init({ cwd });
    expect(result.created).toContain("src/db.ts");
    const body = readFileSync(join(cwd, "src", "db.ts"), "utf8");
    // Zero live imports — no driver chosen, no dependency added. (Driver names
    // may appear in the comment's illustrative example line; that's the point.)
    expect(body).not.toMatch(/^import /m);
    expect(body).not.toMatch(/\bany\b/);
    expect(body).toContain("export const db: unknown");
    // Actually throws on first real use, rather than silently no-op-ing.
    expect(body).toContain("new Proxy(");
    expect(body).toContain("throw new Error(");
  });

  test("the thrown message names the file and shows a concrete replacement line", async () => {
    await init({ cwd });
    const body = readFileSync(join(cwd, "src", "db.ts"), "utf8");
    expect(body).toContain("src/db.ts");
    expect(body).toContain("export const db = drizzle(");
  });

  test("does NOT clobber an existing src/db.ts on a re-run with --force", async () => {
    await init({ cwd });
    const realDb = 'import { drizzle } from "drizzle-orm/better-sqlite3";\nexport const db = drizzle({} as never);\n';
    writeFileSync(join(cwd, "src", "db.ts"), realDb, "utf8");

    const result = await init({ cwd, force: true });

    expect(result.preserved).toContain("src/db.ts");
    expect(result.created).not.toContain("src/db.ts");
    expect(readFileSync(join(cwd, "src", "db.ts"), "utf8")).toBe(realDb);
  });

  test("dry run (--print) reports src/db.ts as a would-be-created file", async () => {
    const result = await init({ cwd, printOnly: true });
    expect(result.created).toContain("src/db.ts");
    expect(existsSync(join(cwd, "src", "db.ts"))).toBe(false);
  });

  // The headline gate: the documented sequence — init, author an entity with a
  // source.rdb child, gen, tsc — must all succeed with no unresolved-module
  // error. Mirrors the "meta gen still succeeds..." regression pin above, one
  // step further: it actually type-checks the generated output + the scaffolded
  // stub with the real TypeScript compiler this repo depends on, under the same
  // nodenext options a stock `tsc --init` project resolves relative imports
  // with. The temp dir is placed INSIDE the cli package (not the OS tmpdir) so
  // node module resolution for fastify/drizzle-orm/zod/@metaobjectsdev/runtime-ts
  // — real deps the generated routes import — walks up to cli's own
  // node_modules, the same way a real installed project would resolve them.
  test("end to end: init -> author a source.rdb entity -> gen -> tsc resolves dbImport with no unresolved-module error", async () => {
    const dir = mkdtempSync(join(import.meta.dirname, "tmp-dbstub-tsc-"));
    try {
      expect(await initCommand([], dir)).toBe(0);
      writeFileSync(
        join(dir, "metaobjects", "meta.common.json"),
        JSON.stringify({
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
        }, null, 2),
      );
      const { genCommand } = await import("../src/commands/gen.js");
      expect(await genCommand([], dir)).toBe(0);

      const generatedDir = join(dir, "src", "generated");
      const rootFiles = [
        join(generatedDir, "Author.ts"),
        join(generatedDir, "Author.queries.ts"),
        join(generatedDir, "Author.routes.ts"),
        join(dir, "src", "db.ts"),
      ];
      const program = ts.createProgram(rootFiles, {
        noEmit: true,
        strict: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
      });
      const diagnostics = ts.getPreEmitDiagnostics(program);
      // TS2307 = "Cannot find module" — the exact class of error the missing
      // src/db.ts used to produce. Scoped to this one code (rather than
      // asserting zero diagnostics overall) because this repo's own dev
      // dependency graph carries an unrelated, pre-existing `fastify` version
      // skew (the `cli` package's devDependency vs `runtime-ts`'s peer range)
      // that surfaces as a structural type mismatch under a real compiler —
      // orthogonal to the dbImport defect this gate exists to catch, and not
      // something a fresh external install (a single resolved fastify version)
      // would ever see.
      const unresolvedModules = diagnostics
        .filter((d) => d.code === 2307)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      expect(unresolvedModules).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
