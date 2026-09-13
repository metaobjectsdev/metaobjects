import { mkdir, writeFile, readFile, readdir, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { existsSync as existsSyncWrap, readFileSync as readFileSyncWrap } from "node:fs";
import { DEFAULT_CONFIG, ConfigSchema, saveConfig, PACKAGE_MANIFEST_FILE, DEFAULT_METADATA_DIR, DEFAULT_METAOBJECTS_DIR, DEPS_DIR, LOCK_FILE } from "@metaobjectsdev/sdk";
import {
  assemble, resolveAgentContextRoot, planScaffold,
  AGENT_CONTEXT_MANIFEST_PATH, type Manifest, type Stack,
} from "@metaobjectsdev/sdk/agent-context";
import { assertKnownStackValues, resolveStack } from "../lib/detect-stack.js";
import { reportIgnoredScaffold } from "../lib/ignored-scaffold-check.js";
import { parseInitArgs } from "../lib/args.js";
import { log } from "../lib/log.js";
import { cliVersion } from "../lib/version.js";
import { findWranglerConfig, parseWranglerConfig } from "@metaobjectsdev/migrate-ts";
import { DEFAULT_DOCS_DIR } from "@metaobjectsdev/codegen-ts";

// ADR-0034 scaffold-and-own — `meta init` copies the codegen reference templates into
// the consumer's repo so they OWN them; metaobjects.config.ts imports them locally.
const OWNED_GENERATORS_DIR = "codegen/generators";


// The scaffolded config's outDir, as a named constant so the config template and
// anything derived from it cannot drift.
//
// `dbImport` is deliberately NOT here any more. It existed only because the scaffold
// wired `routesFile()`, whose output emits `import { db } from …`; with nothing wired
// there is no such import, so the throwing `src/db.ts` stub that made it resolve has
// gone too. `dbImport` is now a `configKey` on the `routes` catalog entry — reported by
// `meta gen --list` and by `meta eject routes`, to the adopter who actually chose it.
const SCAFFOLD_OUT_DIR = "src/generated";

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
!${DEPS_DIR}/
!${LOCK_FILE}
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

export default defineConfig({
  outDir:  "${SCAFFOLD_OUT_DIR}",
  dialect: "${dialect}",

  // NOTHING IS GENERATED UNTIL YOU CHOOSE IT.
  //
  // MetaObjects does not decide which code your application needs — you do, or the
  // agent working in this repo does. The catalog is:
  //
  //   meta gen --list --format json --probe
  //
  // \`--probe\` runs every generator against YOUR model and reports how many files each
  // would emit, so you can see what your metadata is already asking for. Group by
  // \`layer\`: model / persistence / api / client / docs / capability.
  //
  // Then take the ones you want:
  //
  //   meta eject entity queries routes barrel
  //
  // That copies each generator into ./codegen/generators/ — YOURS to edit, and what
  // \`meta gen\` runs — and prints the import line to add here, the entry to add below,
  // what to install, and any config keys those generators read (\`dbImport\`,
  // \`apiPrefix\`, \`extStyle\`, …). Add them here as you go.
  generators: [],

  docs: {
    outDir: "${DEFAULT_DOCS_DIR}",  // every surface lands here (run: meta docs).
                               // A SUB-directory on purpose: these pages are regenerated
                               // and overwritten, and docs/ itself is usually yours.
    layout: "flat",            // or "package" for multi-package models
    // surfaces defaults to ["model", "api", "requirements", "agent"] — all four.
    // Documentation is the one thing that IS on by default, because the requirements
    // and agent surfaces emit ZERO files for a project with nothing to describe, and
    // the always-on agent context points at the agent/ pages by name.
  },
});
`;
}

const SCAFFOLD_SUMMARY = `
Initialized metaobjects/ + .metaobjects/ + metaobjects.config.ts
codegen/generators/ is EMPTY on purpose: no code is generated until you choose it.
`;

const NEXT_STEPS = `
Next steps:
  0. Everything here is ESM — package.json needs "type": "module" (init sets it
     unless the project has CommonJS sources; without it the first tsc fails).
  1. Author entities under metaobjects/ (start from the scaffolded meta.common.json)
  2. meta gen --list --probe    # the catalog: every generator, grouped by layer, with
                                #   how many files each would emit for YOUR model
  3. meta eject <name>...       # take the ones you want — copies them into
                                #   codegen/generators/ (yours to edit) and prints the
                                #   import, the entry to wire, and what to install
  4. meta gen                   # generate from exactly what you wired
  5. meta docs                  # neutral model + API docs (on by default)
  6. Create your tables: meta migrate --from-db --db file:dev.sqlite --dialect sqlite --slug init --apply

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
  /** agent-context files deleted because this stack no longer assembles them. */
  removed: string[];
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

/** Delete twin of writeUnlessDryRun — a dry run must not remove anything either. */
async function removeUnlessDryRun(cwd: string, dryRun: boolean, path: string): Promise<void> {
  if (dryRun) return;
  await rm(join(cwd, path), { force: true });
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

  // A fragment this stack no longer assembles. `prunes` are ones we wrote that nobody has
  // touched — deleting is exactly as safe as the overwrite the same hash predicate already
  // authorises above, and leaving them contradicts every SKILL.md footer, which tells the
  // reader to read every references/*.md "one per server language in this project's stack".
  for (const orphan of decision.prunes) {
    await removeUnlessDryRun(opts.cwd, dryRun, orphan);
    result.removed.push(orphan);
  }
  // Hand-edited ones are never deleted — losing an adopter's writing is worse than leaving
  // a stale file behind — so they are named, with the reason and the remedy.
  for (const orphan of decision.removed) {
    result.warnings.push(
      `${orphan} is no longer part of this stack but appears hand-edited, so it was kept; ` +
      "delete it yourself once you have salvaged anything you want from it.",
    );
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
 * Scaffold the owned-codegen TIER: the directory and its tsconfig, and nothing in it.
 *
 * `meta init` used to copy five reference generators here eagerly and wire all five in
 * the scaffolded config. Codegen is opt-in now, so it copies NONE: the directory exists
 * because it is part of the layout ADR-0034 promises (and `tsconfig.codegen.json`
 * covers it the moment something lands), and `meta eject <name>...` is the door.
 *
 * The empty directory is not a placeholder for a decision deferred — it is the decision.
 * A scaffold that wires a suite pre-empts the one judgement this design exists to leave
 * to whoever is building the app.
 */
async function writeOwnedGenerators(opts: InitOptions, result: InitResult): Promise<void> {
  await mkdir(join(opts.cwd, OWNED_GENERATORS_DIR), { recursive: true });
  await writeCodegenTsconfig(opts, result);
}

/** The owned codegen tier's own tsconfig — see writeCodegenTsconfig. */
const CODEGEN_TSCONFIG_REL = "tsconfig.codegen.json";

const CODEGEN_TSCONFIG_BODY = `{
  // The owned codegen tier typechecks itself.
  //
  // \`meta gen\` loads metaobjects.config.ts and ./codegen/** through jiti, which
  // TRANSPILES WITHOUT TYPECHECKING. So a generator here can import a symbol the
  // engine no longer exports, or call a method that does not exist, and every gate
  // stays green until the import is evaluated — which for a generator you have not
  // wired into \`generators: [...]\` may be never.
  //
  // A project's app tsconfig usually covers src/ and tests/ and NOT this tier, so
  // without this file nothing compiles the code your build depends on. Run it with:
  //   npx tsc -p tsconfig.codegen.json --noEmit
  "compilerOptions": {
    "target": "ES2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["metaobjects.config.ts", "codegen/**/*.ts"]
}
`;

/**
 * Scaffold a tsconfig that covers the tier `meta init` just handed the adopter.
 *
 * Reported from an estate that found TWO real defects the moment one existed: a
 * generator importing `CODEGEN_ATTR_EMIT_ROUTES` (retired with the `@emit*` family,
 * and invisible because that generator was not in `generators: [...]`), and a wired
 * generator carrying five type errors including `ownFields()` on a node that has no
 * such method. Both found on the first run.
 *
 * Written only when absent, like every other scaffolded file — an adopter who has
 * their own arrangement keeps it, and it is reported as preserved rather than
 * silently skipped.
 */
async function writeCodegenTsconfig(opts: InitOptions, result: InitResult): Promise<void> {
  const abs = join(opts.cwd, CODEGEN_TSCONFIG_REL);
  if (await fileExists(abs)) {
    result.preserved.push(CODEGEN_TSCONFIG_REL);
    return;
  }
  await writeFile(abs, CODEGEN_TSCONFIG_BODY, "utf8");
  result.created.push(CODEGEN_TSCONFIG_REL);
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
  // Refused HERE, in the shared function, before anything is written — NOT at one CLI
  // entry point. It was at `initCommand`'s arg parse only, and `meta agent-docs` calls
  // this directly: `meta init --docs-only --server klingon` exited 2 with the message
  // while `meta agent-docs --server klingon` exited 0, reported "11 files", and recorded
  // `"servers": []`. That is the worse of the two doors to miss — `agent-docs` is the
  // canonical redirect target for every language port, so the ports used the unguarded
  // one. A non-empty override array suppresses both the prior manifest's stack AND
  // detection, so a dropped value does not degrade, it inverts three statements in the
  // generated context.
  assertKnownStackValues({ servers: opts.servers ?? [], clients: opts.clients ?? [] });
  const result: InitResult = { created: [], preserved: [], removed: [], warnings: [] };
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
    );
    result.created.push(".metaobjects/AGENTS.md", ".metaobjects/CLAUDE.md", ".claude/skills/metaobjects-*", AGENT_CONTEXT_MANIFEST_PATH);
    result.created.push(OWNED_GENERATORS_DIR, CODEGEN_TSCONFIG_REL);
    result.created.push("metaobjects.config.ts", ".gitignore");
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

  // .metaobjects/package.meta.json — the v0.3 prototype manifest is deprecated
  // (nothing reads it; FR-023 metadata dependencies is its replacement), so
  // `meta init` no longer scaffolds it. A pre-existing one is left untouched;
  // just note the deprecation so an existing project sees it.
  const legacyManifestPath = join(agentDir, PACKAGE_MANIFEST_FILE);
  if (await fileExists(legacyManifestPath)) {
    result.warnings.push(
      `note: .metaobjects/${PACKAGE_MANIFEST_FILE} is deprecated (nothing reads it; removed in 2.0) — see docs/features/metadata-dependencies.md`,
    );
  }

  await writeAgentContext(opts, result);

  // ADR-0034 — the owned-codegen TIER: the directory and its tsconfig. Nothing is
  // copied into it; `meta eject <name>...` is the door (see writeOwnedGenerators).
  await writeOwnedGenerators(opts, result);

  // Scaffold metaobjects.config.ts at the project root. Never overwrite if it exists.
  const forgeConfigPath = join(opts.cwd, "metaobjects.config.ts");
  if (!(await fileExists(forgeConfigPath))) {
    await writeFile(forgeConfigPath, buildMetaobjectsConfigBody(opts.d1 ? "d1" : "sqlite"), "utf8");
    result.created.push("metaobjects.config.ts");
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

  await prepareManifestForScaffold(opts.cwd, result);

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
 *
 * IT ALSO DECLARES WHAT THE SCAFFOLD AND THE GENERATED OUTPUT IMPORT, and the name it used
 * to carry (`ensureEsmPackageType`) is why that went wrong: a function named for one job
 * accreted a second, and the second silently inherited the first's early returns. The
 * declarations are unconditional on a readable manifest — see the comment at that point.
 */
async function prepareManifestForScaffold(cwd: string, result: InitResult): Promise<void> {
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

  // TWO INDEPENDENT JOBS FROM HERE, and they must not share an exit.
  //
  // The module system is one; declaring what the scaffold and the generated output import
  // is the other, and it is true of every project with a readable manifest — including the
  // one that already had `"type": "module"` and needs no module-system edit at all. Those
  // two were folded together, below this function's early returns, and the consequence was
  // that the adopter who had set their project up CORRECTLY got no declarations and no
  // warning: `meta gen` worked (the CLI aliases those specifiers for itself) while `tsc`
  // reported TS2307 on all five files `meta init` had just written. Under a strict
  // installer that is every one of them; npm's hoisting hid roughly half.
  //
  // `moduleSystemNote` is computed first and applied last so the two jobs share ONE write
  // of the manifest, rather than one job's early return deciding the other's fate.
  let moduleSystemNote: string | undefined;

  if (pkg.type !== "module") {
    if (await hasCommonJsSources(cwd)) {
      // `"type": "module"` is NOT set — changing a module system out from under working
      // CJS code is not ours to do. The dependency declarations below still apply: they
      // are about what the generated code imports, not about how it is loaded.
      result.warnings.push(
        'this project has CommonJS sources, so `"type": "module"` was NOT set for you — ' +
          "but the scaffolded generators and all generated code are ESM and will not " +
          "compile without it. Either migrate the project to ESM, or keep the generated " +
          "code in a sub-directory with its own package.json declaring `\"type\": \"module\"`.",
      );
    } else {
      const declaredType = pkg.type;   // read BEFORE the mutation below overwrites it
      pkg.type = "module";
      // Past tense, deliberately: this reports an edit already made. The imperative
      // ("set `\"type\": \"module\"`") read as a TODO on the one line a newcomer sees
      // last, so a scaffold that had just done the right thing looked like it had failed.
      //
      // And it must not claim the manifest was SILENT on the point: `npm init -y` writes
      // `"type": "commonjs"` explicitly (npm 11.x), which is the dominant first-touch path,
      // so "declared no module system" was false exactly where it is read most. Report what
      // was actually there.
      const previous = typeof declaredType === "string" ? declaredType : undefined;
      moduleSystemNote =
        `package.json ${previous === undefined ? "declared no module system" : `declared "type": "${previous}"`} — ` +
        'set `"type": "module"` for you, because MetaObjects scaffolds and generates ESM, ' +
        "which a CommonJS project cannot compile.";
    }
  }

  // NO DEPENDENCIES ARE ADDED. `meta init` used to declare five packages here —
  // codegen-ts and metadata for the generators it copied, drizzle-orm / zod / fastify
  // for the code those generators would write — and every one of them was a
  // consequence of the scaffold WIRING a suite. It wires nothing now, so declaring
  // anything would be declaring a dependency on code this project may never generate.
  //
  // The need did not vanish, it MOVED to the moment a generator is chosen:
  // `meta eject <name>...` reports the exact install set for what you took, with
  // third-party ranges read from the runtime package's own peerDependencies (see
  // lib/install-set.ts), and `meta gen --list --format json` carries the same set per
  // entry before you commit to anything.
  if (moduleSystemNote !== undefined) {
    // Preserve the file's existing indentation rather than reformatting someone's manifest.
    const indent = /\n(\s+)"/.exec(raw)?.[1] ?? "  ";
    await writeFile(pkgPath, `${JSON.stringify(pkg, null, indent)}\n`, "utf8");
    result.warnings.push(moduleSystemNote);
  }
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

/**
 * The post-init message.
 *
 * Takes no arguments now. It used to take `dbStubWritten`, because the scaffold wrote a
 * throwing `src/db.ts` on some runs and not others and a static string claimed it on
 * every one. With nothing wired there is no `dbImport` and no stub, so the message is
 * the same on every path again.
 */
export function nextStepsBlock(): string {
  return SCAFFOLD_SUMMARY + NEXT_STEPS;
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
    // Also here, so a bad value is a USAGE error (exit 2) rather than the exit 1 an
    // init failure gets. `init()` refuses it too, which is what covers every other door.
    assertKnownStackValues({ servers: flags.servers ?? [], clients: flags.clients ?? [] });
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
      // A count is not a guarantee that the files reached the repository. Many projects
      // git-ignore `.claude/` under a comment about credentials — a common and defensible
      // convention — and eight of the eleven files land there. Ignored, they exist only on
      // the machine that ran this: not committed, absent from CI and from a fresh clone,
      // invisible to a teammate, while `.agent-context.json` (which IS committed) tracks
      // them. That silently voids the whole downstream agent-context design, and the answer
      // was available from the outputs this command had just written.
      reportIgnoredScaffold(cwd, result.created);
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
