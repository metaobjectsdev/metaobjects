import { log } from "./lib/log.js";
export { defineConfig } from "@metaobjects/codegen-ts";
export type { MetaobjectsGenConfig } from "@metaobjects/codegen-ts";

const VERSION = "0.2.0";

const HELP_TEXT = `meta — MetaObjects CLI (v${VERSION})

USAGE:
  meta <command> [flags]

COMMANDS:
  init                  Scaffold metaobjects/ + .metaobjects/ in the current repo
  init --refresh-docs   Refresh .metaobjects/AGENTS.md + CLAUDE.md after CLI upgrades
  gen [<entity>...]     Codegen TS targets from metaobjects/ entities
  migrate               Diff metadata vs live DB; emit migration SQL files
  --version, -v         Print version
  --help, -h            Print this help

GEN FLAGS:
  --dry-run             Compute and print, don't write
  <entity> [<entity>]   Positional filter on entity names
  (outDir, dialect, dbImport, extStyle are read from metaobjects.config.ts)

MIGRATE FLAGS:
  --db <url>            DB connection URL (required, or set DATABASE_URL or config)
                        Supports: file:, libsql:, postgres:, postgresql:
  --dialect sqlite|postgres   Optional override (auto-detected from URL scheme)
  --out-dir <path>      Migration directory (default: ./.metaobjects/migrations)
  --slug <name>         Required when changes are present (e.g., add-user-shipping)
  --allow <csv>         Comma-separated destructive-change permissions:
                        drop-column,drop-table,type-change,drop-index,drop-fk,nullable-to-not-null
  --on-ambiguous abort|rename|drop-add   Default abort
  --dry-run             Print SQL to stdout, don't write

Other commands (ingest, mcp, serve, install-hooks, audit, capture, promote)
ship in later sub-projects. See https://metaobjects.com for docs.
`;

export async function run(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case "--help":
    case "-h":
      log.info(HELP_TEXT);
      return 0;
    case "--version":
    case "-v":
      log.info(VERSION);
      return 0;
    case "init": {
      const { initCommand } = await import("./commands/init.js");
      return initCommand(rest);
    }
    case "gen": {
      const { genCommand } = await import("./commands/gen.js");
      return genCommand(rest);
    }
    case "migrate": {
      const { migrateCommand } = await import("./commands/migrate.js");
      return migrateCommand(rest);
    }
    default:
      log.error(`Unknown command: ${cmd}`);
      log.info(HELP_TEXT);
      return 2;
  }
}
