import { parseGenArgs } from "../lib/args.js";
import { resolveGenConfig } from "../lib/config.js";
import { loadMetaobjectsConfig } from "../lib/load-metaobjects-config.js";
import { formatGenResult, type GenFileEntry, type GenFileStatus } from "../lib/output.js";
import { log } from "../lib/log.js";
import { loadMemory } from "@metaobjects/sdk";
import { runGen } from "@metaobjects/codegen-ts";
import type { WriteStatus } from "@metaobjects/codegen-ts";

function mapStatus(s: WriteStatus): GenFileStatus {
  switch (s) {
    case "new":
    case "overwrite": return "new";
    case "skipped":   return "unchanged";
    case "refused":   return "refused";
  }
}

export async function genCommand(args: string[]): Promise<number> {
  let flags;
  try { flags = parseGenArgs(args); }
  catch (err) { log.error((err as Error).message); return 2; }

  const projectRoot = process.cwd();
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
    metadata = await loadMemory(projectRoot);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("ENOENT") || msg.includes("no such") || msg.includes("cannot read")) {
      log.error(`no metaobjects/ found in ${projectRoot}; run 'forge init' to scaffold`);
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
      ...(cliConfig.entities.length > 0 ? { entityFilter: cliConfig.entities } : {}),
    });
  } catch (err) {
    log.error(`gen failed: ${(err as Error).message}`);
    return 1;
  }

  for (const w of result.warnings) { log.warn(w); }

  const files: GenFileEntry[] = result.files.map((f) => ({
    path: f.path.split("/").pop() ?? f.path,
    status: mapStatus(f.status),
    info: "",
  }));

  const output = formatGenResult({
    files,
    outDir: forgeConfig.outDir,
    dialect: forgeConfig.dialect,
    dryRun: cliConfig.dryRun,
    warnings: [],
  }, { isTTY: !!process.stdout.isTTY });

  log.info(output);

  const hasFailure = files.some((f) => f.status === "conflict" || f.status === "refused");
  return hasFailure ? 1 : 0;
}
