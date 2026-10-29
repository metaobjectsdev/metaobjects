import { resolve } from "node:path";
import { log } from "./lib/log.js";
import { cliVersion, isVersionFlag } from "./lib/version.js";
import { resolveFormat, isValidFormat, VALID_FORMATS, type OutputFormat } from "./lib/format.js";
import { resolveCollection } from "@metaobjectsdev/sdk";
import { GENERATOR_HELP } from "./commands/generator-help.js";
import { describeError } from "./lib/error-text.js";
export { defineConfig } from "@metaobjectsdev/codegen-ts";
export type { MetaobjectsGenConfig } from "@metaobjectsdev/codegen-ts";

const VERSION = cliVersion();

/**
 * The commands that actually honor the global `--format`. Everything else prints
 * text whatever is passed.
 *
 * This list exists because the flag was advertised globally and threaded to two
 * commands: `meta verify --format json` parsed, validated, exited 0 and printed
 * human text. It is named ONCE and used by both the warning below and the help
 * text above, so the two cannot drift apart.
 */
const FORMAT_AWARE_COMMANDS: readonly string[] = ["gen", "verify", "migrate", "types", "deps", "eject"];

const HELP_TEXT = `meta — MetaObjects CLI (v${VERSION})

USAGE:
  meta <command> [flags]

COMMANDS:
  init                  Scaffold a MetaObjects project in the current repo
  init --refresh-docs   Refresh .metaobjects/AGENTS.md + CLAUDE.md after CLI upgrades
  init --with-docs      Scaffold with documentation wired (docsFile(), apiDocsFile()) so the first \`meta gen\` writes it
  init --config-only    Write only .metaobjects/config.json — for a Maven- or pip-rooted project
  agent-docs            Scaffold only the agent-context (.metaobjects/ + .claude/skills/) — canonical redirect target for all language ports
  gen [<entity>...]     Codegen TS targets from your declared metadata
  generator new <name>  Write a generator of your own into codegen/generators/ and wire it — the
                        way to get any output MetaObjects does not ship (OpenAPI, JSON Schema, …)
  eject <generator>     Copy a reference generator into codegen/generators/ to own it (any time after init)
  eject --list          List every ejectable generator name, grouped by package
  eject --undo          Remove owned generator copies that are the shipped reference
  deps sync [<name>...] Resolve declared dependencies (path, npm, python): sync the committed
                        snapshot + sha256 lock (.metaobjects/deps/, .metaobjects/deps.lock.json)
  deps list             One line per locked dependency: name, version, hash, node/package summary
  types [query]         Search the metadata vocabulary (types, subtypes, @attrs) by name or description
  export                Flatten loaded metadata to one canonical JSON artifact
  fmt [<file>...]       Rewrite metadata files into canonical form; --check lists drift, exits non-zero
  verify                Drift gate — subverbs: --templates / --db / --codegen / --deps (bare = --codegen --templates)
  upgrade               Rewrite retired metadata vocabulary (previews; --apply writes)
  prompt-snapshot       Snapshot rendered template.* output; --check gates drift
  migrate               Diff metadata vs live DB; emit migration SQL files
  --version, -v, -V     Print version
  --help, -h            Print this help

GLOBAL OPTIONS:
  --cwd <path>, -C <path>   Run as if launched from <path> (default: current directory)
  --format <toon|json|text> Output format (default: toon on non-TTY, text on TTY).
                            Honored by ${FORMAT_AWARE_COMMANDS.join(", ")}; every other
                            command prints text and says so if you pass it.
                            \`types\` is the one exception to the default: it prints TEXT
                            unless you ask for a format, on a TTY or not, because its
                            text output is already the terse agent-facing rendering.
                            A structured payload is never truncated — --limit is a
                            TEXT-only display cap.

GEN FLAGS:
  --dry-run             Compute and print, don't write
  --list                Print the generator CATALOG (name, layer, tier, what it emits,
                        what to install) and exit. Codegen is opt-in: nothing runs until
                        you wire it, and this is where you choose. No config or metadata
                        required — add --format json for the same catalog, machine-readable.
  --probe               With --list: construct every catalog generator and dry-run it
                        against YOUR model, reporting how many files each would emit.
                        A count per generator beats any category label — and it
                        cannot go stale, because it runs the generators. Needs a project.
  --baseline <default|adopt|fresh>
                        First-time-on-existing-file behavior. Default: refuse a file that
                        cannot be proved to be generated output. "adopt" records the files
                        you have as the merge base and writes NOTHING — the first run a
                        project with no committed .hashes.json can perform. "fresh"
                        overwrites them with fresh output and re-baselines (discards edits).
  --no-antipatterns     Suppress the advisory "hand-rolled what MetaObjects can model" pass
  --limit <n|all>       How many advisory lines TEXT output prints before it truncates
                        (default 20). Never applies to --format toon/json, which
                        carry every finding.
  --generators <names>  Narrow the run to these DECLARED generators, by stable name, comma-
                        separated (e.g. docs,api-docs to write only the documentation). A
                        name metaobjects.config.ts does not declare is refused: it never adds one.
  <entity> [<entity>]   Positional filter on entity names
  (outDir, dialect, dbImport, extStyle are read from metaobjects.config.ts. Every generator,
  documentation included, is an entry in its \`generators\`; nothing else is generated.)

EXPORT FLAGS:
  --out <file>          Write output to a file (default: stdout)

FMT FLAGS:
  [<file>...]           Optional explicit file(s) to format — must be members of this
                        project's resolved metadata sources (resolveCollection()); omit
                        to format every one of them.
  --check               List files that are not canonical and exit non-zero; changes nothing.
                        A file whose formatting would change the LOADED MODEL's meaning
                        is never rewritten — reported as an error instead (safety check).
                        A YAML file is always reported as skipped: no canonical YAML
                        emitter exists yet (ADR-0006 — JSON is the canonical interchange
                        form). A file declaring 'overlay: true' anywhere — whether or not
                        a same-file base exists to merge into — is skipped too: a
                        formatter never changes structure, and buildTree's ordinary
                        find-or-reuse behavior would otherwise silently fold a same-file
                        base + overlay into one node, dropping the overlay marker.

VERIFY FLAGS (ADR-0021 D2 — explicit subverbs; combine any; exit 1 on ANY drift):
  --templates           Template/prompt {{field}}↔payload drift (the bare-verify default)
  --codegen             Codegen drift — regenerate to a temp dir and diff the committed
                        output (config outDir/targets), documentation included.
                        Needs metaobjects.config.ts; exit 2 if absent.
  --deps                Dependency drift — re-resolve each declared dependency and compare
                        its installed artifact's hash against .metaobjects/deps.lock.json
                        (the same check 'meta deps check' runs). Never part of the bare-verify
                        default — it needs the publisher reachable, which CI may not have.
  --db <url>            Schema drift — live DB URL enables the schema-drift gate.
                        Supports: file:, libsql:, postgres:, postgresql:. Omit to skip.
                        D1 has no URL — use --dialect d1 / --d1 <binding> instead.
  --shadow-db <url>     Postgres: a scratch database to apply the expected schema to, so CHECKs,
                        index expressions and defaults are compared in Postgres's own spelling.
                        Default: CREATE DATABASE on the --db server (dropped afterwards), else the
                        temp-object probe on the target. Also SHADOW_DATABASE_URL or
                        migrate.shadowDatabaseUrl in .metaobjects/config.json.
  --prompts <dir>       Directory of provider-resolved template text (default: prompts)
  --dialect sqlite|postgres|d1   Optional override (auto-detected from --db URL scheme)
  --allow <csv>         Accepted for parity with 'migrate'; does NOT affect the
                        verify drift gate (the gate fails on ANY detected change)
  --skip-schema         Skip the schema-drift gate even when --db is present
  --migration-format default|flyway
                        Migration file layout (default: default), as for 'meta migrate'.
                        Under 'flyway' the schema-drift gate leaves flyway_schema_history
                        out of the comparison, because Flyway owns it. Also settable
                        once as migrate.format in .metaobjects/config.json.
  --d1 <binding>        D1 binding name from wrangler.toml (only with --dialect d1)
  --remote              Target remote D1 instead of local (only with --dialect d1) —
                        the ONLY way to verify the actual deployed D1 database
  --no-antipatterns     Suppress the advisory "you hand-rolled what MetaObjects can
                        model" pass (aggregate/currency/enum hints; warnings only)
  --no-requirement-lint Suppress the advisory requirement AUTHORING lint (not the gate)
  --require-implementers
                        Fail (exit 1) when a live functional requirement has nothing
                        implementing it. That finding is a warning without this flag;
                        with it, the same WARN_REQUIREMENT_NOTHING_IMPLEMENTS code is
                        reported as an error. Also: META_REQUIRE_IMPLEMENTERS=1.
  --no-overlay-lint     Suppress the advisory overlay-redeclaration AUTHORING lint
                        (never a gate — this lint can't fail the build)
  --no-name-lint        Suppress the advisory node-name AUTHORING lint (whitespace
                        in a name; never a gate — this lint can't fail the build)
  --no-deprecation-lint Suppress the advisory deprecated-reference AUTHORING lint
                        (never a gate — this lint can't fail the build)
  --no-field-lint       Suppress the advisory field AUTHORING lint (a reference
                        identity over a missing field; a duplicate field name —
                        never a gate; this lint can't fail the build)
  --limit <n|all>       How many advisory lines TEXT output prints per section before
                        it truncates (default 20). Never applies to --format
                        toon/json, which carry every finding and every diagnostic.

PROMPT-SNAPSHOT FLAGS:
  --check               Compare against committed snapshots; exit 1 on drift (CI gate)
  --prompts <dir>       Directory of provider-resolved template text (default: prompts)

MIGRATE FLAGS:
  --db <url>            DB connection URL (required, or set DATABASE_URL or config)
                        Supports: file:, libsql:, postgres:, postgresql:
                        D1 has no URL — use --dialect d1 / --d1 <binding> instead.
  --shadow-db <url>     Postgres: a scratch database to apply the expected schema to, so CHECKs,
                        index expressions and defaults are compared in Postgres's own spelling.
                        Default: CREATE DATABASE on the --db server (dropped afterwards), else the
                        temp-object probe on the target. Also SHADOW_DATABASE_URL or
                        migrate.shadowDatabaseUrl in .metaobjects/config.json.
  --dialect sqlite|postgres|d1   Optional override (auto-detected from URL scheme)
  --out-dir <path>      Migration directory (default: ./.metaobjects/migrations)
  --slug <name>         Required when changes are present (e.g., add-user-shipping)
  --allow <csv>         Comma-separated destructive-change permissions:
                        drop-column,drop-table,type-change,drop-index,drop-fk,
                        drop-check,drop-view,drop-view-cascade,
                        adopt-view,nullable-to-not-null,drop-identity-default,
                        drop-comment
                        drop-column DELETES the column's data; for a renamed
                        column use --rename-column, which keeps it
  --on-ambiguous abort|rename|drop-add   Default abort
  --rename-table [schema.]old=new         Declare a table rename (repeatable)
  --rename-column [schema.]table.old=new  Declare a column rename; keeps its data (repeatable)
  --d1 <binding>        D1 binding name from wrangler.toml (only with --dialect d1)
  --remote              Target remote D1 instead of local (only with --dialect d1)
  --apply               Run 'wrangler d1 migrations apply' after writing files
  --yes                 Skip the --remote --apply confirmation pause
  --dry-run             Print the SQL, don't write (json/toon: in the document's sql field)

See https://metaobjects.dev for docs.
`;

/** Focused per-subcommand usage slices shown by `<cmd> --help`. */
export const COMMAND_HELP: Record<string, string> = {
  generator: GENERATOR_HELP,
  gen: `meta gen — codegen TS targets from your declared metadata

USAGE:
  meta gen [<entity>...] [flags]

FLAGS:
  --dry-run             Compute and print, don't write
  --list                Print the generator CATALOG (name, layer, tier, what it emits,
                        what to install) and exit. Codegen is opt-in: nothing runs until
                        you wire it, and this is where you choose. No config or metadata
                        required — add --format json for the same catalog, machine-readable.
  --probe               With --list: construct every catalog generator and dry-run it
                        against YOUR model, reporting how many files each would emit.
                        A count per generator beats any category label — and it cannot go
                        stale, because it runs the generators. Needs a project.
  --baseline <default|adopt|fresh>
                        First-time-on-existing-file behavior. Default: refuse a file that
                        cannot be proved to be generated output. "adopt" records the files
                        you have as the merge base and writes NOTHING — the first run a
                        project with no committed .hashes.json can perform. "fresh"
                        overwrites them with fresh output and re-baselines (discards edits).
  --no-antipatterns     Suppress the advisory "hand-rolled what MetaObjects can model" pass
  --limit <n|all>       Advisory lines TEXT output prints before truncating (default 20)
  --generators <names>  Narrow the run to these DECLARED generators, by stable name, comma-
                        separated (e.g. docs,api-docs to write only the documentation). A
                        name metaobjects.config.ts does not declare is refused: it never adds one.
  --strict              Load the model strictly, as \`meta verify\` does (ADR-0023): an
                        unknown attribute (a typo'd \`@requird\`) is an error and nothing is
                        written, instead of a warning over output that silently changed.
  --format <toon|json|text>   Output format (global flag; default toon off-TTY)
  <entity> [<entity>]   Positional filter on entity names
  --help, -h            Print this help

A real write run (not --dry-run) also runs an ADVISORY anti-pattern pass: it scans
your authored source for hand-rolled aggregates, money-as-float, and CHECK-IN enums
and points you at the construct that models them (origin.aggregate / field.currency /
field.enum). Warnings only — it never fails the build. Opt out with --no-antipatterns
or META_NO_ANTIPATTERNS=1.

Text output caps that list at --limit lines (default 20) and says how many it held
back. --format toon / --format json carry EVERY finding in the payload's
antiPatterns block, uncapped — --limit is a display cap for a terminal, never a
limit on the machine-readable result.

NOTE: outDir, dialect, dbImport, extStyle are read from metaobjects.config.ts
`,
  eject: `meta eject — copy reference generators into your repo so you own them

USAGE:
  meta eject <name>...   Copy each generator into codegen/generators/<name>.ts
  meta eject --list      List every ejectable generator name, grouped by package
  meta eject --undo [<name>...]
                         Take back owned copies that are the shipped reference

Eject a generator to CHANGE what it emits. To run one as shipped, import its factory
from its package instead — \`meta gen --list\` prints the import line — and copy
nothing. Take several at once: the install set is CONSOLIDATED, so
\`meta eject form hooks grid\` prints one install line, not three. An unknown name
refuses the whole call and copies nothing.

FLAGS:
  --list                 List ejectable generators instead of copying one
  --force                Overwrite an already-ejected file (default: never clobber).
                         With --undo: remove a named copy even if you changed it
  --undo                 Remove owned generator copies that are the shipped reference,
                         unchanged: with no names every such copy, with names those. A
                         copy you changed is kept (with no names) or refused (named, unless
                         --force). Their copied renderers and adapter source go too when
                         no remaining copy uses them. It never edits metaobjects.config.ts:
                         it prints the import to swap back. \`meta gen\` says when copies
                         qualify. There is no \`meta doctor\`; \`--list\` is the report.
  --format <toon|json|text>   Output format (global flag). The structured form carries
                         each file's wire lines, the consolidated install set and the
                         config keys the ejected generators read.
  --help, -h             Print this help

\`meta init\` copies NO generators — codegen is opt-in, and codegen/generators/
starts empty on purpose. An ejected file is YOURS to edit (ADR-0034
scaffold-and-own), and \`meta gen\` runs your copy, not the package's. Eject prints
the import line to swap in for the package one and the entry to add in
metaobjects.config.ts, and never overwrites a file you already own without --force.

Find names with \`meta gen --list\` — add --probe to see how many files each would
emit for your model.
`,
  deps: `meta deps — sync a declared metadata dependency's committed snapshot

USAGE:
  meta deps sync [<name>...]   Resolve each declared dependency (path, npm or python
                                transport), validate its manifest + artifact, copy it into .metaobjects/deps/<name>/,
                                and pin it in .metaobjects/deps.lock.json. Naming one or more
                                <name>s syncs only those; bare 'sync' syncs everything
                                declared. A dependency removed from config is PRUNED from
                                the lock and its snapshot dir deleted, every run.
  meta deps list                One line per locked dependency: name, version, hash8,
                                node count, packages.
  meta deps check                Re-resolve each declared dependency (any transport, same
                                as sync steps 1-2) and compare its INSTALLED artifact's hash
                                against .metaobjects/deps.lock.json. Read-only — never
                                touches the lock or the snapshot. Exits 1 if any dependency
                                has drifted or cannot be resolved (ERR_DEPENDENCY_UPSTREAM_DRIFT).

FLAGS:
  --dry-run              Plan and report; write nothing (sync only)
  --format <toon|json|text>   Output format (global flag; default toon off-TTY)
  --help, -h              Print this help

Transports: "path" is a directory relative to the config's directory; "npm" is an installed
npm package, resolved from the config's directory the way Node resolves it; "python" is an
installed Python package, found with importlib.util.find_spec by the project's interpreter
($METAOBJECTS_PYTHON, else $VIRTUAL_ENV, else ./.venv, else python3 — the interpreter used is
printed). "dir" names the shared-model directory inside an npm or python package (default:
the package root). Install the package with your package manager first; sync copies its
shared model into the committed snapshot, so nothing else needs it installed.

The lock is the ONLY thing 'meta deps sync' writes to besides the snapshot directory —
sync never touches your own metadata files. 'meta deps check' compares the lock against
what is installed right now (the same check 'meta verify --deps' runs); 'meta deps sync'
only ever compares against what config DECLARES.
`,
  verify: `meta verify — drift gate (templates / DB schema / codegen / migration replay)

USAGE:
  meta verify [flags]

FLAGS:
  --templates           Template/prompt {{field}}↔payload drift (default when bare)
  --codegen             Codegen drift — is the GENERATED contribution current? A hand
                        edit 'meta gen' preserves is not drift; a stale generated part is.
                        An <Entity>.names.ts artifact is the exception: it must match a
                        fresh regen exactly — a hand edit in it is itself the defect.
                        Needs metaobjects.config.ts; exit 2 if absent.
                        Every generated file that carries a hand edit is still LISTED
                        (a notice, exit code unchanged), so an edit is never invisible.
  --forbid-hand-edits   With --codegen: fail (exit 1) on ANY hand edit inside generated
                        code, for teams that want generated files untouchable.
  --docs                Removed in 1.1.0: says so and exits 2. --codegen checks documentation
                        with everything else \`generators\` declares.
  --deps                Dependency drift — re-resolve each declared dependency exactly as
                        'meta deps check' does and compare its installed artifact's hash
                        against .metaobjects/deps.lock.json. Exits 1 if any dependency has
                        drifted or cannot be resolved (ERR_DEPENDENCY_UPSTREAM_DRIFT). NEVER
                        part of the bare-verify default — it needs the publisher reachable,
                        which CI may not have.
  --db <url>            Schema drift — live DB URL enables the schema-drift gate.
                        Supports: file:, libsql:, postgres:, postgresql:
                        D1 has no URL — use --dialect d1 / --d1 <binding> instead.
  --shadow-db <url>     Postgres: a scratch database to apply the expected schema to, so CHECKs,
                        index expressions and defaults are compared in Postgres's own spelling.
                        Default: CREATE DATABASE on the --db server (dropped afterwards), else the
                        temp-object probe on the target. Also SHADOW_DATABASE_URL or
                        migrate.shadowDatabaseUrl in .metaobjects/config.json.
  --replay              Migration-chain drift — replay the committed chain into an
                        EMPTY throwaway database and assert it applies. Needs no --db:
                        the engine is in-process (PGlite for postgres, a temp file for
                        sqlite) and provisions nothing. Dialect comes from --dialect,
                        else migrate.dialect. flyway and d1 are refused.
                        Postgres needs the optional peer '@electric-sql/pglite'.
  --replay-snapshot     ...and assert the replayed schema EQUALS the committed
                        snapshot — catches a hand-edited up.sql that still applies but
                        no longer builds the recorded schema. Does NOT apply to a
                        project adopted with 'migrate baseline --from-db' (its chain
                        does not build the schema); use --replay there.
  --prompts <dir>       Directory of provider-resolved template text (default: prompts)
  --dialect sqlite|postgres|d1   Optional override (auto-detected from --db URL scheme)
  --allow <csv>         Accepted for parity with 'migrate'; does NOT affect the drift gate
  --skip-schema         Skip the schema-drift gate even when --db is present
  --migration-format default|flyway
                        Migration file layout (default: default), as for 'meta migrate'.
                        Under 'flyway' the schema-drift gate leaves flyway_schema_history
                        out of the comparison, because Flyway owns it. Also settable
                        once as migrate.format in .metaobjects/config.json.
  --d1 <binding>        D1 binding name from wrangler.toml (only with --dialect d1)
  --remote              Target remote D1 instead of local (only with --dialect d1) —
                        the ONLY way to verify the actual deployed D1 database
  --lax                 Load with the legacy OPEN attribute set instead of strict
                        (ADR-0023). Strict is the default: an undeclared or typo'd own
                        @attr fails verify with ERR_UNKNOWN_ATTR. Use only while
                        migrating a model onto a registered provider.
  --no-antipatterns     Suppress the advisory "hand-rolled what MetaObjects can model" pass
  --no-requirement-lint Suppress the advisory requirement AUTHORING lint (not the gate)
  --require-implementers
                        Fail (exit 1) when a live functional requirement has nothing
                        implementing it. That finding is a warning without this flag;
                        with it, the same WARN_REQUIREMENT_NOTHING_IMPLEMENTS code is
                        reported as an error. Also: META_REQUIRE_IMPLEMENTERS=1.
  --no-overlay-lint     Suppress the advisory overlay-redeclaration AUTHORING lint —
                        never a gate; this lint can't fail the build
  --no-name-lint        Suppress the advisory node-name AUTHORING lint (whitespace in
                        a name) — never a gate; this lint can't fail the build
  --no-deprecation-lint Suppress the advisory deprecated-reference AUTHORING lint —
                        never a gate; this lint can't fail the build
  --no-field-lint       Suppress the advisory field AUTHORING lint (a reference
                        identity over a missing field; a duplicate field name) —
                        never a gate; this lint can't fail the build
  --limit <n|all>       Advisory lines TEXT output prints PER SECTION before truncating
                        (default 20; per-section so the authoring lint can never push
                        the gate's own warnings off the end)
  --format <toon|json|text>   Output format (global flag; default toon off-TTY).
                        Emits one machine-readable document on stdout — every gate's
                        verdict, every advisory finding, every requirement diagnostic,
                        UNCAPPED — and moves narration to stderr so the payload parses.
                        What it does NOT carry is listed in its own notRepresented[].
  --help, -h            Print this help

A bare 'meta verify' also runs an ADVISORY anti-pattern pass: it scans your authored
source for hand-rolled aggregates, money-as-float, and CHECK-IN enums and points you
at the construct that models them (origin.aggregate / field.currency / field.enum).
The same pass names every foreign key with no index on its referencing column(s)
and the index.lookup that would cover it (migrate never adds one on its own).
Warnings only — it never fails the build. Opt out with --no-antipatterns or
META_NO_ANTIPATTERNS=1.

If the project declares requirement.* nodes, verify also prints an ADVISORY authoring
lint in its own section: names that are not addressable, prose slots holding one
sentence twice, content written where no surface reads it. Warnings only — it can
never fail the build. Opt out with --no-requirement-lint or META_NO_REQUIREMENT_LINT=1.
The requirements GATE itself (dangling refs, link floor, levels) always runs.
One of its findings is a warning you can raise: a live functional requirement that
nothing implements fails the build under --require-implementers or
META_REQUIRE_IMPLEMENTERS=1. The diagnostic keeps its code; only its severity moves.

verify also prints an ADVISORY overlay authoring lint, in its own section: a
top-level declaration redeclared in two or more files where more than one
redeclaration lacks 'overlay: true' — today's default merge rule reuses it
silently, but the same unflagged redeclaration silently becomes a NEW object
the day the target is renamed or removed upstream. Warnings only — it can
never fail the build. Opt out with --no-overlay-lint or META_NO_OVERLAY_LINT=1.

verify also prints an ADVISORY node-name authoring lint, in its own section: any
node (object, field, identity, relationship, ...) whose name contains whitespace.
Leading or trailing whitespace is almost certainly a copy-paste accident — rename
the node, and pin @column on a field whose physical column must keep its name.
Requirement names are left to the requirement lint above. Warnings only — it can
never fail the build. Opt out with --no-name-lint or META_NO_NAME_LINT=1.

verify also prints an ADVISORY deprecated-reference authoring lint, in its own
section: any node that depends on a node carrying the documentation @deprecated
attr, via extends, @objectRef, @references, or an origin's @from/@of/@via. Where
the deprecated node also carries @replacedBy, the finding names the replacement.
A node referencing itself (a recursive FK, a same-entity passthrough) is not a
finding. Warnings only — it can never fail the build. Opt out with
--no-deprecation-lint or META_NO_DEPRECATION_LINT=1.

verify also prints an ADVISORY field authoring lint, in its own section. It reports
an identity.reference whose @fields names a field the object does not have
(inherited and overlaid fields count as present), and a field name declared more
than once in one object's children list. Both load with no error. Warnings only —
it can never fail the build. Opt out with --no-field-lint or META_NO_FIELD_LINT=1.
`,
  export: `meta export — flatten loaded metadata to one canonical JSON artifact

USAGE:
  meta export [flags]

FLAGS:
  --out <file>          Write output to a file (default: stdout)
  --help, -h            Print this help
`,
  fmt: `meta fmt — rewrite metadata files into canonical form

USAGE:
  meta fmt [<file>...] [flags]

Formats every JSON metadata file this project's resolved sources contain
(resolveCollection() — never a hardcoded default directory), or just the
files named. Each file is formatted as its OWN content (own-mode,
declared-here layer only) — never inlining an inherited member or another
file's overlay.

FLAGS:
  [<file>...]           Optional explicit file(s) — must be members of this project's
                        resolved metadata sources; omit to format every one of them.
  --check               List files that are not canonical and exit non-zero; changes
                        nothing on disk.
  --help, -h            Print this help

SAFETY: before writing any file, fmt reloads the whole project with that file's
candidate content swapped in and requires the loaded model's canonical form to
be byte-identical to the untouched baseline. A file that fails this check is
left exactly as it was and reported as an error — fmt never changes meaning.

YAML: left untouched and reported as skipped — no canonical YAML emitter
exists yet (ADR-0006: JSON is the canonical interchange form; YAML is an
authoring format).

OVERLAY: a file declaring 'overlay: true' ANYWHERE in its tree is reported as
skipped — not only when no base exists in the same file. A formatter never
changes structure: even when a same-file base IS present, merging it with
the overlay (what the ordinary loader would do) would drop the overlay
marker from the output, so fmt refuses that too and leaves the file as-is.
`,
  init: `meta init — scaffold a MetaObjects project in the current repo

USAGE:
  meta init [flags]

FLAGS:
  --refresh-docs        Refresh .metaobjects/AGENTS.md + CLAUDE.md after CLI upgrades
  --docs-only           Write only the agent-context files — no metadata sources, no
                        codegen scaffold, no config. Pair with --refresh-docs to update
                        an existing project after upgrading.
  --server <lang>       Declare a server language for the agent context (repeatable):
                        typescript | java | kotlin | csharp | python
                        ('node' is accepted as an alias for typescript; an unknown
                        value is refused, never dropped)
  --client <fw>         Declare a client framework for the agent context (repeatable):
                        react | tanstack | angular
  --no-skills           Skip the .claude/skills/ scaffold
  --force               Overwrite existing files
  --quiet               Suppress output
  --print-only          Print what would be written, don't write
  --d1                  Include D1 (Cloudflare) migration config
  --no-wire-root        Skip wiring root metaobjects.config.ts
  --config-only         Write only .metaobjects/config.json (no TS scaffold) — declares
                        metadata sources for the Node CLI from a Maven- or pip-rooted project
  --with-docs           Wire docsFile() and apiDocsFile() and a docs target in the scaffolded
                        config, so the first \`meta gen\` writes documentation
  --help, -h            Print this help
`,
  "agent-docs": `meta agent-docs — scaffold the agent-context (.metaobjects/ always-on files + .claude/skills/)

USAGE:
  meta agent-docs [--server <lang>]... [--client <fw>]... [--out <dir>] [flags]

FLAGS:
  --server <lang>       Server language (repeatable): typescript|java|kotlin|csharp|python
  --client <fw>         Client framework (repeatable): react|tanstack|angular
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
  // The flag as PASSED, before the TTY-aware default is applied. `meta types` takes this
  // rather than `fmt`: its default is text whether or not stdout is a terminal, so that a
  // pipe does not silently change what every existing scripted caller reads. See
  // commands/types.ts for the reasoning; `gen` sets the same default on its own parameter.
  const explicitFormat: OutputFormat | undefined =
    formatFlag !== undefined && isValidFormat(formatFlag) ? formatFlag : undefined;

  const [cmd, ...rest] = cleaned;

  // A bare `--json` / `--toon` / `--text` is the spelling an adopter reaches for
  // when they want structured output, and every command's `parseArgs` runs
  // `strict: true`, so today it dies as `Unknown option '--json'` — a message that
  // names the flag that failed and not the flag that works. It is REJECTED rather
  // than aliased, deliberately: `--format` is validated once, globally, for all
  // three values, while an alias would have to be added to every command's own
  // option table — the per-command scattering that let `--format` be honored by
  // two commands and silently ignored by the rest. One spelling, and a refusal
  // that names it. Exit 2, the same usage-error code the unknown option produced.
  const formatAlias = cleaned.find((a) => a === "--json" || a === "--toon" || a === "--text");
  if (formatAlias !== undefined) {
    log.error(
      `${formatAlias} is not a flag. Use \`--format ${formatAlias.slice(2)}\` — one global spelling for all three formats.`,
    );
    return 2;
  }

  // A `--format` a command does not honor is a no-op, and a silent no-op is the
  // defect this release is fixing one level down: the adopter who guessed the right
  // flag still lost, because nothing said the command ignores it. Say it.
  if (formatFlag !== undefined && cmd !== undefined && !FORMAT_AWARE_COMMANDS.includes(cmd)) {
    log.warn(
      `--format is honored by: ${FORMAT_AWARE_COMMANDS.join(", ")}. \`meta ${cmd}\` ignores it and prints text.`,
    );
  }

  // Intercept per-subcommand --help / -h before dispatching (mirrors migrate's own pattern).
  if (cmd !== undefined && cmd !== "--help" && cmd !== "-h" && !isVersionFlag(cmd)) {
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
      // "Is this a MetaObjects project?" routes through resolveCollection — the
      // single authority on where metadata lives — rather than assuming the
      // default `metaobjects/` directory name. The status line must not assert
      // it either: a project whose config points `sources` at
      // `../shared-model/metadata` would be told "metaobjects/ found", which is
      // false, and one that resolves nothing would be told there is no
      // `metaobjects/` here when the real problem may be a declared source that
      // failed to resolve.
      const metadataResolves = await resolveCollection(cwd).then(() => true).catch(() => false);
      const statusLine = metadataResolves
        ? `meta — MetaObjects CLI (v${VERSION})  ·  metadata found`
        : `meta — MetaObjects CLI (v${VERSION})  ·  no MetaObjects project here`;
      const nextSteps = metadataResolves
        ? [
            "  meta gen              Run codegen",
            "  meta verify           Check for drift",
            "  meta migrate          Diff vs DB and emit SQL",
            "  meta --help           Full command reference",
          ]
        : [
            "  meta init             Scaffold a MetaObjects project in this directory",
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
    case "-V":
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
        log.error(describeError(err));
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
        log.error(describeError(err));
        return 1;
      }
    }
    case "gen": {
      const { genCommand } = await import("./commands/gen.js");
      return genCommand(rest, cwd, fmt);
    }
    case "generator": {
      const { generatorCommand } = await import("./commands/generator.js");
      return generatorCommand(rest, cwd);
    }
    case "eject": {
      const { ejectCommand } = await import("./commands/eject.js");
      return ejectCommand(rest, cwd, fmt);
    }
    case "deps": {
      const { depsCommand } = await import("./commands/deps.js");
      return depsCommand(rest, cwd, fmt);
    }
    case "export": {
      const { exportCommand } = await import("./commands/export.js");
      return exportCommand(rest, cwd);
    }
    case "fmt": {
      const { fmtCommand } = await import("./commands/fmt.js");
      return fmtCommand(rest, cwd);
    }
    case "types": {
      const { typesCommand } = await import("./commands/types.js");
      return typesCommand(rest, explicitFormat);
    }
    case "docs": {
      const { docsCommand } = await import("./commands/docs.js");
      return docsCommand(rest, cwd);
    }
    case "verify": {
      const { verifyCommand } = await import("./commands/verify.js");
      return verifyCommand(rest, cwd, undefined, fmt);
    }
    case "upgrade": {
      const { upgradeCommand } = await import("./commands/upgrade.js");
      return upgradeCommand(rest, cwd);
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
