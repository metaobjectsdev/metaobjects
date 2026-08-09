import { resolve } from "node:path";
import { log } from "./lib/log.js";
import { cliVersion } from "./lib/version.js";
import { resolveFormat, isValidFormat, VALID_FORMATS } from "./lib/format.js";
export { defineConfig } from "@metaobjectsdev/codegen-ts";
export type { MetaobjectsGenConfig } from "@metaobjectsdev/codegen-ts";

const VERSION = cliVersion();

const HELP_TEXT = `meta — MetaObjects CLI (v${VERSION})

USAGE:
  meta <command> [flags]

COMMANDS:
  init                  Scaffold metaobjects/ + .metaobjects/ in the current repo
  init --refresh-docs   Refresh .metaobjects/AGENTS.md + CLAUDE.md after CLI upgrades
  agent-docs            Scaffold only the agent-context (.metaobjects/ + .claude/skills/) — canonical redirect target for all language ports
  gen [<entity>...]     Codegen TS targets from metaobjects/ entities
  types [query]         Search the metadata vocabulary (types, subtypes, @attrs) by name or description
  export                Flatten loaded metadata to one canonical JSON artifact
  docs <metadata> --out <dir>  Generate neutral metadata documentation (entity + template pages; --site for HTML site)
  verify                Drift gate — subverbs: --templates / --db / --codegen (bare = --templates)
  prompt-snapshot       Snapshot rendered template.* output; --check gates drift
  migrate               Diff metadata vs live DB; emit migration SQL files
  --version, -v         Print version
  --help, -h            Print this help

GLOBAL OPTIONS:
  --cwd <path>, -C <path>   Run as if launched from <path> (default: current directory)
  --format <toon|json|text> Output format (default: toon on non-TTY, text on TTY)

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
  --prompts <dir>       Extra dir holding prompt .mustache sources for --site (e.g. data/templates/)

VERIFY FLAGS (ADR-0021 D2 — explicit subverbs; combine any; exit 1 on ANY drift):
  --templates           Template/prompt {{field}}↔payload drift (the bare-verify default)
  --codegen             Codegen drift — regenerate to a temp dir and diff the committed
                        output (config outDir/targets). Needs metaobjects.config.ts; exit 2 if absent.
  --db <url>            Schema drift — live DB URL enables the schema-drift gate.
                        Supports: file:, libsql:, postgres:, postgresql:. Omit to skip.
                        D1 has no URL — use --dialect d1 / --d1 <binding> instead.
  --prompts <dir>       Directory of provider-resolved template text (default: prompts)
  --dialect sqlite|postgres|d1   Optional override (auto-detected from --db URL scheme)
  --allow <csv>         Accepted for parity with 'migrate'; does NOT affect the
                        verify drift gate (the gate fails on ANY detected change)
  --skip-schema         Skip the schema-drift gate even when --db is present
  --d1 <binding>        D1 binding name from wrangler.toml (only with --dialect d1)
  --remote              Target remote D1 instead of local (only with --dialect d1) —
                        the ONLY way to verify the actual deployed D1 database
  --no-antipatterns     Suppress the advisory "you hand-rolled what MetaObjects can
                        model" pass (aggregate/currency/enum hints; warnings only)

PROMPT-SNAPSHOT FLAGS:
  --check               Compare against committed snapshots; exit 1 on drift (CI gate)
  --prompts <dir>       Directory of provider-resolved template text (default: prompts)

MIGRATE FLAGS:
  --db <url>            DB connection URL (required, or set DATABASE_URL or config)
                        Supports: file:, libsql:, postgres:, postgresql:
                        D1 has no URL — use --dialect d1 / --d1 <binding> instead.
  --dialect sqlite|postgres|d1   Optional override (auto-detected from URL scheme)
  --out-dir <path>      Migration directory (default: ./.metaobjects/migrations)
  --slug <name>         Required when changes are present (e.g., add-user-shipping)
  --allow <csv>         Comma-separated destructive-change permissions:
                        drop-column,drop-table,type-change,drop-index,drop-fk,
                        drop-check,drop-view,drop-view-cascade,
                        adopt-view,nullable-to-not-null,drop-identity-default
  --on-ambiguous abort|rename|drop-add   Default abort
  --d1 <binding>        D1 binding name from wrangler.toml (only with --dialect d1)
  --remote              Target remote D1 instead of local (only with --dialect d1)
  --apply               Run 'wrangler d1 migrations apply' after writing files
  --yes                 Skip the --remote --apply confirmation pause
  --dry-run             Print SQL to stdout, don't write

Other commands (ingest, mcp, serve, install-hooks, audit, capture, promote)
ship in later sub-projects. See https://metaobjects.com for docs.
`;

/** Focused per-subcommand usage slices shown by `<cmd> --help`. */
const COMMAND_HELP: Record<string, string> = {
  gen: `meta gen — codegen TS targets from metaobjects/ entities

USAGE:
  meta gen [<entity>...] [flags]

FLAGS:
  --dry-run             Compute and print, don't write
  --no-antipatterns     Suppress the advisory "hand-rolled what MetaObjects can model" pass
  <entity> [<entity>]   Positional filter on entity names
  --help, -h            Print this help

A real write run (not --dry-run) also runs an ADVISORY anti-pattern pass: it scans
your authored source for hand-rolled aggregates, money-as-float, and CHECK-IN enums
and points you at the construct that models them (origin.aggregate / field.currency /
field.enum). Warnings only — it never fails the build. Opt out with --no-antipatterns
or META_NO_ANTIPATTERNS=1.

NOTE: outDir, dialect, dbImport, extStyle are read from metaobjects.config.ts
`,
  verify: `meta verify — drift gate (templates / DB schema / codegen)

USAGE:
  meta verify [flags]

FLAGS:
  --templates           Template/prompt {{field}}↔payload drift (default when bare)
  --codegen             Codegen drift — regenerate to temp dir and diff committed output
                        Needs metaobjects.config.ts; exit 2 if absent.
  --db <url>            Schema drift — live DB URL enables the schema-drift gate.
                        Supports: file:, libsql:, postgres:, postgresql:
                        D1 has no URL — use --dialect d1 / --d1 <binding> instead.
  --prompts <dir>       Directory of provider-resolved template text (default: prompts)
  --dialect sqlite|postgres|d1   Optional override (auto-detected from --db URL scheme)
  --allow <csv>         Accepted for parity with 'migrate'; does NOT affect the drift gate
  --skip-schema         Skip the schema-drift gate even when --db is present
  --d1 <binding>        D1 binding name from wrangler.toml (only with --dialect d1)
  --remote              Target remote D1 instead of local (only with --dialect d1) —
                        the ONLY way to verify the actual deployed D1 database
  --no-antipatterns     Suppress the advisory "hand-rolled what MetaObjects can model" pass
  --help, -h            Print this help

A bare 'meta verify' also runs an ADVISORY anti-pattern pass: it scans your authored
source for hand-rolled aggregates, money-as-float, and CHECK-IN enums and points you
at the construct that models them (origin.aggregate / field.currency / field.enum).
Warnings only — it never fails the build. Opt out with --no-antipatterns or
META_NO_ANTIPATTERNS=1.
`,
  export: `meta export — flatten loaded metadata to one canonical JSON artifact

USAGE:
  meta export [flags]

FLAGS:
  --out <file>          Write output to a file (default: stdout)
  --help, -h            Print this help
`,
  docs: `meta docs — generate neutral metadata documentation (entity + template pages)

USAGE:
  meta docs [<metadata>] [flags]

FLAGS:
  <metadata>            Project root holding metaobjects/ (default: current directory)
  --out <dir>, -o       Output directory for the pages (default: ./docs)
  --model               Emit the markdown model surface (entity + template pages)
  --api                 Emit the markdown api surface (generated SDK reference)
  --metamodel           Document the built-in metamodel vocabulary (no metadata needed)
  --site                Generate the browsable HTML documentation site (<out>/site/)
  --scaffold-site       Copy the site's templates + assets into codegen/docs-site/ to own (theme) them
  --templates <dir>     Project root to resolve adopter templates/ overrides (default: <metadata>)
  --prompts <dir>       Extra dir holding prompt .mustache sources (for --site) when they
                        live outside metaobjects/ or templates/ (e.g. data/templates/)
  --help, -h            Print this help
`,
  init: `meta init — scaffold metaobjects/ + .metaobjects/ in the current repo

USAGE:
  meta init [flags]

FLAGS:
  --refresh-docs        Refresh .metaobjects/AGENTS.md + CLAUDE.md after CLI upgrades
  --force               Overwrite existing files
  --quiet               Suppress output
  --print-only          Print what would be written, don't write
  --d1                  Include D1 (Cloudflare) migration config
  --no-wire-root        Skip wiring root metaobjects.config.ts
  --help, -h            Print this help
`,
  "agent-docs": `meta agent-docs — scaffold the agent-context (.metaobjects/ always-on files + .claude/skills/)

USAGE:
  meta agent-docs [--server <lang>]... [--client <fw>]... [--out <dir>] [flags]

FLAGS:
  --server <lang>       Server language (repeatable; e.g. csharp, kotlin, python, node)
  --client <fw>         Client framework (repeatable; e.g. react, vue)
  --out <dir>           Output directory (default: current directory)
  --no-skills           Skip .claude/skills/ scaffold
  --no-wire-root        Skip wiring root CLAUDE.md @import
  --help, -h            Print this help

NOTE: This is the canonical scaffolder for all language ports. Non-Node CLIs redirect here.
`,
  "prompt-snapshot": `meta prompt-snapshot — snapshot rendered template.* output

USAGE:
  meta prompt-snapshot [flags]

FLAGS:
  --check               Compare against committed snapshots; exit 1 on drift (CI gate)
  --prompts <dir>       Directory of provider-resolved template text (default: prompts)
  --help, -h            Print this help
`,
};

export async function run(argv: string[]): Promise<number> {
  // Extract the global --cwd / -C and --format flags (anywhere in argv).
  // A relative --cwd path resolves against the real process.cwd().
  // Absent --cwd → process.cwd(). Absent --format → TTY-aware default.
  let cwd = process.cwd();
  let formatFlag: string | undefined;
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
    if (a === "--format") {
      formatFlag = argv[i + 1];
      i++; // consume the value
      continue;
    }
    if (a.startsWith("--format=")) {
      formatFlag = a.slice("--format=".length);
      continue;
    }
    cleaned.push(a);
  }

  // An explicit but unrecognized --format is a usage error (exit 2) — mirrors the
  // --cwd missing-value handling above. Absent --format keeps the TTY-aware default.
  if (formatFlag !== undefined && !isValidFormat(formatFlag)) {
    log.error(`--format must be one of: ${VALID_FORMATS.join(", ")} (got '${formatFlag}')`);
    return 2;
  }
  const fmt = resolveFormat(formatFlag, process.stdout.isTTY ?? false);

  const [cmd, ...rest] = cleaned;

  // Intercept per-subcommand --help / -h before dispatching (mirrors migrate's own pattern).
  if (cmd !== undefined && cmd !== "--help" && cmd !== "-h" && cmd !== "--version" && cmd !== "-v") {
    if (rest.includes("--help") || rest.includes("-h")) {
      const helpText = COMMAND_HELP[cmd];
      if (helpText !== undefined) {
        log.info(helpText);
        return 0;
      }
      // Unknown command with --help → fall through to the default: branch below.
    }
  }

  switch (cmd) {
    case undefined: {
      // Content-first no-args view: concise status + next-step help[] rather than
      // dumping the full manual (full manual is still available via `meta --help`).
      const metaobjectsExists = await import("node:fs/promises")
        .then(({ stat }) => stat(resolve(cwd, "metaobjects")).then(() => true).catch(() => false));
      const statusLine = metaobjectsExists
        ? `meta — MetaObjects CLI (v${VERSION})  ·  metaobjects/ found`
        : `meta — MetaObjects CLI (v${VERSION})  ·  no metaobjects/ here`;
      const nextSteps = metaobjectsExists
        ? [
            "  meta gen              Run codegen",
            "  meta verify           Check for drift",
            "  meta migrate          Diff vs DB and emit SQL",
            "  meta --help           Full command reference",
          ]
        : [
            "  meta init             Scaffold metaobjects/ in this directory",
            "  meta --help           Full command reference",
          ];
      log.info(`${statusLine}\n\n${nextSteps.join("\n")}\n`);
      return 0;
    }
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
    case "agent-docs": {
      const { parseAgentDocsArgs } = await import("./lib/args.js");
      const { init } = await import("./commands/init.js");
      let flags;
      try {
        flags = parseAgentDocsArgs(rest);
      } catch (err) {
        log.error((err as Error).message);
        return 2;
      }
      const targetCwd = flags.out !== undefined ? resolve(cwd, flags.out) : cwd;
      try {
        const result = await init({
          cwd: targetCwd,
          servers: flags.servers,
          clients: flags.clients,
          noSkills: flags.noSkills,
          wireRoot: flags.wireRoot,
          docsOnly: true,
        });
        log.info(`Scaffolded the MetaObjects agent context (${result.created.length} files): .metaobjects/AGENTS.md + .claude/skills/metaobjects-*.`);
        for (const w of result.warnings) log.info(`  ${w}`);
        log.info("Re-run agent-docs to update; --no-wire-root to skip the root CLAUDE.md @import.");
        return 0;
      } catch (err) {
        log.error((err as Error).message);
        return 1;
      }
    }
    case "gen": {
      const { genCommand } = await import("./commands/gen.js");
      return genCommand(rest, cwd, fmt);
    }
    case "export": {
      const { exportCommand } = await import("./commands/export.js");
      return exportCommand(rest, cwd);
    }
    case "types": {
      const { typesCommand } = await import("./commands/types.js");
      return typesCommand(rest);
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
      return migrateCommand(rest, cwd, undefined, fmt);
    }
    default:
      log.error(`Unknown command: ${cmd}. Run \`meta --help\` for available commands.`);
      return 2;
  }
}
