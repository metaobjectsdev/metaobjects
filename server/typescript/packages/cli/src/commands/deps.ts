// server/typescript/packages/cli/src/commands/deps.ts
//
// FR-023 Phase 1a — Task 14 shipped `meta deps sync` (`path` transport) and
// `meta deps list`; Task 15 shipped `meta deps check` (this file's `runCheck`).
import { join } from "node:path";
import {
  DEFAULT_METAOBJECTS_DIR,
  discoverCollectionRoot,
  loadConfig,
  loadMemory,
  resolveCollection,
  type DependencySpec,
  type Lock,
} from "@metaobjectsdev/sdk";
import { parseDepsArgs, type DepsFlags } from "../lib/args.js";
import { log } from "../lib/log.js";
import { emitStructured, type OutputFormat } from "../lib/format.js";
import { reportLoadError } from "../lib/load-error.js";
import { collectionLoadOptions } from "../lib/collection-load-options.js";
import {
  applySync,
  checkDependencies,
  ERR_DEPENDENCY_UPSTREAM_DRIFT,
  formatCheckLine,
  hash8,
  planSync,
  readLockOrThrow,
} from "../lib/dependency-sync.js";

/** The declared `dependencies` for the config governing `cwd` — read
 *  DIRECTLY via `loadConfig`, never through `resolveCollection`/`Collection`:
 *  that resolver VERIFIES the snapshot against the lock (`verifySnapshot`)
 *  and throws `ERR_DEPENDENCY_SNAPSHOT_STALE` the moment they disagree — the
 *  exact condition `meta deps sync` exists to fix. A project with no config
 *  at all declares none (`resolveCollection`'s own default: no config ⇒ no
 *  dependencies), which `discoverCollectionRoot`'s `hasConfig` already knows
 *  without a doomed `loadConfig` call. */
async function declaredDependencies(cwd: string): Promise<{ configDir: string; specs: readonly DependencySpec[] }> {
  const { dir: configDir, hasConfig } = await discoverCollectionRoot(cwd);
  if (!hasConfig) return { configDir, specs: [] };
  const cfg = await loadConfig(join(configDir, DEFAULT_METAOBJECTS_DIR));
  return { configDir, specs: cfg.dependencies };
}

async function runSync(configDir: string, specs: readonly DependencySpec[], flags: DepsFlags, fmt: OutputFormat): Promise<number> {
  let lock: Lock | undefined;
  try {
    lock = await readLockOrThrow(configDir);
  } catch (err) {
    // Same convention as `depsCommand`'s `declaredDependencies` catch below: a
    // committed project file that fails to parse is a config-class problem,
    // exit 2 — distinct from the exit-1 a `sync` verdict failure gets.
    log.error((err as Error).message);
    return 2;
  }

  let plan;
  try {
    plan = await planSync(configDir, specs, lock, flags.names);
  } catch (err) {
    log.error((err as Error).message);
    return 1;
  }

  let applied;
  try {
    applied = await applySync(configDir, plan, { dryRun: flags.dryRun });
  } catch (err) {
    log.error((err as Error).message);
    return 1;
  }

  if (fmt === "text") {
    for (const w of plan.warnings) log.info(w);
    if (applied.report.length === 0) {
      log.info("meta deps sync: nothing to do — no dependencies declared.");
    } else {
      for (const r of applied.report) log.info(r.line);
    }
  } else {
    emitStructured(
      {
        warnings: plan.warnings,
        dependencies: applied.report.map((r) => ({ name: r.name, action: r.action, message: r.line })),
      },
      fmt,
    );
  }

  // A dry run wrote nothing to validate — the plan already stands for what
  // WOULD load.
  if (flags.dryRun) return 0;

  // DESIGN §4.1's closing sentence: load the full collection once, so a sync
  // that produces an unloadable model (a collision the plan missed because it
  // only compares declared node LISTS, a scope that now excludes something
  // load-bearing, …) fails in THIS command with the loader's own error,
  // rather than surfacing on the next unrelated `meta gen`/`verify`.
  let collection;
  try {
    collection = await resolveCollection(configDir);
  } catch (err) {
    log.error(`meta deps sync: the updated dependency set does not resolve: ${(err as Error).message}`);
    return 1;
  }
  try {
    await loadMemory(collection.configDir, collectionLoadOptions(collection));
  } catch (err) {
    reportLoadError(log, "meta deps sync: the updated dependency set does not load", err);
    return 1;
  }

  return 0;
}

async function runList(configDir: string, fmt: OutputFormat): Promise<number> {
  let lock: Lock | undefined;
  try {
    lock = await readLockOrThrow(configDir);
  } catch (err) {
    log.error((err as Error).message);
    return 2;
  }
  const entries = Object.entries(lock?.dependencies ?? {});

  if (fmt === "text") {
    if (entries.length === 0) {
      log.info("meta deps list: no dependencies locked — run `meta deps sync`.");
      return 0;
    }
    for (const [name, entry] of entries) {
      log.info(
        `${name} ${entry.version} ${hash8(entry.integrity)} ${entry.nodes.length} node(s) ${entry.packages.join(", ")}`,
      );
    }
  } else {
    emitStructured(
      { dependencies: entries.map(([name, entry]) => ({ name, ...entry })) },
      fmt,
    );
  }
  return 0;
}

/**
 * `meta deps check` (Task 15) — re-resolve each declared dependency exactly
 * as `sync` steps 1-2 do and compare its installed artifact's TRUE hash
 * against what `.metaobjects/deps.lock.json` pinned. Read-only: never touches
 * the lock or the snapshot (that is `sync`'s job). A `drifted` or
 * `unresolved` dependency fails the command — a check that cannot check must
 * not pass.
 */
async function runCheck(
  configDir: string,
  specs: readonly DependencySpec[],
  fmt: OutputFormat,
): Promise<number> {
  let lock: Lock | undefined;
  try {
    lock = await readLockOrThrow(configDir);
  } catch (err) {
    log.error((err as Error).message);
    return 2;
  }

  if (specs.length === 0) {
    if (fmt === "text") {
      log.info("meta deps check: nothing to check — no dependencies declared.");
    } else {
      emitStructured({ dependencies: [] }, fmt);
    }
    return 0;
  }

  const results = await checkDependencies(configDir, specs, lock);
  const failing = results.filter((r) => r.status !== "current");

  if (fmt === "text") {
    for (const r of results) log.info(formatCheckLine(r));
    if (failing.length > 0) {
      log.error(
        `meta deps check: ${failing.length} of ${results.length} dependenc` +
          `${results.length === 1 ? "y" : "ies"} drifted or unresolved (${ERR_DEPENDENCY_UPSTREAM_DRIFT}).`,
      );
    }
  } else {
    emitStructured(
      {
        dependencies: results.map((r) => ({ ...r, line: formatCheckLine(r) })),
        ...(failing.length > 0 ? { code: ERR_DEPENDENCY_UPSTREAM_DRIFT } : {}),
      },
      fmt,
    );
  }

  return failing.length > 0 ? 1 : 0;
}

export async function depsCommand(args: string[], cwd: string, fmt: OutputFormat): Promise<number> {
  let flags: DepsFlags;
  try {
    flags = parseDepsArgs(args);
  } catch (err) {
    log.error((err as Error).message);
    return 2;
  }

  let configDir: string;
  let specs: readonly DependencySpec[];
  try {
    ({ configDir, specs } = await declaredDependencies(cwd));
  } catch (err) {
    // Mirrors `resolveCollection`'s own convention for a config.json that
    // EXISTS but fails to load (malformed JSON, a schema violation): exit 2,
    // the same code every other routed command uses for that class of
    // failure (gen.ts, migrate.ts, docs.ts) — distinct from the exit 1 a
    // dependency-resolution failure gets below, because this is a config
    // problem, not a `sync` verdict.
    log.error((err as Error).message);
    return 2;
  }

  switch (flags.subverb) {
    case "sync":
      return runSync(configDir, specs, flags, fmt);
    case "list":
      return runList(configDir, fmt);
    case "check":
      return runCheck(configDir, specs, fmt);
  }
}
