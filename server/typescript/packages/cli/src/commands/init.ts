import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { basename, dirname } from "node:path";
import { existsSync as existsSyncWrap, readFileSync as readFileSyncWrap } from "node:fs";
import { DEFAULT_CONFIG, ConfigSchema, saveConfig, PACKAGE_MANIFEST_FILE, DEFAULT_METADATA_DIR, DEFAULT_METAOBJECTS_DIR } from "@metaobjectsdev/sdk";
import {
  assemble, resolveAgentContextRoot, planScaffold,
  AGENT_CONTEXT_MANIFEST_PATH, type Manifest,
} from "@metaobjectsdev/sdk/agent-context";
import { resolveStack } from "../lib/detect-stack.js";
import { parseInitArgs } from "../lib/args.js";
import { log } from "../lib/log.js";
import { findWranglerConfig, parseWranglerConfig } from "@metaobjectsdev/migrate-ts";

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

const METAOBJECTS_GITIGNORE_BODY = `.gen-state/
`;

function buildMetaobjectsConfigBody(dialect: "sqlite" | "postgres" | "d1" = "sqlite"): string {
  return `import { defineConfig } from "@metaobjectsdev/cli";
import {
  entityFile,
  queriesFile,
  routesFile,
  // formFile,        // opt-in: emit React form components
  barrel,
} from "@metaobjectsdev/codegen-ts/generators";

export default defineConfig({
  outDir:    "./src/db",
  extStyle:  "none",
  dbImport:  "../db",
  dialect:   "${dialect}",
  apiPrefix: "",     // set to "/api" if your routes mount under /api
  generators: [
    entityFile(),
    queriesFile(),
    routesFile(),
    barrel(),
  ],
});
`;
}

const NEXT_STEPS = `
Initialized metaobjects/ + .metaobjects/ + metaobjects.config.ts

Next steps (when later sub-projects ship):
  meta ingest        # propose entities from your existing TS code
  meta gen           # codegen TS targets from entities
  meta serve         # local viewer
  meta install-hooks # register MCP server + Claude Code hooks
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

async function writeAgentContext(opts: InitOptions, result: InitResult): Promise<void> {
  const stack = resolveStack(opts.cwd, { servers: opts.servers ?? [], clients: opts.clients ?? [] });
  let assembled = assemble({ contentRoot: resolveAgentContextRoot(), stack });
  if (opts.noSkills) assembled = assembled.filter((f) => !f.path.startsWith(".claude/skills/"));

  const prior = await readManifest(opts.cwd);
  const decision = planScaffold({
    stack, assembled, prior,
    readCurrent: (rel) => {
      const abs = join(opts.cwd, rel);
      return existsSyncWrap(abs) ? readFileSyncWrap(abs, "utf8") : undefined;
    },
  });

  for (const w of decision.writes) {
    const abs = join(opts.cwd, w.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, w.contents, "utf8");
    result.created.push(w.path);
  }
  for (const c of decision.conflicts) {
    const abs = join(opts.cwd, c.newPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, c.contents, "utf8");
    result.created.push(c.newPath);
    result.warnings.push(`${c.path} appears hand-edited; refreshed version written to ${c.newPath}`);
  }
  const manifestAbs = join(opts.cwd, AGENT_CONTEXT_MANIFEST_PATH);
  await mkdir(dirname(manifestAbs), { recursive: true });
  await writeFile(manifestAbs, JSON.stringify(decision.manifest, null, 2) + "\n", "utf8");

  for (const orphan of decision.removed) {
    result.warnings.push(`${orphan} is no longer part of this stack; orphaned (safe to delete).`);
  }

  if (opts.wireRoot) await wireRootMemory(opts.cwd, result);
}

const ROOT_IMPORT_LINE = "@.metaobjects/AGENTS.md";
async function wireRootMemory(cwd: string, result: InitResult): Promise<void> {
  const claudePath = join(cwd, "CLAUDE.md");
  const agentsPath = join(cwd, "AGENTS.md");
  const claudeExists = await fileExists(claudePath);
  const agentsExists = await fileExists(agentsPath);

  // If neither root memory file exists, create CLAUDE.md (Claude Code's canonical) with the import.
  if (!claudeExists && !agentsExists) {
    await writeFile(claudePath, `# Project memory\n\n${ROOT_IMPORT_LINE}\n`, "utf8");
    result.created.push("CLAUDE.md (created with MetaObjects @import)");
    return;
  }
  // Otherwise append the import to whichever exist (idempotent — never double-add).
  for (const [path, exists] of [[claudePath, claudeExists], [agentsPath, agentsExists]] as const) {
    if (!exists) continue;
    const body = await readFile(path, "utf8");
    if (body.includes(ROOT_IMPORT_LINE)) continue;
    await writeFile(path, `${body.replace(/\n*$/, "\n")}\n${ROOT_IMPORT_LINE}\n`, "utf8");
    result.warnings.push(`wired ${ROOT_IMPORT_LINE} into ${path.endsWith("AGENTS.md") ? "AGENTS.md" : "CLAUDE.md"} so the MetaObjects context loads`);
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

  if (opts.refreshDocs && exists && !opts.force) {
    // Refresh-only path: scaffold the agent-context, leave everything else alone.
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
    result.created.push("metaobjects.config.ts");
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
  const freshConfig = opts.d1
    ? ConfigSchema.parse({ ...DEFAULT_CONFIG, migrate: buildD1MigrateBlock(opts.cwd) })
    : DEFAULT_CONFIG;
  if (agentDirExists) {
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
    } catch {
      if (priorContent !== undefined) {
        log.warn("existing .metaobjects/config.json was invalid — writing fresh defaults. Prior content:");
        log.warn(priorContent);
        result.warnings.push("invalid .metaobjects/config.json replaced with defaults");
      }
      await writeFile(
        join(agentDir, "config.json"),
        JSON.stringify(freshConfig, null, 2) + "\n",
        "utf8",
      );
      if (priorContent === undefined) {
        result.created.push(".metaobjects/config.json");
      }
    }
  } else {
    await writeFile(
      join(agentDir, "config.json"),
      JSON.stringify(freshConfig, null, 2) + "\n",
      "utf8",
    );
    result.created.push(".metaobjects/config.json");
  }

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

  // Scaffold metaobjects.config.ts at the project root. Never overwrite if it exists.
  const forgeConfigPath = join(opts.cwd, "metaobjects.config.ts");
  if (!(await fileExists(forgeConfigPath))) {
    await writeFile(forgeConfigPath, buildMetaobjectsConfigBody(opts.d1 ? "d1" : "sqlite"), "utf8");
    result.created.push("metaobjects.config.ts");
  }

  return result;
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
      } else {
        log.info(nextStepsBlock());
      }
    }
    return 0;
  } catch (err) {
    log.error((err as Error).message);
    return 1;
  }
}
