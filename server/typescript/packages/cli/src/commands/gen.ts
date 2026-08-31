import { relative } from "node:path";
import { parseGenArgs } from "../lib/args.js";
import { resolveGenConfig } from "../lib/config.js";
import { loadMemoryOptionsFrom, loadMetaobjectsConfig, resolveGenCollection, resolveGenConfigDir } from "../lib/load-metaobjects-config.js";
import { formatGenResult, formatGenResultToon, type GenFileEntry, type GenFileStatus } from "../lib/output.js";
import { formatGenResultJson } from "../lib/output-json.js";
import type { OutputFormat } from "../lib/format.js";
import { log } from "../lib/log.js";
import { warnIfAgentContextStale } from "../lib/agent-context-staleness.js";
import { warnIfManifestIgnored } from "../lib/manifest-ignored-check.js";
import { scanSourceForAntiPatterns } from "../lib/anti-patterns.js";
import {
  antiPatternRows, ranSection, skippedSection, warnCapped,
  type AdvisoryFindingRow, type AdvisorySection,
} from "../lib/advisory.js";
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
    // FR-038 §8 — a generated file deleted because it is no longer generated.
    // Shown as its own outcome, not folded into "unchanged": a run summary that
    // lists writes but hides deletions is how a silent deletion happens.
    case "removed":   return "removed";
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
  // Discovery runs BEFORE the config read, deliberately: everything named BY the
  // metadata resolves against the directory `resolveCollection` decided the
  // metadata belongs to. Reading THAT from ambient cwd while the metadata came
  // from an ancestor is the divergence this design exists to remove (design
  // §4.6.1).
  let collection;
  try {
    collection = await resolveCollection(cwd);
  } catch (err) {
    log.error((err as Error).message);
    return 2;
  }
  // ...but `metaobjects.config.ts` is not named by the metadata: it is this
  // package's own answer to a different question (design §4.6 — "how is code
  // generated here?", per-port, versus the port-neutral "where does metadata come
  // from?"). It gets its own nearest-ancestor walk, so a JS app under a Maven- or
  // pip-rooted repo generates with the config sitting beside it rather than
  // demanding one at the repo root that no such repo has (#326). Everything the
  // TS config names follows it — `outDir`, `targets`, and the
  // `.metaobjects/.gen-state/` merge base that mirrors that output, which must be
  // per-package or two apps sharing one collection would clobber each other's.
  // Nearest wins, so a subdirectory declaring nothing still walks up to the
  // project root's config exactly as before.
  const projectRoot = resolveGenConfigDir(cwd, collection.configDir);

  // ...and a package that declares its own sources GENERATES from them (#340). An
  // ancestor collection is the default for a package that declares none, never an
  // addition to one that does — otherwise a sub-project's output silently absorbs
  // metadata from unrelated trees. Identical object when the two configs sit together.
  const genCollection = await resolveGenCollection(collection, projectRoot);

  // Advisory: nudge to refresh the .claude/skills docs if they predate this CLI.
  // Rooted at `projectRoot`, not ambient cwd — the scaffolded agent context sits
  // with the project that declares the metadata, so a run from a subdirectory
  // would find no manifest there and silently skip the nudge. `meta verify` makes
  // the same call for the same reason; the two commands describe this and the
  // anti-pattern scan below as one advisory pass, so they must scan one tree.
  warnIfAgentContextStale(projectRoot);
  // Advisory: the committed hash manifest is what makes hand-edit detection work on a
  // machine that did not generate the output. Silent unless it is ignored. Keyed on
  // projectRoot, not cwd, for the same reason its neighbour is — the manifest belongs to
  // whichever directory `resolveCollection` decided the metadata lives in.
  warnIfManifestIgnored(projectRoot);

  let forgeConfig;
  try {
    forgeConfig = await loadMetaobjectsConfig(projectRoot);
  } catch (err) {
    log.error((err as Error).message);
    return 2;
  }

  let metadata;
  try {
    metadata = await loadMemory(genCollection.configDir, {
      files: genCollection.files,
      ...loadMemoryOptionsFrom(forgeConfig),
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
      scope: genCollection.inScope,
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

  // The advisory verify-as-teacher pass now runs BEFORE the result is rendered,
  // because its findings ride IN the result. It used to run after the payload was
  // printed and write only to stderr as text, so `meta gen --format json` on a run
  // with hundreds of findings emitted a document that mentioned none of them — the
  // structured output being the documented default for an agent on a pipe.
  // Warnings ONLY — nothing here reaches the exit code (bias to under-flagging).
  const antiPatterns = runAntiPatternScan(
    projectRoot, cliConfig.dryRun, flags.noAntipatterns, forgeConfig.verify?.antiPatternIgnore);

  const genResult = {
    files,
    outDir: targetDirs.length > 1 ? targetDirs.join(", ") : forgeConfig.outDir,
    dialect: forgeConfig.dialect,
    dryRun: cliConfig.dryRun,
    warnings: [],
    antiPatterns,
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

  // The human-readable half of the advisory pass, printed after the file listing
  // where a reader expects it. Capped for a terminal; the structured payload above
  // already carried every finding, and the tail line says so.
  if (antiPatterns.total > 0) {
    log.warn(
      `\nmeta gen — ${antiPatterns.total} place(s) hand-roll what MetaObjects can model ` +
        `(advisory — declaring the construct lets codegen own it):`,
    );
    warnCapped(antiPatterns.rows.map((r) => `  ${r.message}`), flags.limit, { structured: fmt !== "text" });
  }

  const hasFailure = files.some((f) => f.status === "conflict" || f.status === "refused");
  return hasFailure ? 1 : 0;
}

/**
 * Run the advisory verify-as-teacher scan (same pass `meta verify` runs): surface
 * authored source that hand-rolls what the metadata could model. `gen` is the
 * command an agent always runs, so this is where the teaching actually reaches it.
 *
 * Returns the section EITHER WAY — a skip is reported with its reason rather than
 * dropped, so a reader can tell "found nothing" from "never looked". Warnings only;
 * it can never affect the exit code. Suppress with --no-antipatterns or
 * META_NO_ANTIPATTERNS=1 (both opt-outs work on `meta gen` and `meta verify`).
 */
function runAntiPatternScan(
  projectRoot: string,
  dryRun: boolean,
  noAntipatterns: boolean,
  ignore: readonly string[] | undefined,
): AdvisorySection<AdvisoryFindingRow> {
  // A --dry-run writes nothing, so it teaches nothing; the scan is skipped, as it
  // always has been. The payload now says that instead of looking clean.
  if (dryRun) return skippedSection("skipped on --dry-run (the advisory pass runs on a real write run)");
  if (noAntipatterns) return skippedSection("suppressed by --no-antipatterns");
  if (process.env.META_NO_ANTIPATTERNS === "1") return skippedSection("suppressed by META_NO_ANTIPATTERNS=1");
  try {
    return ranSection(antiPatternRows(scanSourceForAntiPatterns(
      projectRoot, ignore !== undefined ? { ignore } : undefined)));
  } catch (err) {
    // Never let an advisory scan break gen — but never claim it found nothing either.
    return skippedSection(`the scan failed: ${(err as Error).message}`);
  }
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
