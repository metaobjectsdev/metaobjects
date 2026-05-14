import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { basename } from "node:path";
import { DEFAULT_CONFIG, ConfigSchema, saveConfig, PACKAGE_MANIFEST_FILE, DEFAULT_METADATA_DIR, DEFAULT_METAFORGE_DIR } from "@metaforge/sdk";
import { parseInitArgs } from "../lib/args.js";
import { log } from "../lib/log.js";
import { AGENT_DOCS_BODY, withContentHash, isUnmodified } from "../lib/agent-docs.js";

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

const METAFORGE_GITIGNORE_BODY = `.gen-state/
`;

const FORGE_CONFIG_BODY = `import { defineConfig } from "@metaforge/cli";
import {
  entityFile,
  queriesFile,
  routesFile,
  // formFile,        // opt-in: emit React form components
  barrel,
} from "@metaobjects/codegen-ts/generators";

export default defineConfig({
  outDir:    "./src/db",
  extStyle:  "none",
  dbImport:  "../db",
  dialect:   "sqlite",
  apiPrefix: "",     // set to "/api" if your routes mount under /api
  generators: [
    entityFile(),
    queriesFile(),
    routesFile(),
    barrel(),
  ],
});
`;

const NEXT_STEPS = `
Initialized metaobjects/ + .metaforge/ + metaforge.config.ts

Next steps (when later sub-projects ship):
  forge ingest        # propose entities from your existing TS code
  forge gen           # codegen TS targets from entities
  forge serve         # local viewer
  forge install-hooks # register MCP server + Claude Code hooks
`;

const AGENT_DOC_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

export interface InitOptions {
  cwd: string;
  force?: boolean;
  quiet?: boolean;
  printOnly?: boolean;
  refreshDocs?: boolean;
}

export interface InitResult {
  created: string[];
  preserved: string[];
  warnings: string[];
}

async function writeAgentDocs(metaforgeDir: string, result: InitResult): Promise<void> {
  const docsBody = withContentHash(AGENT_DOCS_BODY);
  for (const filename of AGENT_DOC_FILES) {
    const path = join(metaforgeDir, filename);
    const exists = await fileExists(path);

    if (!exists) {
      await writeFile(path, docsBody, "utf8");
      result.created.push(`.metaforge/${filename}`);
      continue;
    }

    const existingBody = await readFile(path, "utf8");
    if (isUnmodified(existingBody)) {
      await writeFile(path, docsBody, "utf8");
      result.created.push(`.metaforge/${filename}`);
    } else {
      await writeFile(`${path}.new`, docsBody, "utf8");
      result.created.push(`.metaforge/${filename}.new`);
      result.warnings.push(
        `${filename} appears to have been hand-edited; refreshed docs written to ${filename}.new`,
      );
    }
  }
}

export async function init(opts: InitOptions): Promise<InitResult> {
  const result: InitResult = { created: [], preserved: [], warnings: [] };
  const metaforgeDir = join(opts.cwd, DEFAULT_METAFORGE_DIR);
  const metaobjectsDir = join(opts.cwd, DEFAULT_METADATA_DIR);

  const metaforgeExists = await dirExists(metaforgeDir);
  const metaobjectsExists = await dirExists(metaobjectsDir);
  const exists = metaforgeExists || metaobjectsExists;

  if (opts.refreshDocs && exists && !opts.force) {
    // Refresh-only path: scaffold agent docs, leave everything else alone.
    await writeAgentDocs(metaforgeDir, result);
    return result;
  }

  if (exists && !opts.force && !opts.refreshDocs) {
    throw new Error(
      "metaobjects/ or .metaforge/ already exists; use --force to overwrite scaffold files (existing records are preserved), or --refresh-docs to update only agent docs",
    );
  }

  const dirs = [
    DEFAULT_METADATA_DIR,
    DEFAULT_METAFORGE_DIR,
    `${DEFAULT_METAFORGE_DIR}/.gen-state`,
  ];

  if (opts.printOnly) {
    for (const d of dirs) result.created.push(d);
    result.created.push(
      "metaobjects/meta.common.json",
      ".metaforge/config.json",
      ".metaforge/.gitignore",
      `.metaforge/${PACKAGE_MANIFEST_FILE}`,
    );
    for (const filename of AGENT_DOC_FILES) result.created.push(`.metaforge/${filename}`);
    result.created.push("metaforge.config.ts");
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

  // .metaforge/config.json
  if (metaforgeExists) {
    const configPath = join(metaforgeDir, "config.json");
    let priorContent: string | undefined;
    try {
      priorContent = await readFile(configPath, "utf8");
      const parsed = ConfigSchema.parse(JSON.parse(priorContent));
      const merged = ConfigSchema.parse({ ...DEFAULT_CONFIG, ...parsed });
      await saveConfig(metaforgeDir, merged);
      result.preserved.push(".metaforge/config.json");
    } catch {
      if (priorContent !== undefined) {
        log.warn("existing .metaforge/config.json was invalid — writing fresh defaults. Prior content:");
        log.warn(priorContent);
        result.warnings.push("invalid .metaforge/config.json replaced with defaults");
      }
      await writeFile(
        join(metaforgeDir, "config.json"),
        JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n",
        "utf8",
      );
      if (priorContent === undefined) {
        result.created.push(".metaforge/config.json");
      }
    }
  } else {
    await writeFile(
      join(metaforgeDir, "config.json"),
      JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n",
      "utf8",
    );
    result.created.push(".metaforge/config.json");
  }

  // .metaforge/.gitignore
  await writeFile(join(metaforgeDir, ".gitignore"), METAFORGE_GITIGNORE_BODY, "utf8");
  result.created.push(".metaforge/.gitignore");

  // .metaforge/package.meta.json — scaffold v0.3 package manifest if absent
  const manifestPath = join(metaforgeDir, PACKAGE_MANIFEST_FILE);
  if (!(await fileExists(manifestPath))) {
    const defaultPackageName = basename(opts.cwd);
    const manifestBody = {
      name: defaultPackageName,
      version: "0.1.0",
      extends: [] as string[],
    };
    await writeFile(manifestPath, JSON.stringify(manifestBody, null, 2) + "\n", "utf8");
    result.created.push(`.metaforge/${PACKAGE_MANIFEST_FILE}`);
  } else {
    result.preserved.push(`.metaforge/${PACKAGE_MANIFEST_FILE}`);
  }

  await writeAgentDocs(metaforgeDir, result);

  // Scaffold metaforge.config.ts at the project root. Never overwrite if it exists.
  const forgeConfigPath = join(opts.cwd, "metaforge.config.ts");
  if (!(await fileExists(forgeConfigPath))) {
    await writeFile(forgeConfigPath, FORGE_CONFIG_BODY, "utf8");
    result.created.push("metaforge.config.ts");
  }

  return result;
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

export async function initCommand(args: string[]): Promise<number> {
  let flags;
  try {
    flags = parseInitArgs(args);
  } catch (err) {
    log.error((err as Error).message);
    return 2;
  }

  try {
    const result = await init({
      cwd: process.cwd(),
      force: flags.force,
      quiet: flags.quiet,
      printOnly: flags.printOnly,
      refreshDocs: flags.refreshDocs,
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
