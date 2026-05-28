import { relative } from "node:path";
import { parseGenArgs } from "../lib/args.js";
import { resolveGenConfig } from "../lib/config.js";
import { loadMetaobjectsConfig } from "../lib/load-metaobjects-config.js";
import { formatGenResult, type GenFileEntry, type GenFileStatus } from "../lib/output.js";
import { log } from "../lib/log.js";
import { loadMemory } from "@metaobjectsdev/sdk";
import { runGen } from "@metaobjectsdev/codegen-ts";
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
    if (msg.includes("ENOENT") || msg.includes("no such") || msg.includes("cannot read")) {
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
