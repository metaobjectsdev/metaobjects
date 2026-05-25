import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { basename } from "node:path";
import { DEFAULT_CONFIG, ConfigSchema, saveConfig, PACKAGE_MANIFEST_FILE, DEFAULT_METADATA_DIR, DEFAULT_METAOBJECTS_DIR } from "@metaobjectsdev/sdk";
import { parseInitArgs } from "../lib/args.js";
import { log } from "../lib/log.js";
import { AGENT_DOCS_BODY, withContentHash, isUnmodified } from "@metaobjectsdev/sdk/agent-docs";
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

const AGENT_DOC_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

export interface InitOptions {
  cwd: string;
  force?: boolean;
  quiet?: boolean;
  printOnly?: boolean;
  refreshDocs?: boolean;
  d1?: boolean;
}

export interface InitResult {
  created: string[];
  preserved: string[];
  warnings: string[];
}

async function writeAgentDocs(agentDir: string, result: InitResult): Promise<void> {
  const docsBody = withContentHash(AGENT_DOCS_BODY);
  for (const filename of AGENT_DOC_FILES) {
    const path = join(agentDir, filename);
    const exists = await fileExists(path);

    if (!exists) {
      await writeFile(path, docsBody, "utf8");
      result.created.push(`.metaobjects/${filename}`);
      continue;
    }

    const existingBody = await readFile(path, "utf8");
    if (isUnmodified(existingBody)) {
      await writeFile(path, docsBody, "utf8");
      result.created.push(`.metaobjects/${filename}`);
    } else {
      await writeFile(`${path}.new`, docsBody, "utf8");
      result.created.push(`.metaobjects/${filename}.new`);
      result.warnings.push(
        `${filename} appears to have been hand-edited; refreshed docs written to ${filename}.new`,
      );
    }
  }
}

export async function init(opts: InitOptions): Promise<InitResult> {
  const result: InitResult = { created: [], preserved: [], warnings: [] };
  const agentDir = join(opts.cwd, DEFAULT_METAOBJECTS_DIR);
  const metaobjectsDir = join(opts.cwd, DEFAULT_METADATA_DIR);

  const agentDirExists = await dirExists(agentDir);
  const metaobjectsExists = await dirExists(metaobjectsDir);
  const exists = agentDirExists || metaobjectsExists;

  if (opts.refreshDocs && exists && !opts.force) {
    // Refresh-only path: scaffold agent docs, leave everything else alone.
    await writeAgentDocs(agentDir, result);
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
    for (const filename of AGENT_DOC_FILES) result.created.push(`.metaobjects/${filename}`);
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

  await writeAgentDocs(agentDir, result);

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
    });

    if (flags.printOnly) {
      log.info("Would create:");
      for (const path of result.created) log.info(`  ${path}`);
      return 0;
    }

    if (!flags.quiet) {
      log.info(nextStepsBlock());
    }
    return 0;
  } catch (err) {
    log.error((err as Error).message);
    return 1;
  }
}
