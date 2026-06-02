import { relative, join } from "node:path";
import { existsSync } from "node:fs";
import { parseGenArgs } from "../lib/args.js";
import { resolveGenConfig } from "../lib/config.js";
import { loadMetaobjectsConfig } from "../lib/load-metaobjects-config.js";
import { formatGenResult, type GenFileEntry, type GenFileStatus } from "../lib/output.js";
import { log } from "../lib/log.js";
import { loadMemory, DEFAULT_METADATA_DIR } from "@metaobjectsdev/sdk";
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

export async function genCommand(args: string[], cwd: string): Promise<number> {
  let flags;
  try { flags = parseGenArgs(args); }
  catch (err) { log.error((err as Error).message); return 2; }

  // ADR-0021 D3 — `meta gen --list`: print the stable-name generator registry
  // and exit 0 WITHOUT running codegen (no config/metadata required).
  if (flags.list) {
    return listGeneratorsCommand();
  }

  const projectRoot = cwd;
  const cliConfig = resolveGenConfig(flags);

  let forgeConfig;
  try {
    forgeConfig = await loadMetaobjectsConfig(projectRoot);
  } catch (err) {
    log.error((err as Error).message);
    return 2;
  }

  let metadata;
  try {
    metadata = await loadMemory(projectRoot, {
      ...(forgeConfig.providers !== undefined ? { providers: forgeConfig.providers } : {}),
    });
  } catch (err) {
    const msg = (err as Error).message;
    // Only emit the scaffold hint for the ACTUAL missing-metadata-dir
    // condition — checked explicitly here. A broad substring match on
    // "no such" / "cannot read" wrongly swallowed genuine ParseErrors (e.g.
    // `origin.@via "X.y" ...: no such relationship "y" on X`) as "no
    // metaobjects/ found", masking the real failure. Real parse/validation
    // errors propagate with their actual message.
    if (!existsSync(join(projectRoot, DEFAULT_METADATA_DIR))) {
      log.error(`no metaobjects/ found in ${projectRoot}; run 'meta init' to scaffold`);
    } else {
      log.error(`failed to load metadata: ${msg}`);
    }
    return 2;
  }

  let result;
  try {
    result = await runGen({
      config: forgeConfig,
      metadata,
      projectRoot,
      baseline: flags.baseline,
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
  const output = formatGenResult({
    files,
    outDir: targetDirs.length > 1 ? targetDirs.join(", ") : forgeConfig.outDir,
    dialect: forgeConfig.dialect,
    dryRun: cliConfig.dryRun,
    warnings: [],
  }, { isTTY: !!process.stdout.isTTY });

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
