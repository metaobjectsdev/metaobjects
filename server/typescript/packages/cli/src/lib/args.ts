import { parseArgs } from "node:util";

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
}

export function parseInitArgs(argv: string[]): InitFlags {
  const { values } = parseArgs({
    args: argv,
    options: {
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
    },
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

export function parseAgentDocsArgs(argv: string[]): AgentDocsFlags {
  const { values } = parseArgs({
    args: argv,
    options: {
      server: { type: "string", multiple: true },
      client: { type: "string", multiple: true },
      out: { type: "string" },
      "no-skills": { type: "boolean", default: false },
      "no-wire-root": { type: "boolean", default: false },
    },
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
  /** First-time-on-existing-file behavior. Default: write-if-different
   *  (existing content becomes the canonical baseline). "fresh" → overwrite
   *  and re-baseline. */
  baseline: "default" | "fresh";
  /** ADR-0021 D3 — print the stable-name generator registry and exit without
   *  running codegen. */
  list: boolean;
  /** Suppress the advisory anti-pattern (verify-as-teacher) pass. */
  noAntipatterns: boolean;
}

export function parseGenArgs(argv: string[]): GenFlags {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "dry-run": { type: "boolean", default: false },
      "baseline": { type: "string" },
      "list": { type: "boolean", default: false },
      "no-antipatterns": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });
  const baselineRaw = values.baseline as string | undefined;
  if (baselineRaw !== undefined && baselineRaw !== "default" && baselineRaw !== "fresh") {
    throw new Error(
      `invalid --baseline '${baselineRaw}'; expected 'default' or 'fresh'`,
    );
  }
  return {
    dryRun: !!values["dry-run"],
    entities: positionals,
    baseline: (baselineRaw as "default" | "fresh" | undefined) ?? "default",
    list: !!values.list,
    noAntipatterns: !!values["no-antipatterns"],
  };
}

// ---------------------------------------------------------------------------
// export flags
// ---------------------------------------------------------------------------

export interface ExportFlags {
  out: string | undefined;
}

export function parseExportArgs(argv: string[]): ExportFlags {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: "string" },
    },
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

const ALLOW_TOKENS = [
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
  /** Run the codegen-drift gate (regenerate-to-temp and diff committed output). */
  codegen: boolean;
  /** Whether ANY explicit subverb flag (--templates/--db/--codegen) was passed. */
  anyExplicit: boolean;
  /** Suppress the advisory anti-pattern (verify-as-teacher) pass. */
  noAntipatterns: boolean;
  /**
   * ADR-0023 strict-attr load opt-OUT (#96). `verify` is strict-by-default — an
   * undeclared/typo'd own `@attr` fails verify (ERR_UNKNOWN_ATTR). `--lax`
   * restores the legacy open-attr load (today's behavior). Default false (strict).
   */
  lax: boolean;
}

export function parseVerifyArgs(argv: string[]): VerifyFlags {
  const { values } = parseArgs({
    args: argv,
    options: {
      prompts: { type: "string" },
      db: { type: "string" },
      dialect: { type: "string" },
      allow: { type: "string" },
      "skip-schema": { type: "boolean", default: false },
      templates: { type: "boolean", default: false },
      codegen: { type: "boolean", default: false },
      "no-antipatterns": { type: "boolean", default: false },
      lax: { type: "boolean", default: false },
      "d1": { type: "string" },
      "remote": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  const dialect = values.dialect as string | undefined;
  if (dialect !== undefined && !DIALECTS.includes(dialect as Dialect)) {
    throw new Error(`invalid --dialect '${dialect}'; expected: ${DIALECTS.join(", ")}`);
  }

  const allowRaw = (values.allow as string | undefined) ?? "";
  const allowTokens = allowRaw.length === 0
    ? []
    : allowRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  for (const tok of allowTokens) {
    if (!ALLOW_TOKENS.includes(tok as AllowToken)) {
      throw new Error(
        `invalid --allow token '${tok}'; expected one of: ${ALLOW_TOKENS.join(", ")}`,
      );
    }
  }

  const templates = !!values.templates;
  const codegen = !!values.codegen;
  // --db is itself an explicit subverb selector: passing a connection URL means
  // "run the schema-drift mode". So is `--dialect d1` (D1 has no --db connection
  // URL — see the `d1` field doc above). So "any explicit subverb" is
  // templates|codegen|db|dialect==d1.
  const anyExplicit = templates || codegen || values.db !== undefined || dialect === "d1";

  return {
    prompts: values.prompts,
    db: values.db as string | undefined,
    dialect: dialect as Dialect | undefined,
    allow: allowTokens as AllowToken[],
    skipSchema: !!values["skip-schema"],
    templates,
    codegen,
    anyExplicit,
    noAntipatterns: !!values["no-antipatterns"],
    lax: !!values.lax,
    d1: values.d1 as string | undefined,
    remote: !!values.remote,
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

export function parsePromptSnapshotArgs(argv: string[]): PromptSnapshotFlags {
  const { values } = parseArgs({
    args: argv,
    options: {
      check: { type: "boolean", default: false },
      prompts: { type: "string" },
    },
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

export function parseMigrateArgs(argv: string[]): MigrateFlags {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "db": { type: "string" },
      "dialect": { type: "string" },
      "out-dir": { type: "string" },
      "slug": { type: "string" },
      "allow": { type: "string" },
      "on-ambiguous": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "from-db": { type: "boolean", default: false },
      "d1": { type: "string" },
      "remote": { type: "boolean", default: false },
      "apply": { type: "boolean", default: false },
      "rollback": { type: "string" },
      "yes": { type: "boolean", default: false },
    },
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

  const onAmb = values["on-ambiguous"] as string | undefined;
  if (onAmb !== undefined && !ON_AMBIGUOUS.includes(onAmb as OnAmbiguous)) {
    throw new Error(`invalid --on-ambiguous '${onAmb}'; expected: ${ON_AMBIGUOUS.join(", ")}`);
  }

  const allowRaw = (values.allow as string | undefined) ?? "";
  const allowTokens = allowRaw.length === 0
    ? []
    : allowRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  for (const tok of allowTokens) {
    if (!ALLOW_TOKENS.includes(tok as AllowToken)) {
      throw new Error(
        `invalid --allow token '${tok}'; expected one of: ${ALLOW_TOKENS.join(", ")}`,
      );
    }
  }

  return {
    db: values.db as string | undefined,
    dialect: dialect as Dialect | undefined,
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
