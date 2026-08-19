import { relative } from "node:path";
import { parseGenArgs } from "../lib/args.js";
import { resolveGenConfig } from "../lib/config.js";
import { loadMetaobjectsConfig } from "../lib/load-metaobjects-config.js";
import { formatGenResult, formatGenResultToon, type GenFileEntry, type GenFileStatus } from "../lib/output.js";
import { formatGenResultJson } from "../lib/output-json.js";
import type { OutputFormat } from "../lib/format.js";
import { log } from "../lib/log.js";
import { warnIfAgentContextStale } from "../lib/agent-context-staleness.js";
import { scanSourceForAntiPatterns } from "../lib/anti-patterns.js";
import { loadMemory, resolveCollection } from "@metaobjectsdev/sdk";
import { runGen, listGenerators } from "@metaobjectsdev/codegen-ts";
import type { WriteStatus } from "@metaobjectsdev/codegen-ts";

function mapStatus(s: WriteStatus): GenFileStatus {
  switch (s) {
    case "new":
    case "overwrite": return "new";
    case "merged":    return "merged";
    case "conflict":  return "conflict";
    case "unchanged":
    case "skipped":   return "unchanged";
    case "refused":   return "refused";
  }
}

export async function genCommand(args: string[], cwd: string, fmt: OutputFormat = "text"): Promise<number> {
  let flags;
  try { flags = parseGenArgs(args); }
  catch (err) { log.error((err as Error).message); return 2; }

  // ADR-0021 D3 — `meta gen --list`: print the stable-name generator registry
  // and exit 0 WITHOUT running codegen (no config/metadata required).
  if (flags.list) {
    return listGeneratorsCommand();
  }

  const cliConfig = resolveGenConfig(flags);

  // Discovery and load are two separate failure modes, kept in separate try
  // blocks deliberately: a broad catch around both previously swallowed
  // genuine ParseErrors (e.g. `origin.@via "X.y" ...: no such relationship
  // "y" on X`) as "no metaobjects/ found", masking the real failure.
  // `resolveCollection` raises `ERR_COLLECTION_NOT_FOUND` with its own
  // message when nothing is discovered and no default directory exists.
  //
  // Discovery runs BEFORE the config read, deliberately: the project root is
  // whichever directory `resolveCollection` decided the metadata belongs to,
  // and everything project-relative — `metaobjects.config.ts`, the `outDir`
  // its generators name, `.metaobjects/.gen-state/` — has to come from that
  // same directory. Reading the config from ambient cwd while the metadata
  // came from an ancestor is the config-half of the very divergence this
  // design exists to remove (design §4.6.1: "Per-port generator config is then
  // read from that same directory"). For a run from the project root the two
  // are the same path, which is the only invocation that worked before.
  let collection;
  try {
    collection = await resolveCollection(cwd);
  } catch (err) {
    log.error((err as Error).message);
    return 2;
  }
  const projectRoot = collection.configDir;

  // Advisory: nudge to refresh the .claude/skills docs if they predate this CLI.
  // Rooted at `projectRoot`, not ambient cwd — the scaffolded agent context sits
  // with the project that declares the metadata, so a run from a subdirectory
  // would find no manifest there and silently skip the nudge. `meta verify` makes
  // the same call for the same reason; the two commands describe this and the
  // anti-pattern scan below as one advisory pass, so they must scan one tree.
  warnIfAgentContextStale(projectRoot);

  let forgeConfig;
  try {
    forgeConfig = await loadMetaobjectsConfig(projectRoot);
  } catch (err) {
    log.error((err as Error).message);
    return 2;
  }

  let metadata;
  try {
    metadata = await loadMemory(collection.configDir, {
      files: collection.files,
      ...(forgeConfig.providers !== undefined ? { providers: forgeConfig.providers } : {}),
    });
  } catch (err) {
    log.error(`failed to load metadata: ${(err as Error).message}`);
    return 2;
  }

  let result;
  try {
    result = await runGen({
      config: forgeConfig,
      metadata,
      projectRoot,
      baseline: flags.baseline,
      // --dry-run must actually preview. This was previously passed only to the
      // display object below, so a "preview" run wrote every file.
      dryRun: cliConfig.dryRun,
      // Collection-level `scope` (Task 12b) — the output filter over
      // GENERATED entities, never over what the collection loads. Always
      // passed: an unconfigured project's predicate admits everything, so this
      // is a no-op for the common case, not a behavior change.
      scope: collection.inScope,
      ...(cliConfig.entities.length > 0 ? { entityFilter: cliConfig.entities } : {}),
    });
  } catch (err) {
    log.error(`gen failed: ${(err as Error).message}`);
    return 1;
  }

  for (const w of result.warnings) { log.warn(w); }

  // result.files[].path is the absolute full path from decideAndWrite. With
  // per-target output, show each path relative to the project root so files in
  // different targets are distinguishable.
  const files: GenFileEntry[] = result.files.map((f) => ({
    path: relative(projectRoot, f.path),
    status: mapStatus(f.status),
    info: "",
  }));

  const targetDirs = Array.from(new Set(
    (forgeConfig.targets ? Object.values(forgeConfig.targets).map((t) => t.outDir) : [])
      .concat([forgeConfig.outDir]),
  ));
  const genResult = {
    files,
    outDir: targetDirs.length > 1 ? targetDirs.join(", ") : forgeConfig.outDir,
    dialect: forgeConfig.dialect,
    dryRun: cliConfig.dryRun,
    warnings: [],
  };
  const output =
    fmt === "toon" ? formatGenResultToon(genResult)
    : fmt === "json" ? formatGenResultJson(genResult)
    : formatGenResult(genResult, { isTTY: !!process.stdout.isTTY });

  log.info(output);

  // End-of-run conflict summary — surfaces in CI logs alongside the file
  // listing. The non-zero exit code below carries the failure signal.
  if (result.conflicts.length > 0) {
    const list = result.conflicts
      .map((c) => `  - ${relative(projectRoot, c.path)}`)
      .join("\n");
    log.warn(
      `meta gen completed with ${result.conflicts.length} conflict(s). ` +
        `Resolve and re-run to advance the canonical state.\n${list}`,
    );
  }

  // Advisory verify-as-teacher pass (same as `meta verify`): on a real write run,
  // surface authored source that hand-rolls what the metadata could model. `gen`
  // is the command an agent always runs, so this is where the teaching actually
  // reaches it. Warnings ONLY — never affects the exit code. Suppress with
  // --no-antipatterns or META_NO_ANTIPATTERNS=1 (both opt-outs work on `meta gen`
  // and `meta verify`).
  if (!cliConfig.dryRun && !flags.noAntipatterns && process.env.META_NO_ANTIPATTERNS !== "1") {
    try {
      const findings = scanSourceForAntiPatterns(projectRoot);
      if (findings.length > 0) {
        const CAP = 10;
        log.warn(
          `\nmeta gen — ${findings.length} place(s) hand-roll what MetaObjects can model ` +
            `(advisory — declaring the construct lets codegen own it):`,
        );
        for (const f of findings.slice(0, CAP)) log.warn(`  ${f.message}`);
        if (findings.length > CAP) log.warn(`  …and ${findings.length - CAP} more.`);
      }
    } catch { /* never let an advisory scan break gen */ }
  }

  const hasFailure = files.some((f) => f.status === "conflict" || f.status === "refused");
  return hasFailure ? 1 : 0;
}

/**
 * `meta gen --list` — print the stable-name generator registry (ADR-0021 D3).
 *
 * Generators are grouped by tier: the recommended native `meta gen` suite
 * first, then neutral artifacts (owned by `meta docs` per D1). Each line is
 * `<stable-name>  —  <description>` plus an options summary and, for neutral
 * entries, a note pointing at the canonical door. Exits 0; no codegen runs.
 */
function listGeneratorsCommand(): number {
  const entries = listGenerators();
  const native = entries.filter((e) => e.tier === "native");
  const neutral = entries.filter((e) => e.tier === "neutral");
  const width = Math.max(...entries.map((e) => e.name.length));

  const lines: string[] = [];
  lines.push("Available generators (select by stable name):");
  lines.push("");
  lines.push("Native (recommended `meta gen` suite):");
  for (const e of native) {
    lines.push(`  ${e.name.padEnd(width)}  —  ${e.description}`);
    if (e.options) lines.push(`  ${" ".repeat(width)}     options: ${e.options}`);
  }
  lines.push("");
  lines.push("Neutral (owned by `meta docs`; not part of the native suite):");
  for (const e of neutral) {
    lines.push(`  ${e.name.padEnd(width)}  —  ${e.description}`);
    if (e.note) lines.push(`  ${" ".repeat(width)}     ${e.note}`);
  }

  log.info(lines.join("\n"));
  return 0;
}
