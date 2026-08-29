import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { basename, dirname } from "node:path";
import { existsSync as existsSyncWrap, readFileSync as readFileSyncWrap } from "node:fs";
import { DEFAULT_CONFIG, ConfigSchema, saveConfig, PACKAGE_MANIFEST_FILE, DEFAULT_METADATA_DIR, DEFAULT_METAOBJECTS_DIR } from "@metaobjectsdev/sdk";
import {
  assemble, resolveAgentContextRoot, planScaffold,
  AGENT_CONTEXT_MANIFEST_PATH, type Manifest, type Stack,
} from "@metaobjectsdev/sdk/agent-context";
import { resolveStack } from "../lib/detect-stack.js";
import { parseInitArgs } from "../lib/args.js";
import { log } from "../lib/log.js";
import { cliVersion } from "../lib/version.js";
import { findWranglerConfig, parseWranglerConfig } from "@metaobjectsdev/migrate-ts";
import { readReferenceTemplate, type ReferenceGeneratorName } from "@metaobjectsdev/codegen-ts";

// ADR-0034 scaffold-and-own — `meta init` copies the codegen reference templates into
// the consumer's repo so they OWN them; metaobjects.config.ts imports them locally.
const OWNED_GENERATORS_DIR = "codegen/generators";

// The FOUR reference generators `meta init` copies EAGERLY — deliberately an explicit
// literal, not derived from @metaobjectsdev/codegen-ts's REFERENCE_GENERATOR_NAMES (the
// full list of everything `meta eject` can copy). Looping over that array unconditionally
// used to mean init scaffolded whatever it contained: when a later task registered
// "routes-hono" there, init started writing an unwired Hono generator nothing in the
// scaffolded config imports, on every fresh project, silently. This constant is the
// scaffolded metaobjects.config.ts's import list (buildMetaobjectsConfigBody below) made
// explicit and checkable — anything else is eject-on-demand via `meta eject <name>`, which
// exists exactly so eager copying isn't the only way to take ownership of a template.
const SCAFFOLDED_GENERATOR_NAMES: readonly ReferenceGeneratorName[] = ["entity", "queries", "routes", "barrel"];

// The scaffolded config's outDir + dbImport, as named constants so the throwing-stub
// path below is DERIVED from the same values the config template embeds rather than
// duplicated as a second literal that could drift from it.
const SCAFFOLD_OUT_DIR = "src/generated";
const SCAFFOLD_DB_IMPORT = "../db";
// "src/generated" + "../db" -> "src/db" -> "src/db.ts" (dbImport resolves relative
// to outDir, same as the module specifier a generated route file emits).
const DB_STUB_REL_PATH = `${join(SCAFFOLD_OUT_DIR, SCAFFOLD_DB_IMPORT)}.ts`;

const META_COMMON_JSON = JSON.stringify(
  {
    metadata: {
      package: "",
      children: [] as unknown[],
    },
  },
  null,
  2,
) + "\n";

// Issue #75 — a multi-target codegen config can route a target's outDir under
// `.metaobjects/<targetName>/src/generated/`. That output is the regenerable
// shadow (the canonical output lives at the configured outDir; re-running
// `meta gen` recreates the shadow), so it must NOT be committed by default. We
// ignore the per-target generated shadow with a narrow `*/src/generated/`
// pattern, then explicitly re-include `migrations/` and `config.json` so the
// tracked artifacts are never swept up even if a future broad pattern were added.
const METAOBJECTS_GITIGNORE_BODY = `# The codegen merge base. The snapshot BODIES are a second full copy of all
# generated output — never commit those. \`.hashes.json\` is different: it is one
# hash per generated path, and it is the only thing that lets \`meta gen\` tell "this
# file is exactly what I wrote" from "somebody edited this" on a machine that did
# not generate it. Without it committed, every fresh clone and every CI runner has
# no merge base, and a hand-edited generated file cannot be recognised as such.
#
# The glob form matters: \`.gen-state/\` (a directory) would stop git descending, and
# the negation below could never take effect.
.gen-state/*
!.gen-state/.hashes.json

# Per-target codegen output routed under .metaobjects/<target>/ is regenerable
# (re-run \`meta gen\`); never commit it. The canonical output is your configured
# outDir, not this shadow.
*/src/generated/

# These ARE meant to be tracked — keep them even if a broad pattern matches.
!migrations/
!config.json
!package.meta.json
`;

// A minimal root .gitignore for a fresh project — only written when none exists,
// never clobbering the user's own. Keeps a `git add -A` right after `meta init`
// from staging node_modules/, a local dev sqlite file, or build output.
const ROOT_GITIGNORE_BODY = `# Dependencies
node_modules/

# Local dev database
*.sqlite
*.sqlite-journal
*.db

# Build output
dist/
*.tsbuildinfo
`;

function buildMetaobjectsConfigBody(dialect: "sqlite" | "postgres" | "d1" = "sqlite"): string {
  return `import { defineConfig } from "@metaobjectsdev/cli";
// Owned codegen generators (ADR-0034 scaffold-and-own). \`meta init\` copied these
// reference templates into ./codegen/generators/ — they are YOURS to edit, and
// \`meta gen\` runs from these local copies, not from the package. Read each file's
// header doc-block for what it emits and how to customize it.
import { entityFile } from "./codegen/generators/entity.js";
import { queriesFile } from "./codegen/generators/queries.js";
import { routesFile } from "./codegen/generators/routes.js";
import { barrel } from "./codegen/generators/barrel.js";

export default defineConfig({
  outDir:    "${SCAFFOLD_OUT_DIR}",
  extStyle:  "js",   // ".js"-extensioned relative imports — safe under Node ESM / tsc nodenext AND bundlers
  dbImport:  "${SCAFFOLD_DB_IMPORT}",   // routesFile() below emits \`import { db } from …\` — meta init
                        // scaffolded ${DB_STUB_REL_PATH} as a THROWING STUB (types clean, no
                        // driver chosen) so meta gen and tsc pass; replace it with your real
                        // Drizzle connection before running the app.
                        // (queriesFile() takes db as a parameter and never reads this.)
  dialect:   "${dialect}",
  apiPrefix: "",     // set to "/api" if your routes mount under /api
  generators: [
    entityFile(),
    queriesFile(),
    routesFile(),
    barrel(),
  ],
  docs: {
    outDir:   "./docs",        // model + api surfaces both land here (run: meta docs)
    layout:   "flat",          // or "package" for multi-package models
    surfaces: ["model", "api"],
  },
});
`;
}

// The throwing-stub scaffolded at `dbImport`'s resolved path (DB_STUB_REL_PATH,
// "src/db.ts" by default). It exists so `meta gen` and a fresh project's FIRST
// `tsc` both succeed with no driver chosen and no dependency added — deliberately
// NOT a real connection. Every generated route only ever passes `db` straight
// through to `mountCrudRoutes(...)`; nothing reads a property off it at import
// time, so a value typed `unknown` (not `any`) satisfies every call site while
// making a genuine runtime use (mountCrudRoutes calling `db.select()` etc.) throw
// immediately with an actionable message instead of failing to resolve at all.
// Built as an array of plain single-quoted lines (not a template literal) so the
// backticks and quotes inside the comment/message need no escaping.
const DB_STUB_BODY = [
  "// `meta init` scaffolded this file because the generated Fastify routes",
  '// `import { db } from "../db.js"` (see `dbImport` in metaobjects.config.ts) —',
  "// a module that has to exist for `meta gen` and `tsc` to succeed. MetaObjects",
  "// cannot fill it in for real without choosing a database driver on your",
  "// behalf (better-sqlite3 vs @libsql/client vs pg vs postgres.js) and adding a",
  "// dependency you may not want, so this is a STUB, not a connection.",
  "//",
  "// It type-checks and satisfies every generated import, but throws the first",
  "// time anything actually touches `db` at runtime. Replace the export below",
  "// with your real Drizzle connection, e.g.:",
  "//",
  '//   import { drizzle } from "drizzle-orm/better-sqlite3";',
  '//   import Database from "better-sqlite3";',
  '//   export const db = drizzle(new Database("dev.sqlite"));',
  "//",
  "// (swap the driver import for your dialect — see",
  "// docs/recipes/wiring-generated-queries.md for SQLite/libsql, Cloudflare D1,",
  "// Postgres and multi-tenant setups.)",
  "",
  "const UNWIRED_MESSAGE =",
  '  "src/db.ts is still the scaffolded stub meta init wrote — it cannot choose " +',
  "  \"a database driver for you. Replace 'export const db = ...' below with \" +",
  '  "your real Drizzle connection, e.g.:\\n\\n" +',
  "  \"  import { drizzle } from 'drizzle-orm/better-sqlite3';\\n\" +",
  "  \"  import Database from 'better-sqlite3';\\n\" +",
  "  \"  export const db = drizzle(new Database('dev.sqlite'));\\n\";",
  "",
  "function unwired(): never {",
  "  throw new Error(UNWIRED_MESSAGE);",
  "}",
  "",
  "/**",
  " * Stand-in for your real Drizzle database connection. Generated code only",
  " * ever passes `db` straight through to `mountCrudRoutes(...)` — it never",
  " * reads a property off it at import time — so this typechecks everywhere",
  " * `db` is used, and throws the message above the first time anything really",
  " * touches it.",
  " */",
  "export const db: unknown = new Proxy({}, { get: unwired });",
  "",
].join("\n");

const NEXT_STEPS = `
Initialized metaobjects/ + .metaobjects/ + metaobjects.config.ts
Codegen generators copied to codegen/generators/ — they're YOURS to edit (ADR-0034 scaffold-and-own).

Next steps:
  0. Everything here is ESM — package.json needs "type": "module" (init sets it
     unless the project has CommonJS sources; without it the first tsc fails).
  1. Author entities under metaobjects/ (start from the scaffolded meta.common.json)
  2. meta gen              # generate idiomatic TypeScript from your entities
     meta gen --dry-run    #   ...preview without writing
  3. meta docs             # neutral model + API docs
  4. Create your tables: meta migrate --from-db --db file:dev.sqlite --dialect sqlite --slug init --apply

Ship in later sub-projects: meta ingest (propose entities from existing code),
meta serve (local viewer), meta install-hooks (MCP server + Claude Code hooks).
`;

export interface InitOptions {
  cwd: string;
  force?: boolean;
  quiet?: boolean;
  printOnly?: boolean;
  refreshDocs?: boolean;
  d1?: boolean;
  servers?: string[];
  clients?: string[];
  noSkills?: boolean;
  wireRoot?: boolean;
  /** Scaffold ONLY the agent-context (always-on + skills + root wiring), skipping the metaobjects/ project scaffold — for dropping context into an existing/polyglot repo. */
  docsOnly?: boolean;
  /**
   * Write ONLY `.metaobjects/config.json` — no TypeScript scaffold (metaobjects.config.ts,
   * codegen/generators/, package.json edits, .gitignore, agent-context files, or a
   * metaobjects/ directory). For a Maven- or pip-rooted project that needs the Node CLI
   * (which owns `migrate` and `verify --db` under ADR-0015) to discover its metadata
   * without acquiring a TypeScript project it will never use.
   */
  configOnly?: boolean;
}

export interface InitResult {
  created: string[];
  preserved: string[];
  warnings: string[];
}

async function readManifest(cwd: string): Promise<Manifest | undefined> {
  const p = join(cwd, AGENT_CONTEXT_MANIFEST_PATH);
  if (!(await fileExists(p))) return undefined;
  try { return JSON.parse(await readFile(p, "utf8")) as Manifest; } catch { return undefined; }
}

/**
 * Walk up from `start` looking for a `.git` directory; return the repo root, or
 * undefined when `start` is not inside a git working tree. (`.git` can be a file
 * in worktrees/submodules — accept either a dir or a file.)
 */
function findGitRoot(start: string): string | undefined {
  let dir = start;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSyncWrap(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined; // reached filesystem root
    dir = parent;
  }
}

/**
 * Issue #77 — Claude Code discovers `.claude/skills/` only from cwd + ANCESTOR
 * dirs + the user level; it never walks DOWN into subdirs. So scaffolding the
 * agent-context into a monorepo subdir means a root-launched session won't load
 * the skills (the common case). When the init dir is inside a git repo whose
 * root is an ANCESTOR (i.e. a subdir init), warn and point the user at the repo
 * root. The metadata/config/migrations correctly stay in the subdir regardless.
 */
function warnIfMonorepoSubdir(opts: InitOptions, result: InitResult): void {
  if (opts.noSkills) return; // no skills written → nothing to warn about
  const gitRoot = findGitRoot(opts.cwd);
  if (gitRoot === undefined || gitRoot === opts.cwd) return; // repo root or non-git → fine
  const lang = opts.servers && opts.servers.length > 0 ? opts.servers[0]! : "<lang>";
  result.warnings.push(
    "agent-context skills scaffolded into a monorepo subdir won't be discovered from a " +
    "root-launched session (Claude Code only walks cwd + ancestors). Scaffold the context " +
    `at the repo root instead: cd <repo-root> && meta init --docs-only --server ${lang}`,
  );
}

/**
 * Resolve the stack for agent-context (re)scaffolding. Precedence:
 *   1. explicit --server/--client overrides — the user is (re)declaring the stack;
 *   2. the stack persisted in the prior manifest — ground truth from the last
 *      init/refresh, reused so a correct multi-package stack line is never REGRESSED
 *      by re-detecting from a root-only probe (issue #163: a monorepo's sibling-
 *      package client and its Maven-built Kotlin are invisible at the root);
 *   3. best-effort detection from the root probe — a fresh project with no prior.
 * This governs EVERY path that runs writeAgentContext — refresh, `init --force`, and
 * `--docs-only` — so a declared stack survives on all of them unless the user passes
 * explicit overrides. resolveStack filters servers/clients to the valid vocabularies
 * and self-detects when handed empty arrays, so passing the manifest's persisted
 * string[]s (or nothing) straight through is safe — no need to special-case an empty
 * or absent prior.
 */
async function stackForAgentContext(opts: InitOptions, prior: Manifest | undefined): Promise<Stack> {
  const hasOverride = (opts.servers?.length ?? 0) > 0 || (opts.clients?.length ?? 0) > 0;
  const overrides = hasOverride
    ? { servers: opts.servers ?? [], clients: opts.clients ?? [] }
    : { servers: prior?.servers ?? [], clients: prior?.clients ?? [] };
  return resolveStack(opts.cwd, overrides);
}

/** Writes `contents` to `path` (relative to `cwd`), unless `dryRun` — in which case
 *  the write is skipped entirely and the caller still records what WOULD have
 *  landed. Factors the mkdir+writeFile pair shared by every write site below. */
async function writeUnlessDryRun(cwd: string, dryRun: boolean, path: string, contents: string): Promise<void> {
  if (dryRun) return;
  const abs = join(cwd, path);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, contents, "utf8");
}

/** "would be VERBED" during a dry run, plain VERBED otherwise — the one tense
 *  marker every reported write shares, so each call site states only its own
 *  past participle instead of writing out both tenses of the whole sentence. */
function verbed(dryRun: boolean, pastParticiple: string): string {
  return dryRun ? `would be ${pastParticiple}` : pastParticiple;
}

async function writeAgentContext(opts: InitOptions, result: InitResult): Promise<void> {
  warnIfMonorepoSubdir(opts, result);
  const prior = await readManifest(opts.cwd);
  const stack = await stackForAgentContext(opts, prior);
  let assembled = assemble({ contentRoot: resolveAgentContextRoot(), stack });
  if (opts.noSkills) assembled = assembled.filter((f) => !f.path.startsWith(".claude/skills/"));

  const decision = planScaffold({
    stack, assembled, prior,
    readCurrent: (rel) => {
      const abs = join(opts.cwd, rel);
      return existsSyncWrap(abs) ? readFileSyncWrap(abs, "utf8") : undefined;
    },
    generatedBy: cliVersion(),
  });

  // --force: overwrite hand-edited docs in place rather than parking the fresh copy
  // at <path>.new (issue #163 — a forced (re)scaffold means "I mean it"; applies to
  // refresh and full-init alike). planScaffold already hashed every assembled file
  // into the manifest, so the in-place write stays tracked and a later non-forced
  // refresh sees it as unmodified.
  const writes = opts.force
    ? [...decision.writes, ...decision.conflicts.map((c) => ({ path: c.path, contents: c.contents }))]
    : decision.writes;
  const conflicts = opts.force ? [] : decision.conflicts;

  // --print-only must win outright: a documented dry run must never write. Both
  // callers of this function (`--docs-only` and `--refresh-docs`) return from
  // `init()` ABOVE the full-scaffold path's own printOnly guard, so without this
  // the dry run silently scaffolded for real — the same defect `--config-only`
  // carried. The guard lives HERE rather than as a path list beside that one
  // because this write set is dynamic (it depends on the resolved stack), and
  // `decision` is already the complete plan: suppressing just the I/O reports
  // exactly the paths a real run would touch, with no second list to drift.
  const dryRun = opts.printOnly === true;

  for (const w of writes) {
    await writeUnlessDryRun(opts.cwd, dryRun, w.path, w.contents);
    result.created.push(w.path);
  }
  for (const c of conflicts) {
    await writeUnlessDryRun(opts.cwd, dryRun, c.newPath, c.contents);
    result.created.push(c.newPath);
    // Past tense only when it actually happened — a dry run that reports "written
    // to <path>.new" is claiming an edit-preserving side effect the user can go
    // look for and will not find.
    result.warnings.push(
      `${c.path} appears hand-edited; refreshed version ${verbed(dryRun, "written")} to ${c.newPath}`,
    );
  }
  await writeUnlessDryRun(
    opts.cwd, dryRun, AGENT_CONTEXT_MANIFEST_PATH,
    JSON.stringify(decision.manifest, null, 2) + "\n",
  );
  result.created.push(AGENT_CONTEXT_MANIFEST_PATH);

  for (const orphan of decision.removed) {
    result.warnings.push(`${orphan} is no longer part of this stack; orphaned (safe to delete).`);
  }

  if (opts.wireRoot) await wireRootMemory(opts.cwd, result, dryRun);
}

const ROOT_IMPORT_LINE = "@.metaobjects/AGENTS.md";
async function wireRootMemory(cwd: string, result: InitResult, dryRun = false): Promise<void> {
  const claudePath = join(cwd, "CLAUDE.md");
  const agentsPath = join(cwd, "AGENTS.md");
  const claudeExists = await fileExists(claudePath);
  const agentsExists = await fileExists(agentsPath);

  // If neither root memory file exists, create CLAUDE.md (Claude Code's canonical) with the import.
  if (!claudeExists && !agentsExists) {
    await writeUnlessDryRun(cwd, dryRun, "CLAUDE.md", `# Project memory\n\n${ROOT_IMPORT_LINE}\n`);
    result.created.push(`CLAUDE.md (${verbed(dryRun, "created")} with MetaObjects @import)`);
    return;
  }
  // Otherwise append the import to whichever exist (idempotent — never double-add).
  for (const [path, exists] of [[claudePath, claudeExists], [agentsPath, agentsExists]] as const) {
    if (!exists) continue;
    const body = await readFile(path, "utf8");
    if (body.includes(ROOT_IMPORT_LINE)) continue;
    const target = path.endsWith("AGENTS.md") ? "AGENTS.md" : "CLAUDE.md";
    await writeUnlessDryRun(cwd, dryRun, target, `${body.replace(/\n*$/, "\n")}\n${ROOT_IMPORT_LINE}\n`);
    // Past tense only when it actually happened — this one mutates a file the user
    // owns, so a dry run reporting it as done is the most misleading of the three.
    result.warnings.push(`${verbed(dryRun, "wired")} ${ROOT_IMPORT_LINE} into ${target} so the MetaObjects context loads`);
  }
}

/**
 * ADR-0034 — copy the codegen reference templates into the consumer's repo at
 * `codegen/generators/<name>.ts` so they own them. Each file is written only if absent,
 * so a re-run with --force never clobbers a hand-edited generator. The scaffolded
 * metaobjects.config.ts imports these local copies (not the package `/generators` export).
 *
 * Copies SCAFFOLDED_GENERATOR_NAMES only — the four the scaffolded config actually
 * wires — not every name @metaobjectsdev/codegen-ts happens to register. Anything else
 * (routes-hono, and any UI-tier template from codegen-ts-react/-tanstack) is reached with
 * `meta eject <name>`, not by eager copying.
 */
async function writeOwnedGenerators(opts: InitOptions, result: InitResult): Promise<void> {
  const dir = join(opts.cwd, OWNED_GENERATORS_DIR);
  await mkdir(dir, { recursive: true });
  for (const name of SCAFFOLDED_GENERATOR_NAMES) {
    const rel = `${OWNED_GENERATORS_DIR}/${name}.ts`;
    const abs = join(dir, `${name}.ts`);
    if (await fileExists(abs)) {
      result.preserved.push(rel);
      continue;
    }
    await writeFile(abs, readReferenceTemplate(name), "utf8");
    result.created.push(rel);
  }
}

/**
 * .metaobjects/config.json — write fresh defaults, or preserve+merge an existing
 * valid config. Shared by the full scaffold and `--config-only` so the two paths
 * cannot drift on the config's default content.
 */
async function writeConfigFile(opts: InitOptions, result: InitResult, agentDir: string, agentDirExists: boolean): Promise<void> {
  const freshConfig = opts.d1
    ? ConfigSchema.parse({ ...DEFAULT_CONFIG, migrate: buildD1MigrateBlock(opts.cwd) })
    : DEFAULT_CONFIG;
  const writeFresh = (): Promise<void> =>
    writeFile(join(agentDir, "config.json"), JSON.stringify(freshConfig, null, 2) + "\n", "utf8");

  if (!agentDirExists) {
    await writeFresh();
    result.created.push(".metaobjects/config.json");
    return;
  }

  const configPath = join(agentDir, "config.json");
  let priorContent: string | undefined;
  try {
    priorContent = await readFile(configPath, "utf8");
    const parsed = ConfigSchema.parse(JSON.parse(priorContent));
    const merged = ConfigSchema.parse({ ...DEFAULT_CONFIG, ...parsed });
    // When a valid .metaobjects/config.json already exists and the user passes --force,
    // we preserve the existing config and only re-scaffold support files. The --d1 flag
    // only takes effect on fresh inits — retro-fitting D1 onto an existing project is
    // the user's job (edit migrate.dialect and migrate.d1 in config.json directly).
    await saveConfig(agentDir, merged);
    result.preserved.push(".metaobjects/config.json");
    return;
  } catch {
    if (priorContent === undefined) {
      // The .metaobjects/ dir existed but config.json itself did not — a fresh write.
      await writeFresh();
      result.created.push(".metaobjects/config.json");
      return;
    }

    // In the full-scaffold path this is only reachable once the caller has
    // already required --force (the exists-guard at the top of `init()`
    // throws before writeConfigFile runs otherwise), so opts.force is always
    // true there. `--config-only` calls this function directly with no such
    // guard, so without this check it would silently destroy an existing,
    // merely-unparseable config on every run — the one thing `--force` is
    // supposed to gate.
    if (!opts.force) {
      throw new Error(
        `existing .metaobjects/config.json exists but could not be parsed; refusing to overwrite it. ` +
        `Use --force to replace it with defaults. Prior content:\n${priorContent}`,
      );
    }
    log.warn("existing .metaobjects/config.json was invalid — writing fresh defaults. Prior content:");
    log.warn(priorContent);
    result.warnings.push("invalid .metaobjects/config.json replaced with defaults");
    await writeFresh();
    // F11 — matches the OTHER two `writeFresh()` call sites above: this IS a
    // fresh write (a destructive one, replacing content that could not be
    // parsed), not a no-op. Omitting this left it in neither `created` nor
    // `preserved`, so the `--config-only` CLI summary (which keys on
    // `result.created.includes(...)` alone) reported "already exists — left
    // untouched" for a config it had just overwritten with defaults.
    result.created.push(".metaobjects/config.json");
  }
}

export async function init(opts: InitOptions): Promise<InitResult> {
  const result: InitResult = { created: [], preserved: [], warnings: [] };
  const agentDir = join(opts.cwd, DEFAULT_METAOBJECTS_DIR);
  const metaobjectsDir = join(opts.cwd, DEFAULT_METADATA_DIR);

  const agentDirExists = await dirExists(agentDir);
  const metaobjectsExists = await dirExists(metaobjectsDir);
  const exists = agentDirExists || metaobjectsExists;

  if (opts.docsOnly) {
    // Agent-context only: scaffold the always-on + skills + root wiring, never the metaobjects/ project.
    await writeAgentContext(opts, result);
    return result;
  }

  if (opts.configOnly) {
    // --print-only must win outright: a documented dry run must never write, and
    // this branch used to return ABOVE the printOnly guard the full-scaffold path
    // uses below, so `--config-only --print-only` silently wrote the real file.
    if (opts.printOnly) {
      result.created.push(".metaobjects/config.json");
      return result;
    }
    // Config only: write/preserve .metaobjects/config.json and nothing else — no
    // metaobjects/ dir, no agent-context, no TypeScript scaffold. `agentDirExists` is
    // captured before the mkdir below so an existing valid config is still preserved.
    await mkdir(agentDir, { recursive: true });
    await writeConfigFile(opts, result, agentDir, agentDirExists);
    return result;
  }

  if (opts.refreshDocs && exists) {
    // Refresh-only path: (re)write the agent-context docs and NOTHING else — never
    // the project scaffold (metaobjects/, config.json, codegen/generators/,
    // metaobjects.config.ts). `--force` on this path means "overwrite hand-edited
    // docs in place instead of writing <path>.new" (handled in writeAgentContext),
    // NOT a full re-init — so refresh must short-circuit BEFORE the scaffold path
    // even when --force is set (issue #163). A refresh on a not-yet-initialized
    // repo (!exists) still falls through to a full init, matching prior behavior.
    await writeAgentContext(opts, result);
    return result;
  }

  if (exists && !opts.force && !opts.refreshDocs) {
    throw new Error(
      "metaobjects/ or .metaobjects/ already exists; use --force to overwrite scaffold files (existing records are preserved), or --refresh-docs to update only agent docs",
    );
  }

  const dirs = [
    DEFAULT_METADATA_DIR,
    DEFAULT_METAOBJECTS_DIR,
    `${DEFAULT_METAOBJECTS_DIR}/.gen-state`,
  ];

  if (opts.printOnly) {
    for (const d of dirs) result.created.push(d);
    result.created.push(
      "metaobjects/meta.common.json",
      ".metaobjects/config.json",
      ".metaobjects/.gitignore",
      `.metaobjects/${PACKAGE_MANIFEST_FILE}`,
    );
    result.created.push(".metaobjects/AGENTS.md", ".metaobjects/CLAUDE.md", ".claude/skills/metaobjects-*", AGENT_CONTEXT_MANIFEST_PATH);
    for (const name of SCAFFOLDED_GENERATOR_NAMES) result.created.push(`${OWNED_GENERATORS_DIR}/${name}.ts`);
    result.created.push("metaobjects.config.ts", DB_STUB_REL_PATH, ".gitignore");
    return result;
  }

  for (const d of dirs) {
    await mkdir(join(opts.cwd, d), { recursive: true });
    if (!result.created.includes(d)) result.created.push(d);
  }

  // metaobjects/meta.common.json — placeholder, only if absent
  const commonJsonPath = join(metaobjectsDir, "meta.common.json");
  if (!(await fileExists(commonJsonPath))) {
    await writeFile(commonJsonPath, META_COMMON_JSON, "utf8");
    result.created.push("metaobjects/meta.common.json");
  } else {
    result.preserved.push("metaobjects/meta.common.json");
  }

  // .metaobjects/config.json
  await writeConfigFile(opts, result, agentDir, agentDirExists);

  // .metaobjects/.gitignore
  await writeFile(join(agentDir, ".gitignore"), METAOBJECTS_GITIGNORE_BODY, "utf8");
  result.created.push(".metaobjects/.gitignore");

  // .metaobjects/package.meta.json — scaffold v0.3 package manifest if absent
  const manifestPath = join(agentDir, PACKAGE_MANIFEST_FILE);
  if (!(await fileExists(manifestPath))) {
    const defaultPackageName = basename(opts.cwd);
    const manifestBody = {
      name: defaultPackageName,
      version: "0.1.0",
      extends: [] as string[],
    };
    await writeFile(manifestPath, JSON.stringify(manifestBody, null, 2) + "\n", "utf8");
    result.created.push(`.metaobjects/${PACKAGE_MANIFEST_FILE}`);
  } else {
    result.preserved.push(`.metaobjects/${PACKAGE_MANIFEST_FILE}`);
  }

  await writeAgentContext(opts, result);

  // ADR-0034 — scaffold the OWNED codegen generators that metaobjects.config.ts imports
  // locally. Done before the config so the import targets exist on first `meta gen`.
  await writeOwnedGenerators(opts, result);

  // Scaffold metaobjects.config.ts at the project root. Never overwrite if it exists.
  const forgeConfigPath = join(opts.cwd, "metaobjects.config.ts");
  if (!(await fileExists(forgeConfigPath))) {
    await writeFile(forgeConfigPath, buildMetaobjectsConfigBody(opts.d1 ? "d1" : "sqlite"), "utf8");
    result.created.push("metaobjects.config.ts");
  }

  // Scaffold the `dbImport` throwing stub at DB_STUB_REL_PATH ("src/db.ts" by
  // default) — ONLY if absent, so a re-run never clobbers a user's real db module
  // (same "write once" precedent as writeOwnedGenerators above). Without this, the
  // scaffolded config declares `dbImport: "../db"` pointing at a module `meta init`
  // never creates, and a fresh project's FIRST `tsc` fails to resolve it.
  const dbStubPath = join(opts.cwd, DB_STUB_REL_PATH);
  if (!(await fileExists(dbStubPath))) {
    await mkdir(dirname(dbStubPath), { recursive: true });
    await writeFile(dbStubPath, DB_STUB_BODY, "utf8");
    result.created.push(DB_STUB_REL_PATH);
  } else {
    result.preserved.push(DB_STUB_REL_PATH);
  }

  // Scaffold a minimal root .gitignore ONLY when the project has none — never
  // clobber a user's existing one (they may have their own rules).
  const rootGitignorePath = join(opts.cwd, ".gitignore");
  if (!(await fileExists(rootGitignorePath))) {
    await writeFile(rootGitignorePath, ROOT_GITIGNORE_BODY, "utf8");
    result.created.push(".gitignore");
  } else {
    result.preserved.push(".gitignore");
  }

  await ensureEsmPackageType(opts.cwd, result);

  return result;
}

/**
 * MetaObjects emits ESM only, and so does everything `meta init` scaffolds. If the
 * project's `package.json` does not say so, the FIRST `tsc` a new adopter runs fails
 * — not subtly:
 *
 *     codegen/generators/barrel.ts(14,3): error TS1295: ECMAScript imports and
 *     exports cannot be written in a CommonJS file under 'verbatimModuleSyntax'.
 *
 * …ninety-odd times, across the scaffolded generators and every generated file, on
 * the exact path the README and these next-steps prescribe. Two ecosystem defaults
 * conspire: `npm init -y` now writes `"type": "commonjs"` explicitly, and a stock
 * `tsc --init` on TypeScript 7 enables `verbatimModuleSyntax`.
 *
 * So set it — but never silently take a real CommonJS project with it. A project
 * that has actual CJS sources gets a loud, specific warning instead of an edit,
 * because changing a module system out from under working code is not ours to do.
 */
async function ensureEsmPackageType(cwd: string, result: InitResult): Promise<void> {
  const pkgPath = join(cwd, "package.json");
  if (!(await fileExists(pkgPath))) {
    // No package.json at all: say what is needed rather than inventing a manifest
    // (name/version/license are the user's to choose).
    result.warnings.push(
      'no package.json found — create one with `npm init -y`, then set `"type": "module"`: ' +
        "MetaObjects scaffolds and generates ESM, which will not compile in a CommonJS project.",
    );
    return;
  }

  let pkg: Record<string, unknown>;
  let raw: string;
  try {
    raw = await readFile(pkgPath, "utf8");
    pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    result.warnings.push(
      'package.json could not be parsed — ensure it sets `"type": "module"` by hand ' +
        "(MetaObjects scaffolds and generates ESM).",
    );
    return;
  }

  if (pkg.type === "module") return;   // already correct — nothing to do, nothing to say

  if (await hasCommonJsSources(cwd)) {
    result.warnings.push(
      'this project has CommonJS sources, so `"type": "module"` was NOT set for you — ' +
        "but the scaffolded generators and all generated code are ESM and will not " +
        "compile without it. Either migrate the project to ESM, or keep the generated " +
        "code in a sub-directory with its own package.json declaring `\"type\": \"module\"`.",
    );
    return;
  }

  const declaredType = pkg.type;   // read BEFORE the mutation below overwrites it
  pkg.type = "module";
  const added = addScaffoldDevDependencies(pkg);
  // Preserve the file's existing indentation rather than reformatting someone's manifest.
  const indent = /\n(\s+)"/.exec(raw)?.[1] ?? "  ";
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, indent)}\n`, "utf8");
  // Past tense, deliberately: this reports an edit already made. The imperative
  // ("set `\"type\": \"module\"`") read as a TODO on the one line a newcomer sees
  // last, so a scaffold that had just done the right thing looked like it had failed.
  //
  // And it must not claim the manifest was SILENT on the point: `npm init -y` writes
  // `"type": "commonjs"` explicitly (npm 11.x), which is the dominant first-touch path,
  // so "declared no module system" was false exactly where it is read most. Report what
  // was actually there.
  const previous = typeof declaredType === "string" ? declaredType : undefined;
  result.warnings.push(
    `package.json ${previous === undefined ? "declared no module system" : `declared "type": "${previous}"`} — ` +
      'set `"type": "module"` for you, because MetaObjects scaffolds and generates ESM, ' +
      "which a CommonJS project cannot compile.",
  );
  if (added.length > 0) {
    result.warnings.push(
      `added ${added.join(" + ")} to devDependencies — the scaffolded ` +
        "codegen/generators/ are YOUR source now (ADR-0034) and import them. " +
        "Run your package manager's install before `meta gen`.",
    );
  }
}

/**
 * ADR-0034 scaffold-and-own hands the project real source files under
 * `codegen/generators/`, and those files import `@metaobjectsdev/codegen-ts` and
 * `@metaobjectsdev/metadata`. Installing `@metaobjectsdev/cli` alone does not put
 * either of them where the project can resolve them, so the scaffold arrived
 * un-typecheckable: ten TS2307s on files `meta init` had just written.
 *
 * Declaring them is the honest fix — they are dependencies of code that now lives in
 * the adopter's repo. Deliberately NOT declared: `ts-poet`. The scaffolded templates
 * import the ts-poet combinators via @metaobjectsdev/codegen-ts (re-exported from its
 * own ts-poet instance) precisely so that the Code objects they compose share ONE
 * ts-poet copy with the engine's render* primitives — a project-local ts-poet is the
 * second physical copy that split the class identity under a globally-installed /
 * linked CLI (duplicate imports in generated files, TS2300 on first tsc; see the
 * gen-split-tree gate). Only ever ADDS a missing key: an existing pin is the user's.
 * Returns what it added so the caller can tell them to install.
 */
function addScaffoldDevDependencies(pkg: Record<string, unknown>): string[] {
  const version = cliVersion();
  const wanted: Record<string, string> = {
    "@metaobjectsdev/codegen-ts": `^${version}`,
    "@metaobjectsdev/metadata": `^${version}`,
  };
  const dev = (pkg.devDependencies ?? {}) as Record<string, string>;
  const deps = (pkg.dependencies ?? {}) as Record<string, string>;
  const added: string[] = [];
  for (const [name, range] of Object.entries(wanted)) {
    if (dev[name] !== undefined || deps[name] !== undefined) continue;
    dev[name] = range;
    added.push(name);
  }
  if (added.length > 0) {
    pkg.devDependencies = Object.fromEntries(Object.entries(dev).sort(([a], [b]) => a.localeCompare(b)));
  }
  return added;
}

/** True when the project has hand-written CommonJS at the root (excluding tooling dirs). */
async function hasCommonJsSources(cwd: string): Promise<boolean> {
  const SKIP = new Set(["node_modules", ".git", "dist", "build", ".metaobjects", "codegen"]);
  const stack = [cwd];
  let scanned = 0;
  while (stack.length > 0 && scanned < 400) {
    const dir = stack.pop()!;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith(".")) stack.push(join(dir, e.name)); continue; }
      if (e.name.endsWith(".cjs")) return true;
      if (!e.name.endsWith(".js")) continue;
      scanned++;
      try {
        const body = await readFile(join(dir, e.name), "utf8");
        if (/\brequire\s*\(|\bmodule\.exports\b|\bexports\.\w/.test(body)) return true;
      } catch { /* unreadable — not evidence of CJS */ }
    }
  }
  return false;
}

function buildD1MigrateBlock(cwd: string): Record<string, unknown> {
  const block: Record<string, unknown> = { dialect: "d1" };
  const cfgPath = findWranglerConfig(cwd);
  if (cfgPath !== undefined) {
    try {
      const parsed = parseWranglerConfig(cfgPath);
      if (parsed.d1Bindings.length === 1) {
        block.d1 = { binding: parsed.d1Bindings[0]!.binding };
      }
      // Multi-binding case: omit d1 entirely. User picks the binding later with
      // `meta migrate --d1 <name>` (which prompts with the available names).
    } catch {
      // Parse failed; leave d1 sub-block absent.
    }
  }
  return block;
}

export function nextStepsBlock(): string {
  return NEXT_STEPS;
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

export async function initCommand(args: string[], cwd: string): Promise<number> {
  let flags;
  try {
    flags = parseInitArgs(args);
  } catch (err) {
    log.error((err as Error).message);
    return 2;
  }

  try {
    const result = await init({
      cwd,
      force: flags.force,
      quiet: flags.quiet,
      printOnly: flags.printOnly,
      refreshDocs: flags.refreshDocs,
      d1: flags.d1,
      servers: flags.servers,
      clients: flags.clients,
      noSkills: flags.noSkills,
      wireRoot: flags.wireRoot,
      docsOnly: flags.docsOnly,
      configOnly: flags.configOnly,
    });

    if (flags.printOnly) {
      log.info("Would create:");
      for (const path of result.created) log.info(`  ${path}`);
      return 0;
    }

    if (!flags.quiet) {
      if (flags.docsOnly) {
        log.info(`Scaffolded the MetaObjects agent context (${result.created.length} files): .metaobjects/AGENTS.md + .claude/skills/metaobjects-*.`);
        for (const w of result.warnings) log.info(`  ${w}`);
        log.info("Re-run --docs-only --refresh-docs to update; --no-wire-root to skip the root CLAUDE.md @import.");
      } else if (flags.configOnly) {
        if (result.created.includes(".metaobjects/config.json")) {
          log.info("Wrote .metaobjects/config.json — declare your metadata sources there for the Node CLI (migrate, verify --db).");
        } else {
          log.info(".metaobjects/config.json already exists — left untouched.");
        }
        for (const w of result.warnings) log.warn(w);
      } else {
        log.info(nextStepsBlock());
        // Surface any scaffold warnings (e.g. the #77 monorepo-subdir agent-context
        // discovery warning) — these are otherwise dropped on the normal init path.
        for (const w of result.warnings) log.warn(w);
      }
    }
    return 0;
  } catch (err) {
    log.error((err as Error).message);
    return 1;
  }
}
