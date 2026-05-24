import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// init flags
// ---------------------------------------------------------------------------

export interface InitFlags {
  force: boolean;
  quiet: boolean;
  printOnly: boolean;
  refreshDocs: boolean;
}

export function parseInitArgs(argv: string[]): InitFlags {
  const { values } = parseArgs({
    args: argv,
    options: {
      force: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      "print-only": { type: "boolean", default: false },
      "refresh-docs": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    force: !!values.force,
    quiet: !!values.quiet,
    printOnly: !!values["print-only"],
    refreshDocs: !!values["refresh-docs"],
  };
}

// ---------------------------------------------------------------------------
// gen flags — minimal: metaobjects.config.ts holds outDir/dialect/dbImport/extStyle
// ---------------------------------------------------------------------------

export interface GenFlags {
  dryRun: boolean;
  entities: string[];
}

export function parseGenArgs(argv: string[]): GenFlags {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "dry-run": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });
  return {
    dryRun: !!values["dry-run"],
    entities: positionals,
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
// verify flags
// ---------------------------------------------------------------------------

export interface VerifyFlags {
  /** Directory (relative to cwd) holding provider-resolved template text. */
  prompts: string | undefined;
}

export function parseVerifyArgs(argv: string[]): VerifyFlags {
  const { values } = parseArgs({
    args: argv,
    options: {
      prompts: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    prompts: values.prompts,
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

const DIALECTS = ["sqlite", "postgres", "d1"] as const;
type Dialect = (typeof DIALECTS)[number];

const ALLOW_TOKENS = [
  "drop-column",
  "drop-table",
  "type-change",
  "drop-index",
  "drop-fk",
  "nullable-to-not-null",
] as const;
type AllowToken = (typeof ALLOW_TOKENS)[number];

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
  yes: boolean;
}

export function parseMigrateArgs(argv: string[]): MigrateFlags {
  const { values } = parseArgs({
    args: argv,
    options: {
      "db": { type: "string" },
      "dialect": { type: "string" },
      "out-dir": { type: "string" },
      "slug": { type: "string" },
      "allow": { type: "string" },
      "on-ambiguous": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "d1": { type: "string" },
      "remote": { type: "boolean", default: false },
      "apply": { type: "boolean", default: false },
      "yes": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

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
    yes: !!values.yes,
  };
}
