import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./lib/log.js";
export { defineConfig } from "@metaobjectsdev/codegen-ts";
export type { MetaobjectsGenConfig } from "@metaobjectsdev/codegen-ts";

// Derive the version from the CLI's own package.json so it never goes stale.
// The compiled entry is dist/src/index.js while package.json sits at the package
// root, so walk up from the module location until @metaobjectsdev/cli's manifest.
function readCliVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
        if (pkg.name === "@metaobjectsdev/cli" && pkg.version) return pkg.version;
      } catch {
        // not our manifest / unreadable — keep walking up
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0";
}

const VERSION = readCliVersion();

const HELP_TEXT = `meta — MetaObjects CLI (v${VERSION})

USAGE:
  meta <command> [flags]

COMMANDS:
  init                  Scaffold metaobjects/ + .metaobjects/ in the current repo
  init --refresh-docs   Refresh .metaobjects/AGENTS.md + CLAUDE.md after CLI upgrades
  gen [<entity>...]     Codegen TS targets from metaobjects/ entities
  export                Flatten loaded metadata to one canonical JSON artifact
  docs <metadata> --out <dir>  Generate neutral metadata documentation (entity + template pages)
  verify                Drift gate — subverbs: --templates / --db / --codegen (bare = --templates)
  prompt-snapshot       Snapshot rendered template.* output; --check gates drift
  migrate               Diff metadata vs live DB; emit migration SQL files
  --version, -v         Print version
  --help, -h            Print this help

GLOBAL OPTIONS:
  --cwd <path>, -C <path>   Run as if launched from <path> (default: current directory)

GEN FLAGS:
  --dry-run             Compute and print, don't write
  <entity> [<entity>]   Positional filter on entity names
  (outDir, dialect, dbImport, extStyle are read from metaobjects.config.ts)

EXPORT FLAGS:
  --out <file>          Write output to a file (default: stdout)

DOCS FLAGS:
  <metadata>            Project root holding metaobjects/ (default: current directory)
  --out <dir>, -o       Output directory for the pages (default: ./docs)
  --templates <dir>     Project root to resolve adopter templates/ overrides (default: <metadata>)

VERIFY FLAGS (ADR-0021 D2 — explicit subverbs; combine any; exit 1 on ANY drift):
  --templates           Template/prompt {{field}}↔payload drift (the bare-verify default)
  --codegen             Codegen drift — regenerate to a temp dir and diff the committed
                        output (config outDir/targets). Needs metaobjects.config.ts; exit 2 if absent.
  --db <url>            Schema drift — live DB URL enables the schema-drift gate.
                        Supports: file:, libsql:, postgres:, postgresql:. Omit to skip.
  --prompts <dir>       Directory of provider-resolved template text (default: prompts)
  --dialect sqlite|postgres   Optional override (auto-detected from --db URL scheme)
  --allow <csv>         Accepted for parity with 'migrate'; does NOT affect the
                        verify drift gate (the gate fails on ANY detected change)
  --skip-schema         Skip the schema-drift gate even when --db is present

PROMPT-SNAPSHOT FLAGS:
  --check               Compare against committed snapshots; exit 1 on drift (CI gate)
  --prompts <dir>       Directory of provider-resolved template text (default: prompts)

MIGRATE FLAGS:
  --db <url>            DB connection URL (required, or set DATABASE_URL or config)
                        Supports: file:, libsql:, postgres:, postgresql:
  --dialect sqlite|postgres|d1   Optional override (auto-detected from URL scheme)
  --out-dir <path>      Migration directory (default: ./.metaobjects/migrations)
  --slug <name>         Required when changes are present (e.g., add-user-shipping)
  --allow <csv>         Comma-separated destructive-change permissions:
                        drop-column,drop-table,type-change,drop-index,drop-fk,nullable-to-not-null
  --on-ambiguous abort|rename|drop-add   Default abort
  --d1 <binding>        D1 binding name from wrangler.toml (only with --dialect d1)
  --remote              Target remote D1 instead of local (only with --dialect d1)
  --apply               Run 'wrangler d1 migrations apply' after writing files
  --yes                 Skip the --remote --apply confirmation pause
  --dry-run             Print SQL to stdout, don't write

Other commands (ingest, mcp, serve, install-hooks, audit, capture, promote)
ship in later sub-projects. See https://metaobjects.com for docs.
`;

export async function run(argv: string[]): Promise<number> {
  // Extract the global --cwd / -C flag (anywhere in argv). A relative path
  // resolves against the real process.cwd(). Absent → process.cwd().
  let cwd = process.cwd();
  const cleaned: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--cwd" || a === "-C") {
      const val = argv[i + 1];
      if (val === undefined) {
        log.error(`${a} requires a path argument`);
        return 2;
      }
      cwd = resolve(process.cwd(), val);
      i++; // consume the value
      continue;
    }
    if (a.startsWith("--cwd=")) {
      const val = a.slice("--cwd=".length);
      if (val === "") {
        log.error("--cwd= requires a path argument");
        return 2;
      }
      cwd = resolve(process.cwd(), val);
      continue;
    }
    cleaned.push(a);
  }

  const [cmd, ...rest] = cleaned;
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
      return initCommand(rest, cwd);
    }
    case "gen": {
      const { genCommand } = await import("./commands/gen.js");
      return genCommand(rest, cwd);
    }
    case "export": {
      const { exportCommand } = await import("./commands/export.js");
      return exportCommand(rest, cwd);
    }
    case "docs": {
      const { docsCommand } = await import("./commands/docs.js");
      return docsCommand(rest, cwd);
    }
    case "verify": {
      const { verifyCommand } = await import("./commands/verify.js");
      return verifyCommand(rest, cwd);
    }
    case "prompt-snapshot": {
      const { promptSnapshotCommand } = await import("./commands/prompt-snapshot.js");
      return promptSnapshotCommand(rest, cwd);
    }
    case "migrate": {
      const { migrateCommand } = await import("./commands/migrate.js");
      return migrateCommand(rest, cwd);
    }
    default:
      log.error(`Unknown command: ${cmd}`);
      log.info(HELP_TEXT);
      return 2;
  }
}
