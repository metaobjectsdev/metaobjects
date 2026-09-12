import { parseArgs } from "node:util";
import { parseAdvisoryLimit } from "./advisory.js";

// ---------------------------------------------------------------------------
// init flags
// ---------------------------------------------------------------------------

export interface InitFlags {
  force: boolean;
  quiet: boolean;
  printOnly: boolean;
  refreshDocs: boolean;
  d1: boolean;
  servers: string[];
  clients: string[];
  noSkills: boolean;
  wireRoot: boolean;
  docsOnly: boolean;
  configOnly: boolean;
}

/** The flag table `parseInitArgs` parses. Exported so the help text can be gated against it. */
export const INIT_OPTIONS = {
  force: { type: "boolean", default: false },
  quiet: { type: "boolean", default: false },
  "print-only": { type: "boolean", default: false },
  "refresh-docs": { type: "boolean", default: false },
  d1: { type: "boolean", default: false },
  server: { type: "string", multiple: true },
  client: { type: "string", multiple: true },
  "no-skills": { type: "boolean", default: false },
  "no-wire-root": { type: "boolean", default: false },
  "docs-only": { type: "boolean", default: false },
  "config-only": { type: "boolean", default: false },
} as const;

export function parseInitArgs(argv: string[]): InitFlags {
  const { values } = parseArgs({
    args: argv,
    options: INIT_OPTIONS,
    strict: true,
    allowPositionals: false,
  });
  return {
    force: !!values.force,
    quiet: !!values.quiet,
    printOnly: !!values["print-only"],
    refreshDocs: !!values["refresh-docs"],
    d1: !!values.d1,
    servers: (values.server as string[] | undefined) ?? [],
    clients: (values.client as string[] | undefined) ?? [],
    noSkills: !!values["no-skills"],
    wireRoot: !values["no-wire-root"],
    docsOnly: !!values["docs-only"],
    configOnly: !!values["config-only"],
  };
}

// ---------------------------------------------------------------------------
// agent-docs flags — docs-only scaffold (always-on + skills), no metaobjects/ project
// ---------------------------------------------------------------------------

export interface AgentDocsFlags {
  servers: string[];
  clients: string[];
  out: string | undefined;
  noSkills: boolean;
  wireRoot: boolean;
}

/** The flag table `parseAgentDocsArgs` parses. Exported so the help text can be gated against it. */
export const AGENT_DOCS_OPTIONS = {
  server: { type: "string", multiple: true },
  client: { type: "string", multiple: true },
  out: { type: "string" },
  "no-skills": { type: "boolean", default: false },
  "no-wire-root": { type: "boolean", default: false },
} as const;

export function parseAgentDocsArgs(argv: string[]): AgentDocsFlags {
  const { values } = parseArgs({
    args: argv,
    options: AGENT_DOCS_OPTIONS,
    strict: true,
    allowPositionals: false,
  });
  return {
    servers: (values.server as string[] | undefined) ?? [],
    clients: (values.client as string[] | undefined) ?? [],
    out: values.out as string | undefined,
    noSkills: !!values["no-skills"],
    wireRoot: !values["no-wire-root"],
  };
}

// ---------------------------------------------------------------------------
// gen flags — minimal: metaobjects.config.ts holds outDir/dialect/dbImport/extStyle
// ---------------------------------------------------------------------------

export interface GenFlags {
  dryRun: boolean;
  entities: string[];
  /** First-time-on-existing-file behavior. Default: refuse a file that cannot be
   *  proved to be ours. "adopt" → record the file as the merge base and write
   *  nothing. "fresh" → overwrite from fresh output and re-baseline. */
  baseline: "default" | "fresh" | "adopt";
  /** ADR-0021 D3 — print the stable-name generator registry and exit without
   *  running codegen. */
  list: boolean;
  /** Suppress the advisory anti-pattern (verify-as-teacher) pass. */
  noAntipatterns: boolean;
  /**
   * How many advisory lines TEXT output prints before truncating
   * (`DEFAULT_ADVISORY_LIMIT`, or Infinity for `--limit all`). It never applies to
   * a structured payload, which carries every finding.
   */
  limit: number;
}

/** The flag table `parseGenArgs` parses. Exported so the help text can be gated against it. */
export const GEN_OPTIONS = {
  "dry-run": { type: "boolean", default: false },
  "baseline": { type: "string" },
  "list": { type: "boolean", default: false },
  "no-antipatterns": { type: "boolean", default: false },
  "limit": { type: "string" },
} as const;

export function parseGenArgs(argv: string[]): GenFlags {
  const { values, positionals } = parseArgs({
    args: argv,
    options: GEN_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
  const baselineRaw = values.baseline as string | undefined;
  if (
    baselineRaw !== undefined &&
    baselineRaw !== "default" &&
    baselineRaw !== "fresh" &&
    baselineRaw !== "adopt"
  ) {
    throw new Error(
      `invalid --baseline '${baselineRaw}'; expected 'default', 'adopt' or 'fresh'`,
    );
  }
  return {
    dryRun: !!values["dry-run"],
    entities: positionals,
    baseline: (baselineRaw as "default" | "fresh" | "adopt" | undefined) ?? "default",
    list: !!values.list,
    noAntipatterns: !!values["no-antipatterns"],
    // Throws on a bad value; the command layer reports it and exits 2, exactly as
    // it does for --baseline above.
    limit: parseAdvisoryLimit(values.limit as string | undefined),
  };
}

// ---------------------------------------------------------------------------
// export flags
// ---------------------------------------------------------------------------

export interface ExportFlags {
  out: string | undefined;
}

/** The flag table `parseExportArgs` parses. Exported so the help text can be gated against it. */
export const EXPORT_OPTIONS = {
  out: { type: "string" },
} as const;

export function parseExportArgs(argv: string[]): ExportFlags {
  const { values } = parseArgs({
    args: argv,
    options: EXPORT_OPTIONS,
    strict: true,
    allowPositionals: false,
  });
  return {
    out: values.out,
  };
}

// ---------------------------------------------------------------------------
// shared DB-connection vocab (used by both verify --db and migrate)
// ---------------------------------------------------------------------------

const DIALECTS = ["sqlite", "postgres", "d1"] as const;
type Dialect = (typeof DIALECTS)[number];

/**
 * #192 — migration output-format adapters. Orthogonal to dialect: a Flyway shop
 * is still on postgres or sqlite. "default" is the homegrown
 * `<ts>-<slug>/up.sql` layout; "flyway" is the `V<N>__`/`U<N>__` envelope.
 */
export const MIGRATE_FORMATS = ["default", "flyway"] as const;
export type MigrateFormat = (typeof MIGRATE_FORMATS)[number];

// Exported (not just module-local) so allow-tokens-pinned.test.ts can pin it
// against sdk's AllowTokenEnum (config.json's static migrate.allow validator)
// — the two lists drifted silently before that test existed: sdk's enum was
// missing 5 of these 11 tokens, so a token that worked fine on the CLI was
// REJECTED when set in .metaobjects/config.json.
export const ALLOW_TOKENS = [
  "drop-column",
  "drop-table",
  "type-change",
  "drop-index",
  "drop-fk",
  // drop-check gates CHECK evolution (an evolved `field.enum @values` is a
  // drop+add pair); drop-view gates a REAL view removal (the diff's internal
  // drop/create recreate pair around a column change is not gated).
  "drop-check",
  "drop-view",
  // drop-view-cascade is STRICTLY ADDITIONAL to drop-view: it permits
  // `DROP VIEW ... CASCADE`, which destroys every dependent object — including
  // views and materialized views owned by OTHER applications, which this tool
  // neither manages nor can restore. `--allow drop-view` alone never cascades.
  "drop-view-cascade",
  // adopt-view permits overwriting an existing view that carries no MetaObjects
  // fingerprint — i.e. taking ownership of a hand-written view, or of one created
  // before fingerprinting existed. Every environment upgrading from an older
  // toolchain needs this exactly once, to stamp its existing views.
  "adopt-view",
  "nullable-to-not-null",
  // drop-identity-default permits dropping a live Postgres auto-sequence
  // default (a legacy `serial`/`bigserial` PK's `nextval(...)`) when the
  // metadata declares no @generation at all — ambiguous between "never
  // declared it" and "deliberately removing auto-increment".
  "drop-identity-default",
  // drop-unmanaged permits dropping an object the COMMITTED SNAPSHOT never
  // contained — i.e. one this toolchain never managed, typically a table another
  // tool owns. Without it such a drop is refused at generation time, because the
  // migration it writes cannot replay against a database where that object never
  // existed (#313). Unlike its neighbours this one is enforced by `migrate` itself
  // rather than by `diff()`'s status pass; see AllowOptions.dropUnmanaged.
  "drop-unmanaged",
] as const;
type AllowToken = (typeof ALLOW_TOKENS)[number];

// ---------------------------------------------------------------------------
// verify flags
// ---------------------------------------------------------------------------

export interface VerifyFlags {
  /** Directory (relative to cwd) holding provider-resolved template text. */
  prompts: string | undefined;
  /** Live DB connection URL; when present, enables the schema-drift gate. */
  db: string | undefined;
  /** Optional dialect override (auto-detected from --db URL scheme otherwise). */
  dialect: Dialect | undefined;
  /** Destructive-change permissions; only affects how drift is described. */
  allow: AllowToken[];
  /** Skip the schema-drift gate even when --db is present. */
  skipSchema: boolean;
  /**
   * #225 — D1 binding name from wrangler.toml, spelled/documented the same way
   * `meta migrate --d1 <binding>` does. Gated on `--dialect d1` (D1 has no URL
   * connection, so it can't go through --db); optional disambiguator when
   * wrangler.toml declares more than one D1 binding.
   */
  d1: string | undefined;
  /** Target remote D1 instead of local (only meaningful with --dialect d1). */
  remote: boolean;
  // ADR-0021 D2 — explicit verify subverbs. Each selects one drift mode; any
  // combination may be passed and the exit code aggregates (non-zero on any
  // drift). The boolean flags record which modes were explicitly requested; the
  // command layer applies the bare-verify default (= --templates) when none are.
  /** Run the template/prompt {{field}}↔payload drift gate. */
  templates: boolean;
  /** Run the codegen-drift gate: is the GENERATED contribution of each file current? */
  codegen: boolean;
  /**
   * Run the docs-drift gate: regenerate the `meta docs` surfaces into a temp dir and diff
   * them against the committed docs tree.
   *
   * A SEPARATE subverb rather than part of `--codegen`, because they check different
   * trees under different ownership rules: `--codegen` regenerates `outDir`/`targets` and
   * must respect the hand edits `meta gen` preserves, while the docs tree has no merge,
   * no manifest, and lives in a directory the adopter chose (`./docs/generated` by
   * default) that may hold hand-written files it does not own. Folding them together
   * would have to pick one of those rules
   * for both.
   */
  docs: boolean;
  /**
   * Replay the committed migration chain into an empty throwaway database and assert
   * it applies (#313). Needs no `--db`: the engine is local and disposable (PGlite
   * for postgres, a temp sqlite file), so the gate provisions nothing.
   */
  replay: boolean;
  /**
   * `--replay` plus: assert the replayed schema EQUALS the committed snapshot. A
   * separate subverb rather than a `--strict` modifier, because `--lax` below is a
   * different axis (ADR-0023 attribute strictness) and `--strict` beside it would
   * read as that flag's opposite rather than as a replay depth.
   */
  replaySnapshot: boolean;
  /**
   * Dependency drift (Task 15, FR-023) — re-resolve each declared dependency and
   * compare its installed artifact's hash against `.metaobjects/deps.lock.json`
   * (the same comparison `meta deps check` runs). Deliberately NEVER part of the
   * bare-verify default, unlike --templates: it needs the publisher reachable,
   * which CI may not have. It is still counted in `anyExplicit`, same as
   * --codegen/--docs, so a lone `verify --deps` does not ALSO run the template
   * gate.
   */
  deps: boolean;
  /** Whether ANY explicit subverb flag (--templates/--db/--codegen/--docs/--deps/--replay*) was passed. */
  anyExplicit: boolean;
  /** Suppress the advisory anti-pattern (verify-as-teacher) pass. */
  noAntipatterns: boolean;
  /**
   * Suppress the advisory requirement AUTHORING lint — the second, prose-quality
   * section, never the gate above it. Its own findings argue that a noisy advisory
   * gets switched off wholesale, and a ledger mid-migration can print its capped
   * twenty lines on every run for weeks; a mute for the advisory half is what keeps
   * the half that CAN fail a build switched on. Same shape as --no-antipatterns.
   */
  noRequirementLint: boolean;
  /**
   * Suppress the advisory overlay AUTHORING lint (FR-023 §11.1 item 4) — the
   * finding that an unflagged cross-file redeclaration works today only
   * because the parser's default merge rule reuses the existing node by
   * (type, resolutionKey); it silently becomes a NEW object the day the
   * target is renamed or removed upstream. Same shape as
   * --no-requirement-lint: mutes the advisory half only, never a gate (this
   * lint has no gate half at all — it can never fail the build).
   */
  noOverlayLint: boolean;
  /**
   * ADR-0023 strict-attr load opt-OUT (#96). `verify` is strict-by-default — an
   * undeclared/typo'd own `@attr` fails verify (ERR_UNKNOWN_ATTR). `--lax`
   * restores the legacy open-attr load (today's behavior). Default false (strict).
   */
  lax: boolean;
  /**
   * How many advisory lines TEXT output prints per printed LIST before truncating
   * (`DEFAULT_ADVISORY_LIMIT`, or Infinity for `--limit all`). Never shared across
   * lists — one shared budget lets the biggest list push every other finding off the
   * end. It never applies to a structured payload, which carries everything.
   *
   * Per LIST, not per section, and the distinction is real rather than pedantic: the
   * anti-pattern tier prints TWO separately-headed lists (the hand-rolling findings and
   * the F52 missing-`baseUrl` findings) while being ONE section everywhere else — one
   * structured list keyed by `rule`, one `--no-antipatterns` muting both. So that
   * section's text output can reach a MULTIPLE of the cap. Deliberate: a project with 200
   * money-float sites would otherwise never see its `baseUrl` advisory, which is the one
   * that silently drops the API prefix from every generated hook, and starving the small
   * list is the worse failure. Pinned in advisory-structured-output.test.ts.
   */
  limit: number;
}

/** The flag table `parseVerifyArgs` parses. Exported so the help text can be gated against it. */
export const VERIFY_OPTIONS = {
  prompts: { type: "string" },
  db: { type: "string" },
  dialect: { type: "string" },
  allow: { type: "string", multiple: true },
  "skip-schema": { type: "boolean", default: false },
  templates: { type: "boolean", default: false },
  codegen: { type: "boolean", default: false },
  docs: { type: "boolean", default: false },
  deps: { type: "boolean", default: false },
  replay: { type: "boolean", default: false },
  "replay-snapshot": { type: "boolean", default: false },
  "no-antipatterns": { type: "boolean", default: false },
  "no-requirement-lint": { type: "boolean", default: false },
  "no-overlay-lint": { type: "boolean", default: false },
  lax: { type: "boolean", default: false },
  "d1": { type: "string" },
  "remote": { type: "boolean", default: false },
  "limit": { type: "string" },
} as const;

/**
 * The `--allow` tokens for one invocation, from EVERY occurrence of the flag.
 *
 * `--allow` is comma-separated, and repeating it is the natural reading (it is what
 * `--server` does). It used to take the LAST occurrence only, so
 * `--allow drop-fk --allow drop-view` silently discarded `drop-fk` and then printed
 * "re-run with --allow drop-fk to apply" seven times — an instruction the user had just
 * followed. Both spellings, and any mixture of them, now mean the union.
 *
 * Duplicates collapse: asking for the same permission twice is one permission.
 */
function parseAllowTokens(raw: string | string[] | undefined): AllowToken[] {
  const occurrences = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const seen = new Set<string>();
  for (const occurrence of occurrences) {
    for (const tok of occurrence.split(",").map((t) => t.trim()).filter((t) => t.length > 0)) {
      if (!ALLOW_TOKENS.includes(tok as AllowToken)) {
        throw new Error(
          `invalid --allow token '${tok}'; expected one of: ${ALLOW_TOKENS.join(", ")}`,
        );
      }
      seen.add(tok);
    }
  }
  return [...seen] as AllowToken[];
}

export function parseVerifyArgs(argv: string[]): VerifyFlags {
  const { values } = parseArgs({
    args: argv,
    options: VERIFY_OPTIONS,
    strict: true,
    allowPositionals: false,
  });

  const dialect = values.dialect as string | undefined;
  if (dialect !== undefined && !DIALECTS.includes(dialect as Dialect)) {
    throw new Error(`invalid --dialect '${dialect}'; expected: ${DIALECTS.join(", ")}`);
  }

  const allowTokens = parseAllowTokens(values.allow as string | string[] | undefined);

  const templates = !!values.templates;
  const codegen = !!values.codegen;
  const docs = !!values.docs;
  const deps = !!values.deps;
  const replay = !!values.replay;
  const replaySnapshot = !!values["replay-snapshot"];
  // --db is itself an explicit subverb selector: passing a connection URL means
  // "run the schema-drift mode". So is `--dialect d1` (D1 has no --db connection
  // URL — see the `d1` field doc above). The replay flags are subverbs too, and
  // must be listed here or `meta verify --replay` would ALSO run the template gate
  // as the bare-verify default. --deps joins the same list for the same reason —
  // it must NOT also be part of that default (see the VerifyFlags doc on `deps`).
  const anyExplicit =
    templates || codegen || docs || deps || values.db !== undefined || dialect === "d1" || replay || replaySnapshot;

  return {
    prompts: values.prompts,
    db: values.db as string | undefined,
    dialect: dialect as Dialect | undefined,
    allow: allowTokens as AllowToken[],
    skipSchema: !!values["skip-schema"],
    templates,
    codegen,
    docs,
    deps,
    replay,
    replaySnapshot,
    anyExplicit,
    noAntipatterns: !!values["no-antipatterns"],
    noRequirementLint: !!values["no-requirement-lint"],
    noOverlayLint: !!values["no-overlay-lint"],
    lax: !!values.lax,
    d1: values.d1 as string | undefined,
    remote: !!values.remote,
    // Throws on a bad value; the command layer reports it and exits 2, exactly as
    // it does for --dialect and --allow above.
    limit: parseAdvisoryLimit(values.limit as string | undefined),
  };
}

// ---------------------------------------------------------------------------
// prompt-snapshot flags
// ---------------------------------------------------------------------------

export interface PromptSnapshotFlags {
  /** Compare against committed snapshots and fail on drift; never write. */
  check: boolean;
  /** Directory (relative to cwd) holding provider-resolved template text. */
  prompts: string | undefined;
}

/** The flag table `parsePromptSnapshotArgs` parses. Exported so the help text can be gated against it. */
export const PROMPT_SNAPSHOT_OPTIONS = {
  check: { type: "boolean", default: false },
  prompts: { type: "string" },
} as const;

export function parsePromptSnapshotArgs(argv: string[]): PromptSnapshotFlags {
  const { values } = parseArgs({
    args: argv,
    options: PROMPT_SNAPSHOT_OPTIONS,
    strict: true,
    allowPositionals: false,
  });
  return {
    check: !!values.check,
    prompts: values.prompts,
  };
}

// ---------------------------------------------------------------------------
// migrate flags
// ---------------------------------------------------------------------------

const ON_AMBIGUOUS = ["abort", "rename", "drop-add"] as const;
type OnAmbiguous = (typeof ON_AMBIGUOUS)[number];

export interface MigrateFlags {
  db: string | undefined;
  dialect: Dialect | undefined;
  /** Output-format adapter (#192); undefined means "not specified on the CLI". */
  format: MigrateFormat | undefined;
  outDir: string | undefined;
  slug: string | undefined;
  allow: AllowToken[];
  onAmbiguous: OnAmbiguous | undefined;
  dryRun: boolean;
  // D1-specific:
  d1Binding: string | undefined;
  remote: boolean;
  apply: boolean;
  /**
   * Roll back all applied migrations NEWER than this target (the target itself
   * is retained), running each migration's down.sql in reverse order. Mutually
   * exclusive with --apply. postgres/sqlite only (not d1).
   */
  rollback: string | undefined;
  yes: boolean;
  /** Use live-DB introspection instead of the committed snapshot (legacy/adoption). */
  fromDb: boolean;
  /** `migrate baseline` subcommand: seed the snapshot, emit no migration. */
  baseline: boolean;
  /** `migrate apply-pending` subcommand: replay committed migration files, no diff. */
  applyPending: boolean;
}

/** The flag table `parseMigrateArgs` parses. Exported so the help text can be gated against it. */
export const MIGRATE_OPTIONS = {
  "db": { type: "string" },
  "dialect": { type: "string" },
  "migration-format": { type: "string" },
  "out-dir": { type: "string" },
  "slug": { type: "string" },
  "allow": { type: "string", multiple: true },
  "on-ambiguous": { type: "string" },
  "dry-run": { type: "boolean", default: false },
  "from-db": { type: "boolean", default: false },
  "d1": { type: "string" },
  "remote": { type: "boolean", default: false },
  "apply": { type: "boolean", default: false },
  "rollback": { type: "string" },
  "yes": { type: "boolean", default: false },
} as const;

export function parseMigrateArgs(argv: string[]): MigrateFlags {
  const { values, positionals } = parseArgs({
    args: argv,
    options: MIGRATE_OPTIONS,
    strict: true,
    allowPositionals: true,
  });

  const baseline = positionals[0] === "baseline";
  const applyPending = positionals[0] === "apply-pending";
  if (positionals.length > 0 && !baseline && !applyPending) {
    throw new Error(`unknown migrate subcommand '${positionals[0]}'; expected 'baseline', 'apply-pending', or no subcommand`);
  }

  if (values.rollback !== undefined && values.apply === true) {
    throw new Error(`--rollback and --apply are mutually exclusive`);
  }

  const dialect = values.dialect as string | undefined;
  if (dialect !== undefined && !DIALECTS.includes(dialect as Dialect)) {
    throw new Error(`invalid --dialect '${dialect}'; expected: ${DIALECTS.join(", ")}`);
  }

  // NOTE: the flag is --migration-format, not --format: `--format` is already a
  // GLOBAL cli flag selecting output rendering (toon|json|text), consumed in index.ts.
  const format = values["migration-format"] as string | undefined;
  if (format !== undefined && !MIGRATE_FORMATS.includes(format as MigrateFormat)) {
    throw new Error(`invalid --migration-format '${format}'; expected: ${MIGRATE_FORMATS.join(", ")}`);
  }

  const onAmb = values["on-ambiguous"] as string | undefined;
  if (onAmb !== undefined && !ON_AMBIGUOUS.includes(onAmb as OnAmbiguous)) {
    throw new Error(`invalid --on-ambiguous '${onAmb}'; expected: ${ON_AMBIGUOUS.join(", ")}`);
  }

  const allowTokens = parseAllowTokens(values.allow as string | string[] | undefined);

  return {
    db: values.db as string | undefined,
    dialect: dialect as Dialect | undefined,
    format: format as MigrateFormat | undefined,
    outDir: values["out-dir"] as string | undefined,
    slug: values.slug as string | undefined,
    allow: allowTokens as AllowToken[],
    onAmbiguous: onAmb as OnAmbiguous | undefined,
    dryRun: !!values["dry-run"],
    d1Binding: values.d1 as string | undefined,
    remote: !!values.remote,
    apply: !!values.apply,
    rollback: values.rollback as string | undefined,
    yes: !!values.yes,
    fromDb: !!values["from-db"],
    baseline,
    applyPending,
  };
}

// ---------------------------------------------------------------------------
// eject flags — FR-040 §4.2(a)
// ---------------------------------------------------------------------------

export interface EjectFlags {
  /** The generator name to eject; undefined when only --list was given. */
  name: string | undefined;
  list: boolean;
  /** Overwrite an already-ejected file; default false — eject never clobbers. */
  force: boolean;
}

/** The flag table `parseEjectArgs` parses. Exported so the help text can be gated against it. */
export const EJECT_OPTIONS = {
  "list": { type: "boolean", default: false },
  "force": { type: "boolean", default: false },
} as const;

export function parseEjectArgs(argv: string[]): EjectFlags {
  const { values, positionals } = parseArgs({
    args: argv,
    options: EJECT_OPTIONS,
    strict: true,
    allowPositionals: true,
  });

  if (positionals.length > 1) {
    throw new Error(`meta eject takes at most one generator name; got: ${positionals.join(", ")}`);
  }

  return {
    name: positionals[0],
    list: !!values.list,
    force: !!values.force,
  };
}

// ---------------------------------------------------------------------------
// deps flags — FR-023 Phase 1a Task 14
// ---------------------------------------------------------------------------

/** `meta deps`'s subcommand. `sync` and `list` are this task's; `check` is
 *  parsed (so the grammar and its usage errors are stable now) but not yet
 *  implemented — Task 15 wires its behavior. */
export type DepsSubverb = "sync" | "check" | "list";

const DEPS_SUBVERBS: readonly DepsSubverb[] = ["sync", "check", "list"];

export interface DepsFlags {
  subverb: DepsSubverb;
  /** Dependency names to narrow to — `sync`'s `[<name>…]`. Empty means "all
   *  declared dependencies." Accepted (and ignored) by every subverb rather
   *  than rejected outright: the positional grammar is one shape for all
   *  three, and only `sync` gives the list meaning today. */
  names: string[];
  /** `sync` only: plan and report, write nothing. */
  dryRun: boolean;
}

/** The flag table `parseDepsArgs` parses. Exported so the help text can be
 *  gated against it. Deliberately carries no "format" key: `--format` is a
 *  GLOBAL flag `index.ts` strips from argv before any command's parser ever
 *  runs (see `MIGRATE_OPTIONS`'s "--migration-format, not --format" note
 *  above) — `meta deps` becomes format-aware by index.ts adding "deps" to
 *  `FORMAT_AWARE_COMMANDS` and passing the resolved `fmt` through, exactly as
 *  gen/verify/migrate do, not by re-declaring the flag here. */
export const DEPS_OPTIONS = {
  "dry-run": { type: "boolean", default: false },
} as const;

export function parseDepsArgs(argv: string[]): DepsFlags {
  const { values, positionals } = parseArgs({
    args: argv,
    options: DEPS_OPTIONS,
    strict: true,
    allowPositionals: true,
  });

  const [subverbRaw, ...names] = positionals;
  if (subverbRaw === undefined) {
    throw new Error(
      "meta deps requires a subcommand: sync | check | list. Try `meta deps sync`.",
    );
  }
  if (!DEPS_SUBVERBS.includes(subverbRaw as DepsSubverb)) {
    throw new Error(
      `meta deps: unknown subcommand "${subverbRaw}"; expected one of: ${DEPS_SUBVERBS.join(", ")}.`,
    );
  }

  return {
    subverb: subverbRaw as DepsSubverb,
    names,
    dryRun: !!values["dry-run"],
  };
}
